import { describe, expect, it } from 'vitest';
import { DeviceRepo, PairingCodes, RateLimiter } from '../src/core/gateway/devices';
import { hostAllowed, isLocalNetworkAddress } from '../src/core/gateway/server';
import { openDatabase } from '../src/core/db/database';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';
import { makeCore, type Harness } from './helpers';

describe('шлюз: коды, токены, лимиты', () => {
  it('код: одноразовый, истекает, сгорает после 5 неверных попыток', () => {
    let t = 1000;
    const c = new PairingCodes(() => t);
    const { code } = c.issue();
    expect(code).toMatch(/^\d{6}$/);
    expect(c.consume('000000' === code ? '111111' : '000000')).toBe(false);
    expect(c.consume(code)).toBe(true);
    expect(c.consume(code)).toBe(false); // погашен
    const second = c.issue().code;
    t += 5 * 60_000 + 1;
    expect(c.consume(second)).toBe(false); // истёк
    const third = c.issue().code;
    const bad = third === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) expect(c.consume(bad)).toBe(false);
    expect(c.consume(third)).toBe(false); // сгорел после перебора
    expect(c.active).toBe(false);
  });

  it('устройства: хранится только хеш, отзыв работает, мусорный токен отвергается', () => {
    const db = openDatabase(':memory:');
    const repo = new DeviceRepo(db);
    const { id, token } = repo.create('  <b>Телефон Ани</b> ');
    const raw = JSON.stringify(db.prepare('SELECT * FROM devices').all());
    expect(raw).not.toContain(token);
    expect(repo.authenticate(token)?.name).not.toContain('<');
    expect(repo.authenticate('x'.repeat(64))).toBeNull();
    expect(repo.authenticate('../../etc')).toBeNull();
    repo.revoke(id);
    expect(repo.authenticate(token)).toBeNull();
  });

  it('лимитер: скользящее окно', () => {
    let t = 0;
    const l = new RateLimiter(3, 1000, () => t);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true, false]);
    expect(l.hit('b')).toBe(true);
    t = 1001;
    expect(l.hit('a')).toBe(true);
  });

  it('сеть: только локальные адреса и Host без доменных имён', () => {
    for (const a of ['127.0.0.1', '::1', '192.168.1.5', '10.0.0.7', '172.16.3.3', '::ffff:192.168.0.9', 'fe80::1']) expect(isLocalNetworkAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '203.0.113.5', '::ffff:8.8.8.8', '2001:db8::1']) expect(isLocalNetworkAddress(a)).toBe(false);
    expect(hostAllowed('192.168.1.5:8787')).toBe(true);
    expect(hostAllowed('localhost:8787')).toBe(true);
    expect(hostAllowed('evil.example.com')).toBe(false); // DNS-rebinding
    expect(hostAllowed(undefined)).toBe(false);
  });
});

const scripted = (fn: (req: ProviderRequest, n: number) => ProviderEvent[]): ChatProvider => {
  let n = 0;
  return { id: 's', name: 's', async *stream(req) { for (const e of fn(req, ++n)) yield e; } };
};

async function boot(provider?: ChatProvider): Promise<{ h: Harness; base: string }> {
  const h = makeCore({ gatewayPort: 0, ...(provider ? { liveProvider: provider } : {}) });
  if (provider) h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
  h.core.updateSettings({ gatewayMode: 'localhost' });
  const st = await h.core.applyGateway();
  expect(st.running).toBe(true);
  return { h, base: `http://127.0.0.1:${st.port}` };
}

async function pair(h: Harness, base: string, name = 'Тест-телефон'): Promise<string> {
  const { code } = h.core.gatewayPairingCode();
  const r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, name }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

