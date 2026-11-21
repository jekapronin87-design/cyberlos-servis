import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  truncated: boolean;
  ms: number;
}

/** Переменные окружения, которые можно передать процессам проекта. Ключи API и токены — НЕ передаются. */
const ENV_PASS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LC_ALL', 'TERM', 'USER', 'USERNAME', 'SHELL',
];
const ENV_PASS_PREFIX = ['GIT_AUTHOR_', 'GIT_COMMITTER_'];

export function scrubbedEnv(src: Record<string, string | undefined> = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (ENV_PASS.includes(k) || ENV_PASS_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return { ...out, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...extra };
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL'); // отдельная группа процессов
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* уже завершён */
    }
  }
}

export interface RunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutput?: number;
  signal?: AbortSignal;
}

/**
 * Запуск процесса БЕЗ оболочки: без stdin, с таймаутом, лимитом вывода и убийством всего дерева процессов
 * по таймауту или кнопке «Стоп». Окружение очищено от секретов.
 */
export function runProcess(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = o.maxOutput ?? 60_000;
  const timeoutMs = o.timeoutMs ?? 180_000;
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let done = false;
    const child = spawn(o.cmd, o.args, {
      cwd: o.cwd,
      env: o.env ?? scrubbedEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const append = (b: Buffer): void => {
      output += b.toString('utf8');
      if (output.length > max * 2) {
        output = output.slice(-max); // оставляем хвост — там обычно итог и ошибки
        truncated = true;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (code: number | null, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (output.length > max) {
        output = output.slice(-max);
        truncated = true;
      }
      resolve({ code, timedOut, aborted, output: (extra ? extra + '\n' : '') + output, truncated, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    if (o.signal?.aborted) onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e) => finish(null, `Не удалось запустить «${o.cmd}»: ${e.message}`));
    child.once('close', (code) => finish(code));
  });
}

export function formatRun(r: RunResult, label: string): string {
  const head = r.timedOut ? `⏱ ${label}: превышено время ожидания, процесс остановлен` : r.aborted ? `${label}: остановлено пользователем` : `${label}: код выхода ${r.code} (${(r.ms / 1000).toFixed(1)} с)`;
  return `${head}${r.truncated ? '\n[вывод обрезан, показан конец]' : ''}\n\n${r.output.trim() || '(вывод пуст)'}`;
}

/**
 * Находит npm-cli.js рядом с установленным Node.js. Запускаем его через `node`, а не `npm.cmd`:
 * Windows запрещает запуск .cmd без оболочки (а оболочку мы не используем).
 */
export function findNpmCli(env: Record<string, string | undefined> = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const cands = [
      join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows: рядом с node.exe
      ...(existsSync(join(d, 'npm')) ? [join(dirname(realpathSync(join(d, 'npm'))), 'npm-cli.js')] : []), // Unix: симлинк на npm-cli.js
      join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    for (const c of cands) if (existsSync(c)) return realpathSync(c);
  }
  return null;
}

/** Как запустить Node: в упакованном приложении — сам Electron в режиме Node, иначе текущий процесс. */
export function nodeCommand(): { cmd: string; env: Record<string, string> } {
  return process.versions.electron ? { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } } : { cmd: process.execPath, env: {} };
}
