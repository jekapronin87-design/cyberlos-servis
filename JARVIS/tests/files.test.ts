import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ComputerAccessRepo } from '../src/core/computer/access';
import { isSensitivePath, resolveAllowed, validateAllowedFolder } from '../src/core/computer/pathguard';
import { registerFileTools } from '../src/core/computer/files';
import { openDatabase } from '../src/core/db/database';
import { ToolRegistry } from '../src/core/tools/registry';

const mk = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'jv-fs-')));

describe('защита путей', () => {
  it('пропускает только пути внутри разрешённых папок', () => {
    const root = mk();
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(resolveAllowed(join(root, 'a.txt'), [root]).abs).toBe(join(root, 'a.txt'));
    expect(resolveAllowed('a.txt', [root]).abs).toBe(join(root, 'a.txt')); // относительный — от первой папки
    expect(() => resolveAllowed(join(root, '..', 'x'), [root], { allowMissing: true })).toThrow(/вне разрешённых/);
    expect(() => resolveAllowed('/etc/passwd', [root])).toThrow();
    expect(() => resolveAllowed(join(root, 'a.txt', '..', '..'), [root])).toThrow();
  });
  it('символическая ссылка наружу не обходит защиту', () => {
    const root = mk();
    const outside = mk();
    writeFileSync(join(outside, 'secret.txt'), 'top');
    symlinkSync(outside, join(root, 'link'));
    expect(() => resolveAllowed(join(root, 'link', 'secret.txt'), [root])).toThrow(/вне разрешённых/);
  });
  it('новые файлы: проверяется ближайший существующий родитель', () => {
    const root = mk();
    const outside = mk();
    symlinkSync(outside, join(root, 'link'));
    expect(() => resolveAllowed(join(root, 'link', 'new.txt'), [root], { allowMissing: true })).toThrow(/вне разрешённых/);
    expect(resolveAllowed(join(root, 'sub', 'deep', 'new.txt'), [root], { allowMissing: true }).abs).toBe(join(root, 'sub', 'deep', 'new.txt'));
  });
  it('отклоняет мусор: пустые, нулевые байты, сетевые, потоки NTFS, устройства', () => {
    const root = mk();
    for (const bad of ['', '   ', 'a\0b', '\\\\server\\share\\x', '//server/share/x', 'C:\\x\\file.txt:stream', 'con', join(root, 'nul.txt'), 5, null]) {
      expect(() => resolveAllowed(bad as never, [root], { allowMissing: true })).toThrow();
    }
    expect(() => resolveAllowed('x', [])).toThrow(/Нет разрешённых/);
  });
  it('секреты недоступны даже внутри разрешённой папки', () => {
    const root = mk();
    mkdirSync(join(root, '.ssh'));
    for (const n of ['.env', '.env.local', 'id_rsa', 'cert.pem', 'private.key', 'credentials.json', 'jarvis.db', '.ssh/config', 'secrets.bin.json']) {
      expect(isSensitivePath(join(root, n))).toBe(true);
      expect(() => resolveAllowed(join(root, n), [root], { allowMissing: true })).toThrow(/запрещён/);
    }
    expect(isSensitivePath(join(root, 'report.docx'))).toBe(false);
  });
});

describe('выбор рабочих папок', () => {
  const ctx = (): { dataDir: string; home: string } => ({ dataDir: mk(), home: mk() });
  it('нормальная папка принимается', () => {
    const c = ctx();
    const dir = join(c.home, 'Documents', 'Jarvis');
    mkdirSync(dir, { recursive: true });
    expect(validateAllowedFolder(dir, c)).toBe(dir);
  });
  it('запрещены: корень диска, профиль целиком, системные папки, данные JARVIS и их родители, AppData', () => {
    const c = ctx();
    expect(() => validateAllowedFolder('/', c)).toThrow(/корень/);
    expect(() => validateAllowedFolder(c.home, c)).toThrow(/пользователя/);
    expect(() => validateAllowedFolder('/etc', c)).toThrow(/Системную/);
    expect(() => validateAllowedFolder('/usr/lib', c)).toThrow(/Системную/);
    expect(() => validateAllowedFolder(c.dataDir, c)).toThrow(/данные JARVIS/);
    const parent = mk();
    const nested = { dataDir: join(parent, 'data'), home: mk() };
    mkdirSync(nested.dataDir);
    expect(() => validateAllowedFolder(parent, nested)).toThrow(/данные JARVIS/);
    const app = join(c.home, 'AppData', 'Roaming');
    mkdirSync(app, { recursive: true });
    expect(() => validateAllowedFolder(app, c)).toThrow(/AppData/);
    expect(() => validateAllowedFolder(join(c.home, 'нет'), c)).toThrow(/не найдена/);
  });
});

function setup() {
  const dataDir = mk();
  const home = mk();
  const db = openDatabase(':memory:');
  const access = new ComputerAccessRepo(db, { dataDir, home, platform: 'linux' });
  const root = join(home, 'Work');
  mkdirSync(root);
  access.addFolder(root);
  const trashed: string[] = [];
  const opened: string[] = [];
  const reg = new ToolRegistry();
  registerFileTools(reg, access, {
    trashItem: async (p) => void trashed.push(p),
    openPath: async (p) => (opened.push(p), ''),
  });
  const run = async (name: string, input: Record<string, unknown>): Promise<string> => {
    const out = await reg.get(name)!.execute(input, { conversationId: 1, signal: new AbortController().signal });
    return typeof out === 'string' ? out : out.text;
  };
  return { root, run, reg, trashed, opened, access, dataDir };
}

