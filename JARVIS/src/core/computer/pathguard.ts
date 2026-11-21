import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export class AccessError extends Error {}

const SENSITIVE_NAMES: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore)$/i,
  /^(credentials?|secrets?)(\..*)?$/i,
  /^\.(npmrc|netrc|git-credentials|pgpass)$/i,
  /^(jarvis\.db(-wal|-shm)?|secrets\.bin\.json)$/i,
  /^(ntuser\.dat.*|sam|security|system)$/i,
];
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

/** Чувствительный файл/каталог: чтение и запись ассистенту запрещены даже внутри разрешённой папки. */
export function isSensitivePath(p: string): boolean {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.some((x) => SENSITIVE_DIRS.has(x.toLowerCase()))) return true;
  return SENSITIVE_NAMES.some((re) => re.test(basename(p)));
}

/** Системные папки Windows/Unix, которые нельзя выдавать как «рабочие». */
const FORBIDDEN_ROOT_PREFIXES_WIN = ['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information'];
const FORBIDDEN_ROOT_PREFIXES_UNIX = ['/etc', '/bin', '/sbin', '/usr', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/var', '/root', '/opt', '/run', '/srv', '/snap'];

const sameOrInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export interface FolderCtx {
  /** Каталог данных JARVIS (БД, секреты) — всегда запрещён. */
  dataDir: string;
  home: string;
}

/**
 * Можно ли разрешить эту папку как рабочую. Запрещены: корни дисков, системные каталоги,
 * профиль пользователя целиком, AppData и всё, что содержит данные JARVIS.
 */
export function validateAllowedFolder(input: string, ctx: FolderCtx): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new AccessError('Некорректный путь');
  const abs = resolve(input);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new AccessError('Папка не найдена');
  const real = realpathSync(abs);
  if (parse(real).root === real) throw new AccessError('Нельзя разрешить корень диска целиком — выберите конкретную папку');
  const lower = real.toLowerCase().replace(/\\/g, '/');
  const noDrive = lower.replace(/^[a-z]:/, '');
  const first = noDrive.split('/').filter(Boolean)[0] ?? '';
  if (sep === '\\' && FORBIDDEN_ROOT_PREFIXES_WIN.includes(first)) throw new AccessError('Системную папку разрешить нельзя');
  if (sep === '/' && FORBIDDEN_ROOT_PREFIXES_UNIX.some((p) => noDrive === p || noDrive.startsWith(p + '/'))) {
    throw new AccessError('Системную папку разрешить нельзя');
  }
  const home = existsSync(ctx.home) ? realpathSync(ctx.home) : ctx.home;
  if (real === home) throw new AccessError('Нельзя разрешить всю папку пользователя — выберите вложенную папку (например, «Документы\\Джарвис»)');
  if (/(^|\/)appdata(\/|$)/i.test(lower)) throw new AccessError('Папку AppData разрешить нельзя');
  const data = existsSync(ctx.dataDir) ? realpathSync(ctx.dataDir) : ctx.dataDir;
  if (sameOrInside(real, data) || sameOrInside(data, real)) throw new AccessError('Эта папка содержит данные JARVIS — разрешить её нельзя');
  if (isSensitivePath(real)) throw new AccessError('Эту папку разрешить нельзя');
  return real;
}

export interface ResolveOpts {
  /** Для создания: целевой путь может не существовать, проверяется ближайший существующий родитель. */
  allowMissing?: boolean;
}

/**
 * Приводит путь от модели к настоящему пути внутри одной из разрешённых папок.
 * Защита от `..`, символических ссылок, чужих дисков, чувствительных файлов.
 */
export function resolveAllowed(input: unknown, roots: string[], opts: ResolveOpts = {}): { abs: string; root: string } {
  if (typeof input !== 'string' || !input.trim() || input.length > 1000 || input.includes('\0')) throw new AccessError('Некорректный путь');
  if (roots.length === 0) throw new AccessError('Нет разрешённых папок. Добавьте папку в «Настройки → Доступ к компьютеру».');
  if (/^[\\/]{2}/.test(input)) throw new AccessError('Сетевые пути запрещены');
  // Альтернативные потоки NTFS (file.txt:stream) и устройства Windows
  if (/^[a-z]:/i.test(input) ? input.slice(2).includes(':') : input.includes(':')) throw new AccessError('Недопустимый символ «:» в пути');
  if (/(^|[\\/])(con|prn|aux|nul|com\d|lpt\d)(\.|[\\/]|$)/i.test(input)) throw new AccessError('Недопустимое имя в пути');

  const candidate = isAbsolute(input) ? resolve(input) : resolve(roots[0]!, input);
  let real: string;
  if (existsSync(candidate)) {
    real = realpathSync(candidate);
  } else if (opts.allowMissing) {
    let dir = dirname(candidate);
    const tail = [basename(candidate)];
    while (!existsSync(dir)) {
      tail.unshift(basename(dir));
      const up = dirname(dir);
      if (up === dir) throw new AccessError('Путь не найден');
      dir = up;
    }
    real = join(realpathSync(dir), ...tail);
  } else {
    throw new AccessError('Путь не найден');
  }
  const root = roots.find((r) => sameOrInside(r, real));
  if (!root) throw new AccessError('Путь вне разрешённых папок. Разрешённые: ' + roots.join('; '));
  if (isSensitivePath(real)) throw new AccessError('Доступ к этому файлу запрещён (секреты и ключи недоступны ассистенту)');
  return { abs: real, root };
}
