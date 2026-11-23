import { describe, expect, it } from 'vitest';
import { normalizeAquaPath, validateAquaBaseUrl, validateAquaKey } from '../src/core/aqua/service';
import { toolsForAgent } from '../src/core/agents/groups';
import { makeCore } from './helpers';

const KEY = 'sro_TestKey1234567890abcdefghijklmnop';
const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };

interface Call {
  url: string;
  method: string;
  auth: string | null;
  redirect?: string;
}

function fakeCrm() {
  const calls: Call[] = [];
  let mode: 'ok' | '401' | '403' | '404' | '429' | 'redirect' | 'html' = 'ok';
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), auth: new Headers(init.headers).get('authorization'), redirect: init.redirect as string });
    if (mode === '401') return new Response('{}', { status: 401 });
    if (mode === '403') return new Response('{}', { status: 403 });
    if (mode === '404') return new Response('{}', { status: 404 });
    if (mode === '429') return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
    if (mode === 'redirect') return new Response('', { status: 307, headers: { location: 'https://evil.example/steal' } });
    if (mode === 'html') return new Response('<html>', { status: 200 });
    const p = new URL(url).pathname;
    if (p === '/api/readonly/health') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (p === '/api/readonly/deals')
      return new Response(JSON.stringify({ items: [{ id: 'd1', title: 'Септик для Ивана', phone: '+7 912 345-67-89', note: 'пишите ivan@mail.ru', amount: 123456789012 }], nextCursor: null }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, set: (m: typeof mode) => (mode = m) };
}

describe('Аквамастер: проверка ввода', () => {
  it('ключ: только sro_…, без пробелов; адрес — только origin по https', () => {
    expect(validateAquaKey(`  ${KEY}  `)).toBe(KEY);
    expect(() => validateAquaKey('')).toThrow(/Вставьте/);
    expect(() => validateAquaKey('Qwerty12345!')).toThrow(/sro_/);
    expect(() => validateAquaKey('sro_aaaa bbbb cccc dddd')).toThrow(/пробел/);
    expect(() => validateAquaKey('sro_abc')).toThrow(/неполн/);
    expect(validateAquaBaseUrl('https://crm.aquamaster-septiki.ru/login?x=1')).toBe('https://crm.aquamaster-septiki.ru');
    expect(() => validateAquaBaseUrl('http://crm.example.ru')).toThrow(/https/);
    expect(() => validateAquaBaseUrl('https://u:p@crm.example.ru')).toThrow(/логин/);
  });

  it('путь: только /api/readonly/…, без выхода наружу', () => {
    expect(normalizeAquaPath('deals')).toBe('/api/readonly/deals');
    expect(normalizeAquaPath('/leads/cold?limit=5')).toBe('/api/readonly/leads/cold');
    expect(normalizeAquaPath('/api/readonly/employees/')).toBe('/api/readonly/employees');
    expect(normalizeAquaPath('')).toBe('/api/readonly');
    expect(normalizeAquaPath('https://evil.example/api/readonly/deals')).toBe('/api/readonly/deals');
    expect(() => normalizeAquaPath('../admin')).toThrow(/не подходит/);
    expect(() => normalizeAquaPath('deals/../../auth')).toThrow(/не подходит/);
    expect(() => normalizeAquaPath('deals;rm -rf')).toThrow(/не подходит/);
  });
});

