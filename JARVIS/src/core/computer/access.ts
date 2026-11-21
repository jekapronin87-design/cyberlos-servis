import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { AllowedApp, ComputerAccess } from '../../shared/types';
import { nowIso, type Db } from '../db/database';
import { AccessError, validateAllowedFolder } from './pathguard';

const KEY = (k: string): string => `computer.${k}`;

/** Встроенные безопасные программы Windows. */
export function builtinApps(env: Record<string, string | undefined> = process.env, platform = process.platform): AllowedApp[] {
  if (platform !== 'win32') return [];
  const sys = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  return [
    { name: 'Блокнот', path: join(sys, 'notepad.exe'), builtin: true },
    { name: 'Калькулятор', path: join(sys, 'calc.exe'), builtin: true },
    { name: 'Paint', path: join(sys, 'mspaint.exe'), builtin: true },
  ];
}

const HOST_RE = /^(localhost|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\d{1,3}(\.\d{1,3}){3})(:\d{1,5})?$/i;

/**
 * Разрешения на доступ к компьютеру. Хранятся отдельно от обычных настроек и меняются
 * только отдельными методами (вызываются после выбора пользователем в окне Windows) —
 * через общий `settings:update` или от имени модели их не изменить.
 */
export class ComputerAccessRepo {
  constructor(
    private db: Db,
    private ctx: { dataDir: string; home?: string; env?: Record<string, string | undefined>; platform?: string },
  ) {}

  private read<T>(key: string, def: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY(key)) as { value: string } | undefined;
    if (!r) return def;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return def;
    }
  }
  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY(key), JSON.stringify(value), nowIso());
  }

  get(): ComputerAccess {
    const folders = this.read<string[]>('folders', []).filter((f) => typeof f === 'string' && existsSync(f));
    const custom = this.read<AllowedApp[]>('apps', []).filter((a) => a && typeof a.name === 'string' && typeof a.path === 'string');
    return {
      folders,
      apps: [...builtinApps(this.ctx.env, this.ctx.platform as NodeJS.Platform), ...custom],
      browserHosts: this.read<string[]>('browserHosts', []),
    };
  }

  addFolder(path: string): string[] {
    const real = validateAllowedFolder(path, { dataDir: this.ctx.dataDir, home: this.ctx.home ?? homedir() });
    const cur = this.read<string[]>('folders', []);
    if (!cur.includes(real)) this.write('folders', [...cur, real]);
    return this.get().folders;
  }

  removeFolder(path: string): string[] {
    this.write('folders', this.read<string[]>('folders', []).filter((f) => f !== path));
    return this.get().folders;
  }

  addApp(path: string, name?: string): AllowedApp[] {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new AccessError('Нужен полный путь к программе');
    const abs = resolve(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new AccessError('Файл программы не найден');
    if (!/\.(exe|lnk)$/i.test(abs) && process.platform === 'win32') throw new AccessError('Разрешены только программы (.exe)');
    const label = (name?.trim() || basename(abs).replace(/\.(exe|lnk)$/i, '')).slice(0, 60);
    const cur = this.read<AllowedApp[]>('apps', []).filter((a) => a.name.toLowerCase() !== label.toLowerCase());
    this.write('apps', [...cur, { name: label, path: abs }]);
    return this.get().apps;
  }

  removeApp(name: string): AllowedApp[] {
    this.write('apps', this.read<AllowedApp[]>('apps', []).filter((a) => a.name !== name));
    return this.get().apps;
  }

  addBrowserHost(host: string): string[] {
    const h = String(host).trim().toLowerCase();
    if (!HOST_RE.test(h) || h.length > 100) throw new AccessError('Некорректный адрес. Пример: localhost:5173');
    const cur = this.read<string[]>('browserHosts', []);
    if (!cur.includes(h)) this.write('browserHosts', [...cur, h]);
    return this.get().browserHosts;
  }

  removeBrowserHost(host: string): string[] {
    this.write('browserHosts', this.read<string[]>('browserHosts', []).filter((h) => h !== host));
    return this.get().browserHosts;
  }
}
