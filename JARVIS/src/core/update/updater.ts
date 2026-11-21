import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync } from 'fflate';
import { findNpmCli, nodeCommand, runProcess, scrubbedEnv, formatRun } from '../dev/process';

export interface UpdateSource {
  owner: string;
  repo: string;
  branch: string;
  /** Папка внутри репозитория, где лежит приложение. */
  subdir: string;
}

export const DEFAULT_SOURCE: UpdateSource = {
  owner: 'jekapronin87-design',
  repo: 'cyberlos-servis',
  branch: 'claude/jarvis-personal-ai-assistant-wbsf6v',
  subdir: 'JARVIS',
};

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;
export const MAX_ZIP_BYTES = 120 * 1024 * 1024;
const MAX_ENTRIES = 8000;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** Эти пути обновление никогда не трогает. */
const PROTECTED = ['node_modules', 'dist', 'release', '.git', '.env', 'jarvis-data'];

export function validateSource(s: UpdateSource): UpdateSource {
  if (!NAME.test(s.owner) || !NAME.test(s.repo) || !BRANCH.test(s.branch) || s.branch.includes('..') || !NAME.test(s.subdir)) {
    throw new Error('Некорректный источник обновлений');
  }
  return s;
}

export interface LatestInfo {
  sha: string;
  message: string;
  date: string;
}

type Fetch = typeof fetch;

/** Последний коммит ветки (публичный репозиторий GitHub, без токена). */
export async function fetchLatest(src: UpdateSource, f: Fetch = fetch, signal?: AbortSignal): Promise<LatestInfo> {
  validateSource(src);
  const url = `https://api.github.com/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(src.branch)}`;
  const res = await f(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JARVIS-updater' }, signal: signal ?? AbortSignal.timeout(20_000) });
  if (res.status === 404) throw new Error('Источник обновлений не найден (репозиторий приватный или ветка удалена).');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub временно ограничил запросы. Попробуйте позже.');
  if (!res.ok) throw new Error(`GitHub вернул ошибку ${res.status}`);
  const j = (await res.json()) as { sha?: string; commit?: { message?: string; committer?: { date?: string } } };
  if (!j.sha || !/^[0-9a-f]{40}$/.test(j.sha)) throw new Error('Неожиданный ответ GitHub');
  return { sha: j.sha, message: (j.commit?.message ?? '').split('\n')[0]!.slice(0, 200), date: j.commit?.committer?.date ?? '' };
}

export async function downloadZip(src: UpdateSource, sha: string, f: Fetch = fetch, signal?: AbortSignal): Promise<Uint8Array> {
  validateSource(src);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Некорректная версия');
  const res = await f(`https://codeload.github.com/${src.owner}/${src.repo}/zip/${sha}`, { headers: { 'User-Agent': 'JARVIS-updater' }, signal: signal ?? AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Не удалось скачать обновление (${res.status})`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_ZIP_BYTES) throw new Error('Архив обновления слишком большой');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_ZIP_BYTES) throw new Error('Архив обновления слишком большой');
  return buf;
}

export interface ExtractResult {
  written: string[];
  skipped: string[];
  packageJsonChanged: boolean;
}

/**
 * Распаковывает архив GitHub поверх каталога установки.
 * Защита: только файлы из <subdir>/, никаких выходов за пределы каталога (zip-slip), защищённые пути не трогаются,
 * лимиты на число и размер файлов. Перед перезаписью старые версии файлов копируются в backupDir.
 */
export function extractUpdate(zip: Uint8Array, installDir: string, src: UpdateSource, backupDir?: string): ExtractResult {
  const files = unzipSync(zip, {
    filter: (f) => f.originalSize <= MAX_FILE_BYTES,
  });
  const names = Object.keys(files);
  if (names.length > MAX_ENTRIES) throw new Error('В архиве слишком много файлов');
  const root = resolve(installDir);
  const written: string[] = [];
  const skipped: string[] = [];
  let packageJsonChanged = false;

  for (const name of names) {
    const data = files[name]!;
    if (name.endsWith('/')) continue;
    // Первый сегмент — «репозиторий-хеш», затем наша папка
    const parts = name.split('/');
    if (parts.length < 3 || parts[1] !== src.subdir) continue;
    const rel = parts.slice(2).join('/');
    if (!rel || rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      skipped.push(name);
      continue;
    }
    const segs = rel.split('/');
    if (segs.some((s) => s === '..' || s === '') || PROTECTED.includes(segs[0]!.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const target = resolve(root, ...segs);
    const relCheck = relative(root, target);
    if (relCheck.startsWith('..') || isAbsolute(relCheck) || !target.startsWith(root + sep)) {
      skipped.push(name);
      continue;
    }
    const prev = existsSync(target) ? readFileSync(target) : null;
    if (prev && Buffer.compare(prev, Buffer.from(data)) === 0) continue; // без изменений
    if (prev && backupDir) {
      const b = join(backupDir, ...segs);
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(target, b);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.push(rel);
    if (rel === 'package.json' || rel === 'package-lock.json') packageJsonChanged = true;
  }
  if (written.length === 0 && skipped.length === 0 && !names.some((n) => n.split('/')[1] === src.subdir)) {
    throw new Error('В архиве не найдена папка приложения — обновление отменено.');
  }
  return { written, skipped, packageJsonChanged };
}

export interface InstalledInfo {
  sha: string;
  at: string;
}

export function readInstalled(dataDir: string): InstalledInfo | null {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, 'installed.json'), 'utf8')) as InstalledInfo;
    return /^[0-9a-f]{40}$/.test(j.sha) ? j : null;
  } catch {
    return null;
  }
}

export function writeInstalled(dataDir: string, sha: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'installed.json'), JSON.stringify({ sha, at: new Date().toISOString() }));
}

/** npm install (при изменении зависимостей) и сборка приложения. */
export async function installAndBuild(installDir: string, packageJsonChanged: boolean, signal?: AbortSignal): Promise<string> {
  const cli = findNpmCli();
  if (!cli) throw new Error('Не найден npm. Установите Node.js (https://nodejs.org).');
  const n = nodeCommand();
  const run = (args: string[], timeoutMs: number) =>
    runProcess({ cmd: n.cmd, args: [cli, ...args], cwd: installDir, env: scrubbedEnv(process.env, n.env), timeoutMs, maxOutput: 20_000, signal });
  const log: string[] = [];
  if (packageJsonChanged || !existsSync(join(installDir, 'node_modules'))) {
    const r = await run(['install', '--no-audit', '--no-fund', '--loglevel=error'], 600_000);
    log.push(formatRun(r, 'npm install'));
    if (r.code !== 0) throw new Error(log.join('\n\n'));
  }
  const b = await run(['run', 'build'], 300_000);
  log.push(formatRun(b, 'npm run build'));
  if (b.code !== 0) throw new Error(log.join('\n\n'));
  return log.join('\n\n');
}

export function makeBackupDir(dataDir: string, sha: string | null): string {
  const d = mkdtempSync(join(dataDir.length ? dataDir : tmpdir(), `update-backup-${(sha ?? 'unknown').slice(0, 7)}-`));
  return d;
}
