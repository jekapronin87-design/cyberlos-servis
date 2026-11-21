import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, extractUpdate, fetchLatest, readInstalled, validateSource } from '../src/core/update/updater';
import { makeCore } from './helpers';

const mk = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'jv-up-')));
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function makeZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

describe('распаковка обновления', () => {
  const src = DEFAULT_SOURCE;
  it('кладёт файлы приложения, не трогает защищённое и не выходит за пределы папки', () => {
    const dir = mk();
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'keep.txt'), 'keep');
    writeFileSync(join(dir, 'src.txt'), 'old');
    const zip = makeZip({
      'repo-abc/README.md': 'вне приложения',
      'repo-abc/JARVIS/package.json': '{"name":"jarvis"}',
      'repo-abc/JARVIS/src/main.ts': 'export {}',
      'repo-abc/JARVIS/node_modules/evil/x.js': 'evil',
      'repo-abc/JARVIS/dist/main.cjs': 'evil',
      'repo-abc/JARVIS/.env': 'KEY=1',
      'repo-abc/JARVIS/../../escape.txt': 'escape',
      'repo-abc/JARVIS/a/../../../escape2.txt': 'escape2',
      'repo-abc/JARVIS/src.txt': 'new',
    });
    const backup = mk();
    const r = extractUpdate(zip, dir, src, backup);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"name":"jarvis"}');
    expect(readFileSync(join(dir, 'src', 'main.ts'), 'utf8')).toBe('export {}');
    expect(readFileSync(join(dir, 'src.txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(backup, 'src.txt'), 'utf8')).toBe('old'); // резервная копия заменённого
    expect(existsSync(join(dir, 'node_modules', 'evil'))).toBe(false);
    expect(readFileSync(join(dir, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'dist'))).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
    expect(existsSync(join(dir, '..', 'escape2.txt'))).toBe(false);
    expect(existsSync(join(dir, 'README.md'))).toBe(false); // за пределами папки приложения
    expect(r.packageJsonChanged).toBe(true);
    expect(r.skipped.length).toBeGreaterThanOrEqual(2);
    expect(readdirSync(mk())).toEqual([]);
  });
  it('архив без папки приложения отклоняется; повторная распаковка без изменений ничего не пишет', () => {
    const dir = mk();
    expect(() => extractUpdate(makeZip({ 'repo/other/x.txt': 'x' }), dir, DEFAULT_SOURCE)).toThrow(/не найдена папка приложения/);
    const zip = makeZip({ 'r/JARVIS/a.txt': 'same' });
    expect(extractUpdate(zip, dir, DEFAULT_SOURCE).written).toEqual(['a.txt']);
    expect(extractUpdate(zip, dir, DEFAULT_SOURCE).written).toEqual([]);
  });
  it('проверка источника', () => {
    expect(() => validateSource({ ...DEFAULT_SOURCE, owner: 'a/b' })).toThrow();
    expect(() => validateSource({ ...DEFAULT_SOURCE, branch: 'x..y' })).toThrow();
    expect(() => validateSource({ ...DEFAULT_SOURCE, repo: 'repo;rm' })).toThrow();
    expect(validateSource(DEFAULT_SOURCE)).toEqual(DEFAULT_SOURCE);
  });
});

describe('GitHub: последняя версия', () => {
  const api = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('читает sha и сообщение; понятные ошибки', async () => {
    const ok = await fetchLatest(DEFAULT_SOURCE, api(200, { sha: SHA, commit: { message: 'Заголовок\n\nописание', committer: { date: '2026-11-21T10:00:00Z' } } }));
    expect(ok).toMatchObject({ sha: SHA, message: 'Заголовок' });
    await expect(fetchLatest(DEFAULT_SOURCE, api(404, {}))).rejects.toThrow(/не найден/);
    await expect(fetchLatest(DEFAULT_SOURCE, api(403, {}))).rejects.toThrow(/ограничил/);
    await expect(fetchLatest(DEFAULT_SOURCE, api(200, { sha: 'not-a-sha' }))).rejects.toThrow(/Неожиданный/);
  });
});

describe('обновление в ядре', () => {
  it('полный цикл: проверка → применение → версия запомнена → повторная проверка «актуально»', async () => {
    const installDir = mk();
    writeFileSync(join(installDir, 'package.json'), '{"name":"jarvis","version":"0"}');
    const zip = makeZip({ 'cyberlos-servis-x/JARVIS/package.json': '{"name":"jarvis","version":"1"}', 'cyberlos-servis-x/JARVIS/src/new.ts': 'export const a = 1;' });
    let latest = SHA;
    const f = (async (url: string) => {
      if (String(url).includes('api.github.com')) return new Response(JSON.stringify({ sha: latest, commit: { message: 'Новая версия', committer: { date: '2026-11-21T10:00:00Z' } } }));
      if (String(url).includes('codeload.github.com')) return new Response(zip as BodyInit);
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const h = makeCore({ installDir, updateFetch: f, skipBuild: true });
    const before = await h.core.checkUpdate();
    expect(before).toMatchObject({ canUpdate: true, installedSha: null, upToDate: null });
    const steps: string[] = [];
    const res = await h.core.applyUpdate((p) => steps.push(p.step));
    expect(res).toEqual({ sha: SHA, files: 2 });
    expect(steps).toEqual(['check', 'download', 'extract', 'install', 'done'].filter((s) => s !== 'install'));
    expect(readFileSync(join(installDir, 'src', 'new.ts'), 'utf8')).toContain('export const a');
    expect(readInstalled(h.dir)?.sha).toBe(SHA);
    expect((await h.core.checkUpdate()).upToDate).toBe(true);
    latest = SHA2;
    expect((await h.core.checkUpdate()).upToDate).toBe(false);
    expect(h.core.listAudit().some((a) => a.action === 'update.applied' && a.risk === 'high')).toBe(true);
  });
  it('без каталога установки (упакованная версия) обновление недоступно', async () => {
    const h = makeCore();
    expect((await h.core.checkUpdate()).canUpdate).toBe(false);
    await expect(h.core.applyUpdate(() => {})).rejects.toThrow(/недоступно/);
  });
  it('сбой скачивания сообщается и не оставляет блокировку', async () => {
    const installDir = mk();
    const bad = (async (url: string) => (String(url).includes('api.github') ? new Response(JSON.stringify({ sha: SHA, commit: { message: 'x' } })) : new Response('', { status: 500 }))) as unknown as typeof fetch;
    const h = makeCore({ installDir, updateFetch: bad, skipBuild: true });
    await expect(h.core.applyUpdate(() => {})).rejects.toThrow(/Не удалось скачать/);
    await expect(h.core.applyUpdate(() => {})).rejects.toThrow(/Не удалось скачать/); // не «уже выполняется»
  });
});
