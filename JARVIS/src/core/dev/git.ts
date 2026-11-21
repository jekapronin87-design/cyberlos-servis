import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerAccessRepo } from '../computer/access';
import { AccessError, isSensitivePath, resolveAllowed } from '../computer/pathguard';
import type { ToolRegistry } from '../tools/registry';
import { formatRun, runProcess, scrubbedEnv } from './process';

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,60}$/;

let emptyHooks: string | null = null;

/**
 * Git с отключёнными «исполняемыми» настройками репозитория: хуки, fsmonitor, внешний diff, редактор.
 * Вредоносный репозиторий иначе мог бы выполнить код при обычном `git status`.
 */
function gitArgs(args: string[]): string[] {
  emptyHooks ??= mkdtempSync(join(tmpdir(), 'jarvis-nohooks-'));
  return [
    '-c', `core.hooksPath=${emptyHooks}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.editor=true',
    '-c', 'core.pager=cat',
    '-c', 'core.quotepath=false',
    '-c', 'diff.external=',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.file.allow=user',
    ...args,
  ];
}

export function registerGitTools(registry: ToolRegistry, access: ComputerAccessRepo): void {
  const roots = (): string[] => access.get().folders;
  const repo = (p: unknown, needGit = true): string => {
    try {
      const { abs } = resolveAllowed(p, roots());
      if (!statSync(abs).isDirectory()) throw new Error('Это не папка');
      if (needGit && !existsSync(join(abs, '.git'))) throw new Error('Это не Git-репозиторий (сначала git_init)');
      return abs;
    } catch (e) {
      if (e instanceof AccessError) throw new Error(e.message);
      throw e;
    }
  };
  const git = (cwd: string, args: string[], signal: AbortSignal, timeoutMs = 60_000, max = 30_000) =>
    runProcess({
      cmd: 'git',
      args: gitArgs(args),
      cwd,
      env: scrubbedEnv(process.env, { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' }),
      timeoutMs,
      maxOutput: max,
      signal,
    });
  const out = async (cwd: string, args: string[], signal: AbortSignal): Promise<string> => {
    const r = await git(cwd, args, signal);
    if (r.code !== 0) throw new Error(formatRun(r, `git ${args[0]}`));
    return r.output.trim();
  };

  const roRepoTool = (name: string, description: string, args: (i: Record<string, unknown>) => string[], extra: Record<string, unknown> = {}): void => {
    registry.register<{ path: string; staged?: boolean }>({
      name,
      description,
      risk: 'safe',
      mutates: false,
      domain: 'local',
      external: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Папка репозитория' }, ...extra }, required: ['path'] },
      describe: (i) => `${name} в ${i.path}`,
      execute: async (i, ctx) => (await out(repo(i.path), args(i as Record<string, unknown>), ctx.signal)) || '(пусто)',
    });
  };
  roRepoTool('git_status', 'Состояние репозитория: ветка и изменённые файлы.', () => ['status', '--short', '--branch']);
  roRepoTool('git_diff', 'Показывает изменения в рабочей папке (или в индексе при staged=true).', (i) => ['diff', '--no-color', '--no-ext-diff', ...(i.staged ? ['--staged'] : [])], {
    staged: { type: 'boolean' },
  });
  roRepoTool('git_log', 'Последние 15 коммитов.', () => ['log', '--oneline', '--decorate', '-n', '15']);

  registry.register<{ path: string }>({
    name: 'git_init',
    description: 'Создаёт Git-репозиторий (ветка main) в папке проекта.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (i) => `Создать Git-репозиторий в ${i.path}`,
    execute: async (i, ctx) => {
      const dir = repo(i.path, false);
      if (existsSync(join(dir, '.git'))) return 'Репозиторий уже существует.';
      return (await out(dir, ['init', '-b', 'main'], ctx.signal)) || 'Репозиторий создан.';
    },
  });

  registry.register<{ path: string; name: string }>({
    name: 'git_branch',
    description: 'Создаёт новую ветку и переключается на неё (например, feature/login).',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path', 'name'] },
    describe: (i) => `Создать ветку «${i.name}» и переключиться на неё в ${i.path}`,
    execute: async (i, ctx) => {
      if (!BRANCH_RE.test(String(i.name))) throw new Error('Недопустимое имя ветки');
      return (await out(repo(i.path), ['switch', '-c', String(i.name)], ctx.signal)) || `Ветка ${i.name} создана.`;
    },
  });

  registry.register<{ path: string; message: string }>({
    name: 'git_commit',
    description:
      'Добавляет ВСЕ изменения и создаёт коммит с сообщением. Откажет, если среди изменений есть секреты (.env, ключи) — их нужно внести в .gitignore. ' +
      'Хуки Git отключены. Нужны настроенные user.name и user.email.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string', description: 'Сообщение коммита, до 200 символов' } }, required: ['path', 'message'] },
    describe: (i) => `Закоммитить все изменения в ${i.path} с сообщением «${String(i.message).slice(0, 120)}»`,
    execute: async (i, ctx) => {
      const dir = repo(i.path);
      const msg = String(i.message).trim();
      if (!msg || msg.length > 200 || msg.startsWith('-') || msg.includes('\0')) throw new Error('Сообщение коммита: 1–200 символов, без «-» в начале');
      const status = await out(dir, ['status', '--porcelain', '-uall'], ctx.signal);
      if (!status) return 'Нечего коммитить: изменений нет.';
      const risky = status
        .split('\n')
        .map((l) => l.slice(3).replace(/^"|"$/g, ''))
        .filter((f) => isSensitivePath(f));
      if (risky.length) throw new Error(`Коммит остановлен: среди изменений секретные файлы (${risky.slice(0, 5).join(', ')}). Добавьте их в .gitignore.`);
      await out(dir, ['add', '-A'], ctx.signal);
      const r = await git(dir, ['commit', '--no-verify', '-m', msg], ctx.signal);
      if (r.code !== 0) {
        const hint = /user\.(name|email)|identity|tell me who you are/i.test(r.output) ? '\nУкажите имя и почту: git config --global user.name "Имя"; git config --global user.email "почта" (в обычной командной строке).' : '';
        throw new Error(formatRun(r, 'git commit') + hint);
      }
      return r.output.trim();
    },
  });

  registry.register<{ path: string }>({
    name: 'git_push',
    description: 'Отправляет текущую ветку на сервер (origin). Без force. Опасно: код покидает компьютер — всегда требует подтверждения.',
    risk: 'high',
    mutates: true,
    domain: 'local',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    describe: (i) => `ОТПРАВИТЬ текущую ветку репозитория ${i.path} на сервер origin (код покинет этот компьютер)`,
    execute: async (i, ctx) => {
      const dir = repo(i.path);
      const branch = await out(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.signal);
      if (!BRANCH_RE.test(branch) || branch === 'HEAD') throw new Error('Не удалось определить текущую ветку');
      const r = await git(dir, ['push', '-u', 'origin', branch], ctx.signal, 120_000);
      if (r.code !== 0) throw new Error(formatRun(r, 'git push'));
      return formatRun(r, 'git push');
    },
  });
}