const api = async (base: string, path: string, token: string | null, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

async function waitDone(base: string, token: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const r = await api(base, '/api/run', token);
    if (r.json.status !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error('не дождались');
}

describe('шлюз: HTTP', () => {
  it('по умолчанию выключен; без токена API закрыт; страница отдаётся с CSP', async () => {
    const h = makeCore({ gatewayPort: 0 });
    expect(h.core.gatewayStatus()).toMatchObject({ mode: 'off', running: false });
    expect(() => h.core.gatewayPairingCode()).toThrow(/включите/);
    await h.core.close();

    const { h: h2, base } = await boot();
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await page.text()).not.toMatch(/<script>[^<]/); // нет встроенных скриптов
    expect((await api(base, '/api/me', null)).status).toBe(401);
    expect((await api(base, '/api/me', 'a'.repeat(64))).status).toBe(401);
    expect((await fetch(base + '/api/nothing')).status).toBe(401);
    await h2.core.close();
  });

  it('неверный Host (DNS-rebinding) отвергается', async () => {
    const { h, base } = await boot();
    const r = await new Promise<number>((resolve) => {
      // node:http позволяет подменить Host
      import('node:http').then(({ request }) => {
        const q = request(base + '/', { headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode ?? 0));
        q.end();
      });
    });
    expect(r).toBe(403);
    await h.core.close();
  });

  it('сопряжение: неверный код отвергается, верный выдаёт токен, код одноразовый', async () => {
    const { h, base } = await boot();
    const { code } = h.core.gatewayPairingCode();
    const bad = code === '000000' ? '111111' : '000000';
    expect((await api(base, '/api/pair', null, { code: bad, name: 'x' })).status).toBe(403);
    const ok = await api(base, '/api/pair', null, { code, name: 'Телефон' });
    expect(ok.status).toBe(200);
    expect(String(ok.json.token)).toMatch(/^[0-9a-f]{64}$/);
    expect((await api(base, '/api/pair', null, { code, name: 'Второй' })).status).toBe(403);
    expect(h.core.listDevices()).toHaveLength(1);
    const audit = JSON.stringify(h.core.listAudit(100));
    expect(audit).toContain('gateway.pair_failed');
    expect(audit).toContain('gateway.paired');
    expect(audit).not.toContain(String(ok.json.token));
    await h.core.close();
  });

  it('чат с телефона: ответ, история, отдельный диалог, отзыв устройства', async () => {
    const { h, base } = await boot(scripted(() => [{ type: 'text', text: 'Добрый день, на связи.' }]));
    const token = await pair(h, base);
    expect((await api(base, '/api/chat', token, { text: 'Привет' })).status).toBe(202);
    const done = await waitDone(base, token);
    expect(done).toMatchObject({ status: 'done', reply: 'Добрый день, на связи.' });
    const hist = await api(base, '/api/messages', token);
    expect((hist.json.messages as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.core.listConversations().some((c) => c.title.startsWith('С телефона'))).toBe(true);
    expect((await api(base, '/api/chat', token, { text: '' })).status).toBe(400);
    h.core.revokeDevice(h.core.listDevices()[0]!.id);
    expect((await api(base, '/api/me', token)).status).toBe(401);
    await h.core.close();
  });

  it('слишком большое тело отвергается', async () => {
    const { h, base } = await boot();
    const token = await pair(h, base);
    const r = await api(base, '/api/chat', token, { text: 'a'.repeat(20_000) }).catch(() => ({ status: 0, json: {} }));
    expect([0, 400]).toContain(r.status);
    await h.core.close();
  });

  it('перебор токенов и кода ограничивается', async () => {
    const { h, base } = await boot();
    h.core.gatewayPairingCode();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await api(base, '/api/pair', null, { code: '999999', name: 'x' })).status;
    expect(last).toBe(429);
    await h.core.close();
  });
});

describe('шлюз: удалённая политика', () => {
  const remoteScript = (tool: string, input: Record<string, unknown>) =>
    scripted((_r, n) => (n === 1 ? [{ type: 'tool_use', id: 't', name: tool, input }] : [{ type: 'text', text: 'Результат получен.' }]));

  const toolResult = (h: Harness): string =>
    JSON.stringify(h.core.conversations.messages(h.core.listConversations()[0]!.id).filter((m) => m.role === 'tool'));

  it('подтверждения с телефона запрещены по умолчанию (на ПК запрос не появляется)', async () => {
    const { h, base } = await boot(remoteScript('schedule_create', { title: 'x', prompt: 'y', kind: 'daily', time: '10:00' }));
    const token = await pair(h, base);
    await api(base, '/api/chat', token, { text: 'создай задачу' });
    await waitDone(base, token);
    expect(h.confirms).toHaveLength(0);
    expect(h.core.listJobs()).toHaveLength(0);
    expect(toolResult(h)).toContain('нельзя подтверждать');
    expect(JSON.stringify(h.core.listAudit(100))).toContain('remote_actions_off');
    await h.core.close();
  });

  it('если разрешено в настройках — запрос идёт на ПК с пометкой и выполняется только после «Разрешить»', async () => {
    const { h, base } = await boot(remoteScript('schedule_create', { title: 'Сводка', prompt: 'Сделай сводку', kind: 'daily', time: '10:00' }));
    h.core.updateSettings({ gatewayAllowActions: true });
    const token = await pair(h, base);
    h.autoAnswer.value = false;
    await api(base, '/api/chat', token, { text: 'создай задачу' });
    await waitDone(base, token);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]!.description).toContain('ЗАПРОС С ТЕЛЕФОНА');
    expect(h.core.listJobs()).toHaveLength(0);
    await h.core.close();

    const b = await boot(remoteScript('schedule_create', { title: 'Сводка', prompt: 'Сделай сводку', kind: 'daily', time: '10:00' }));
    b.h.core.updateSettings({ gatewayAllowActions: true });
    const t2 = await pair(b.h, b.base);
    b.h.autoAnswer.value = true;
    await api(b.base, '/api/chat', t2, { text: 'создай задачу' });
    await waitDone(b.base, t2);
    expect(b.h.confirms).toHaveLength(1);
    expect(b.h.core.listJobs()).toHaveLength(1);
    await b.h.core.close();
  });

  it('высокий риск с телефона запрещён даже при включённых действиях', async () => {
    const { h, base } = await boot(remoteScript('danger_tool', {}));
    let ran = false;
    h.core.tools.register({
      name: 'danger_tool',
      description: 'тест',
      risk: 'high',
      mutates: true,
      domain: 'local',
      inputSchema: { type: 'object', properties: {} },
      describe: () => 'опасное',
      execute: () => ((ran = true), 'выполнено'),
    });
    h.core.updateSettings({ gatewayAllowActions: true });
    const token = await pair(h, base);
    await api(base, '/api/chat', token, { text: 'сделай' });
    await waitDone(base, token);
    expect(ran).toBe(false);
    expect(h.confirms).toHaveLength(0);
    expect(toolResult(h)).toContain('высокий риск');
    await h.core.close();
  });

  it('безопасные инструменты с телефона работают', async () => {
    const { h, base } = await boot(remoteScript('get_datetime', {}));
    const token = await pair(h, base);
    await api(base, '/api/chat', token, { text: 'который час' });
    expect(await waitDone(base, token)).toMatchObject({ status: 'done' });
    expect(h.confirms).toHaveLength(0);
    await h.core.close();
  });

  it('отключение модуля «Доступ с телефона» останавливает сервер', async () => {
    const { h } = await boot();
    h.core.updateSettings({ disabledModules: ['gateway'] });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.core.gatewayStatus().running).toBe(false);
    await h.core.close();
  });
});