describe('Аквамастер: подключение по ключу', () => {
  const setup = () => {
    const c = fakeCrm();
    const h = makeCore({ crmFetch: c.f });
    return { h, c };
  };

  it('без ключа — понятная ошибка; ключ хранится в хранилище секретов, не в базе и не в журнале', async () => {
    const { h, c } = setup();
    expect(h.core.aquaStatus()).toMatchObject({ configured: false, hasKey: false, baseUrl: 'https://crm.aquamaster-septiki.ru' });
    await expect(h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx)).rejects.toThrow(/не подключена/);
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    expect(h.core.aquaStatus()).toMatchObject({ configured: true, hasKey: true });
    await h.core.aquaTest();
    expect(h.secrets.get('aqua.key')).toBe(KEY);
    expect(JSON.stringify(h.core.listAudit(200))).not.toContain(KEY);
    expect(c.calls.every((x) => !x.url.includes(KEY))).toBe(true);
    const rows = (h.core.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map((r) => r.value).join('|');
    expect(rows).not.toContain(KEY);
  });

  it('только GET с Bearer-ключом на сохранённый адрес, перенаправления не выполняются', async () => {
    const { h, c } = setup();
    h.core.aquaSave({ baseUrl: 'https://crm.aquamaster-septiki.ru', maskPii: true }, KEY);
    await h.core.tools.get('crm_live_get')!.execute({ path: 'deals', query: { limit: 5, from: '2026-11-01' } }, ctx);
    const call = c.calls.at(-1)!;
    expect(call.method).toBe('GET');
    expect(call.auth).toBe(`Bearer ${KEY}`);
    expect(call.redirect).toBe('manual');
    expect(call.url).toBe('https://crm.aquamaster-septiki.ru/api/readonly/deals?limit=5&from=2026-11-01');
    c.set('redirect');
    await expect(h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx)).rejects.toThrow(/перенаправляет.*не отправлен/);
    expect(c.calls.every((x) => x.url.startsWith('https://crm.aquamaster-septiki.ru/'))).toBe(true);
  });

  it('параметры запроса проверяются; чужие пути отклоняются без обращения к сети', async () => {
    const { h, c } = setup();
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    await Promise.resolve(h.core.tools.get('crm_live_get')!.execute({ path: '/auth/login' }, ctx)).catch(() => undefined); // превращается в /api/readonly/auth/login
    await expect(h.core.tools.get('crm_live_get')!.execute({ path: 'deals', query: { 'a b': '1' } }, ctx)).rejects.toThrow(/параметра/);
    await expect(h.core.tools.get('crm_live_get')!.execute({ path: '../admin' }, ctx)).rejects.toThrow(/не подходит/);
    expect(c.calls.length).toBe(1);
    expect(new URL(c.calls[0]!.url).pathname).toBe('/api/readonly/auth/login');
  });

  it('телефоны и почта скрываются (числа и id не трогаются); можно выключить маскирование', async () => {
    const { h } = setup();
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    const t = String(await h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx));
    expect(t).not.toContain('345-67-89');
    expect(t).not.toContain('ivan@mail.ru');
    expect(t).toContain('123456789012');
    expect(t).toContain('"id": "d1"');
    h.core.aquaSave({ baseUrl: '', maskPii: false });
    expect(String(await h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx))).toContain('ivan@mail.ru');
  });

  it('ошибки CRM объясняются по-русски: 401, 403, 404, 429, не-JSON', async () => {
    const { h, c } = setup();
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    const get = () => h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx);
    c.set('401');
    await expect(get()).rejects.toThrow(/не приняла ключ/);
    c.set('403');
    await expect(get()).rejects.toThrow(/не открывает данный раздел/);
    c.set('404');
    await expect(get()).rejects.toThrow(/Такого адреса/);
    c.set('429');
    await expect(get()).rejects.toThrow(/30/);
    c.set('html');
    await expect(get()).rejects.toThrow(/не JSON/);
    await expect(h.core.aquaTest()).rejects.toThrow(/не JSON/);
  });

  it('crm_live_index без индекса у CRM подсказывает известные разделы; инструменты только для чтения и входят в группу «CRM»', async () => {
    const { h } = setup();
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    const idx = String(await h.core.tools.get('crm_live_index')!.execute({}, ctx));
    expect(idx).toContain('summary');
    for (const n of ['crm_live_status', 'crm_live_index', 'crm_live_get']) {
      const t = h.core.tools.list().find((x) => x.name === n)!;
      expect(t.mutates, n).toBe(false);
      expect(t.risk, n).toBe('low');
      expect(h.core.tools.get(n)!.external, n).toBe(true);
    }
    const allowed = toolsForAgent(['crm'], 'read', h.core.tools);
    expect(allowed.has('crm_live_get')).toBe(true);
    expect(toolsForAgent(['web'], 'read', h.core.tools).has('crm_live_get')).toBe(false);
  });

  it('удаление ключа отключает доступ', async () => {
    const { h } = setup();
    h.core.aquaSave({ baseUrl: '', maskPii: true }, KEY);
    expect(h.core.aquaDisconnect().hasKey).toBe(false);
    expect(h.secrets.has('aqua.key')).toBe(false);
    await expect(h.core.tools.get('crm_live_get')!.execute({ path: 'deals' }, ctx)).rejects.toThrow(/не подключена/);
  });
});