describe('файловые инструменты', () => {
  it('создать, прочитать, найти, перечислить', async () => {
    const { root, run } = setup();
    expect(await run('fs_write', { path: join(root, 'notes', 'a.txt'), content: 'привет мир' })).toMatch(/Файл создан/);
    expect(readFileSync(join(root, 'notes', 'a.txt'), 'utf8')).toBe('привет мир');
    expect(await run('fs_read', { path: join(root, 'notes', 'a.txt') })).toContain('привет мир');
    expect(await run('fs_list', { path: root })).toContain('[папка] notes');
    expect(await run('fs_search', { path: root, query: 'A.TX' })).toContain('notes');
    expect(await run('fs_search', { path: root, query: 'нет-такого' })).toBe('Ничего не найдено.');
    expect(await run('fs_list_allowed', {})).toContain(root);
  });
  it('fs_write не затирает существующий файл; fs_overwrite — отдельный опасный инструмент', async () => {
    const { root, run, reg } = setup();
    writeFileSync(join(root, 'x.txt'), 'старое');
    await expect(run('fs_write', { path: join(root, 'x.txt'), content: 'новое' })).rejects.toThrow(/уже существует/);
    expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('старое');
    expect(reg.get('fs_overwrite')!.risk).toBe('high');
    await run('fs_overwrite', { path: join(root, 'x.txt'), content: 'новое' });
    expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('новое');
  });
  it('внешние пути и секреты блокируются', async () => {
    const { root, run } = setup();
    writeFileSync(join(root, '.env'), 'KEY=1');
    await expect(run('fs_read', { path: join(root, '.env') })).rejects.toThrow(/запрещён/);
    await expect(run('fs_read', { path: '/etc/hostname' })).rejects.toThrow();
    await expect(run('fs_write', { path: join(root, '..', 'evil.txt'), content: 'x' })).rejects.toThrow(/вне разрешённых/);
    await expect(run('fs_list', { path: join(root, '..') })).rejects.toThrow();
  });
  it('лимиты: большой и бинарный файл не читаются, большой не записывается', async () => {
    const { root, run } = setup();
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(300 * 1024));
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    await expect(run('fs_read', { path: join(root, 'big.txt') })).rejects.toThrow(/слишком большой/);
    await expect(run('fs_read', { path: join(root, 'bin.dat') })).rejects.toThrow(/бинарный/);
    await expect(run('fs_write', { path: join(root, 'huge.txt'), content: 'a'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/большой/);
  });
  it('перемещение: без перезаписи и без выхода наружу; саму папку трогать нельзя', async () => {
    const { root, run } = setup();
    writeFileSync(join(root, 'a.txt'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
    await expect(run('fs_move', { from: join(root, 'a.txt'), to: join(root, 'b.txt') })).rejects.toThrow(/уже существует/);
    await expect(run('fs_move', { from: join(root, 'a.txt'), to: join(root, '..', 'a.txt') })).rejects.toThrow(/вне разрешённых/);
    await expect(run('fs_move', { from: root, to: join(root, 'x') })).rejects.toThrow(/саму разрешённую/);
    await run('fs_move', { from: join(root, 'a.txt'), to: join(root, 'sub', 'c.txt') });
    expect(existsSync(join(root, 'sub', 'c.txt'))).toBe(true);
  });
  it('удаление — только в Корзину, и не корня', async () => {
    const { root, run, trashed } = setup();
    writeFileSync(join(root, 'a.txt'), 'a');
    await run('fs_delete', { path: join(root, 'a.txt') });
    expect(trashed).toEqual([join(root, 'a.txt')]);
    await expect(run('fs_delete', { path: root })).rejects.toThrow(/саму разрешённую/);
  });
  it('открытие: исполняемые и скриптовые файлы запрещены', async () => {
    const { root, run, opened } = setup();
    for (const n of ['a.exe', 'b.bat', 'c.ps1', 'd.vbs', 'e.lnk', 'f.js']) writeFileSync(join(root, n), 'x');
    writeFileSync(join(root, 'ok.txt'), 'x');
    for (const n of ['a.exe', 'b.bat', 'c.ps1', 'd.vbs', 'e.lnk', 'f.js']) {
      await expect(run('fs_open', { path: join(root, n) })).rejects.toThrow(/запрещён/);
    }
    await run('fs_open', { path: join(root, 'ok.txt') });
    expect(opened).toEqual([join(root, 'ok.txt')]);
  });
  it('уровни риска инструментов', () => {
    const { reg } = setup();
    const risks = Object.fromEntries(reg.list().map((t) => [t.name, t.risk]));
    expect(risks).toMatchObject({ fs_list: 'safe', fs_read: 'low', fs_write: 'medium', fs_move: 'medium', fs_open: 'medium', fs_overwrite: 'high', fs_delete: 'high' });
  });
});

describe('хранение разрешений', () => {
  it('папки и приложения добавляются отдельными методами, внешние хосты проверяются', () => {
    const { access, root } = setup();
    expect(access.get().folders).toEqual([root]);
    expect(() => access.addBrowserHost('evil host')).toThrow();
    expect(access.addBrowserHost('LocalHost:5173')).toEqual(['localhost:5173']);
    expect(access.removeBrowserHost('localhost:5173')).toEqual([]);
    expect(access.removeFolder(root)).toEqual([]);
    expect(() => access.addApp('relative/path.exe')).toThrow(/полный путь/i);
    expect(() => access.addApp('/nonexistent/app')).toThrow(/не найден/);
  });
});
