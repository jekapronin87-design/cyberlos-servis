import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qualityIssues, stuckDeals, trainingNeeds, managerLoad, loadSnapshot, overview } from '../src/core/crm/analytics';
import { CrmClient, CrmError, validateCrmBaseUrl } from '../src/core/crm/client';
import { maskEmail, maskFreeText, maskKnownNames, maskName, maskPhone } from '../src/core/crm/mask';
import { MemorySecretStore } from '../src/core/security/secrets';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';
import { chat, makeCore } from './helpers';
import { NOW, startCrmFixture, type Fixture } from './crmFixture';

let fx: Fixture;
beforeAll(async () => {
  fx = await startCrmFixture();
});
afterAll(async () => {
  await fx.close();
});

const cfg = (over: Record<string, unknown> = {}) => ({ baseUrl: fx.url, environment: 'test' as const, email: 'jarvis@aquamaster.ru', maskPii: true, ...over });

function setup(over: { email?: string; password?: string; maskPii?: boolean } = {}, extra: Record<string, unknown> = {}) {
  const h = makeCore({ crmFetch: fetch, crmNow: () => NOW, ...extra });
  h.core.crmSave(cfg({ email: over.email ?? 'jarvis@aquamaster.ru', maskPii: over.maskPii ?? true }), over.password ?? 'ro-pass-123');
  return h;
}
const run = async (h: ReturnType<typeof makeCore>, name: string, input: Record<string, unknown> = {}): Promise<string> => {
  const out = await h.core.tools.get(name)!.execute(input as never, { conversationId: 1, runId: 'r', signal: new AbortController().signal });
  return typeof out === 'string' ? out : out.text;
};

describe('маскирование ПДн', () => {
  it('телефон, почта, имя, свободный текст', () => {
    expect(maskPhone('+7 905 123 45 67')).not.toContain('905');
    expect(maskPhone('+7 905 123 45 67')).toMatch(/45-67$/);
    expect(maskEmail('ivan.petrov@mail.ru')).toBe('i***@mail.ru');
    expect(maskName('Иван Петров')).toBe('Иван П.');
    expect(maskName('Иван Петрович Сидоров')).toBe('Иван П.С.');
    const t = maskFreeText('Звонить +7 905 123 45 67 или ivan@mail.ru, заказ №4521 на 15 000 ₽');
    const k = maskKnownNames('Заявка с сайта: Иван Петров; звонил Петров, а Ивану Петровичу перезвонят', 'Иван Петров');
    expect(k).toContain('Иван П.');
    expect(k).not.toMatch(/Петров(?!ич)/);
    expect(maskKnownNames('без имён', 'Иван Петров')).toBe('без имён');
    expect(maskKnownNames('текст', null)).toBe('текст');
    expect(t).not.toContain('905 123');
    expect(t).not.toContain('ivan@');
    expect(t).toContain('№4521');
    expect(t).toContain('15 000');
  });
});

describe('клиент CRM: только чтение', () => {
  it('разрешены только вход и GET по списку путей; остальное блокируется до отправки', async () => {
    const secrets = new MemorySecretStore();
    secrets.set('crm.password', 'ro-pass-123');
    const c = new CrmClient(() => ({ baseUrl: fx.url, email: 'jarvis@aquamaster.ru', environment: 'test', maskPii: true }), secrets);
    const before = fx.requests.length;
    for (const bad of ['/crm/pipelines/deals/d1/move-stage', '/admin/dealers', '/crm/roles', '/crm/pipelines/d1/stages', '/auth/login', '/crm/messenger', '/../etc/passwd', '/crm/tasks/x/comments']) {
      await expect(c.get(bad)).rejects.toThrow(/не входит в список разрешённых/);
    }
    expect(fx.requests.length).toBe(before); // ни одного запроса не ушло
    expect(Array.isArray(await c.get('/crm/pipelines'))).toBe(true);
  });

  it('при 401 перелогинивается и повторяет запрос', async () => {
    const secrets = new MemorySecretStore();
    secrets.set('crm.password', 'ro-pass-123');
    const c = new CrmClient(() => ({ baseUrl: fx.url, email: 'jarvis@aquamaster.ru', environment: 'test', maskPii: true }), secrets);
    await c.get('/crm/team');
    const logins = fx.logins;
    fx.expireTokens();
    expect(Array.isArray(await c.get('/crm/team'))).toBe(true);
    expect(fx.logins).toBe(logins + 1);
  });

  it('понятные ошибки: неверный пароль, нет прав, нет связи, плохой адрес', async () => {
    const mkc = (email: string, pw: string, url = fx.url) => {
      const s = new MemorySecretStore();
      s.set('crm.password', pw);
      return new CrmClient(() => ({ baseUrl: url, email, environment: 'test', maskPii: true }), s);
    };
    await expect(mkc('jarvis@aquamaster.ru', 'wrong').get('/crm/team')).rejects.toThrow(/неверный email или пароль/);
    await expect(mkc('weak@aquamaster.ru', 'p').get('/crm/team')).rejects.toThrow(/нет права/);
    await expect(mkc('jarvis@aquamaster.ru', 'ro-pass-123', 'http://127.0.0.1:1').get('/crm/team')).rejects.toThrow(/Нет связи/);
    expect(() => validateCrmBaseUrl('http://crm.example.ru')).toThrow(/https/);
    expect(() => validateCrmBaseUrl('https://u:p@crm.example.ru')).toThrow();
    expect(validateCrmBaseUrl('https://crm.example.ru/')).toBe('https://crm.example.ru');
    expect(validateCrmBaseUrl('http://localhost:4000')).toBe('http://localhost:4000');
    // ссылка-приглашение или страница входа вместо адреса — берём только адрес сервера
    expect(validateCrmBaseUrl('https://crm.example.ru/invite/accept?token=abc')).toBe('https://crm.example.ru');
    expect(validateCrmBaseUrl('https://crm.example.ru/login#x')).toBe('https://crm.example.ru');
    expect(validateCrmBaseUrl('https://example.ru/api/')).toBe('https://example.ru/api');
    expect(validateCrmBaseUrl('https://example.ru/api/auth/login')).toBe('https://example.ru/api');
  });
});

describe('проверка учётной записи', () => {
  it('учётная запись «только чтение» признаётся безопасной', async () => {
    const r = await setup().core.crmTest();
    expect(r).toMatchObject({ ok: true, readOnlySafe: true, fullAdmin: false, writeLike: [], missingRead: [] });
    expect(r.user?.roleName).toBe('Джарвис (чтение)');
  });
  it('админ и роли с правами на изменение — предупреждение; нехватка прав чтения — перечислена', async () => {
    expect(await setup({ email: 'admin@aquamaster.ru', password: 'admin-pass' }).core.crmTest()).toMatchObject({ ok: true, fullAdmin: true, readOnlySafe: false });
    const power = await setup({ email: 'power@aquamaster.ru', password: 'p' }).core.crmTest();
    expect(power.readOnlySafe).toBe(false);
    expect(power.writeLike).toEqual(expect.arrayContaining(['pipeline.manage_all', 'deals.bulk_delete']));
    const weak = await setup({ email: 'weak@aquamaster.ru', password: 'p' }).core.crmTest();
    expect(weak.missingRead).toEqual(expect.arrayContaining(['pipeline.view_all', 'tasks.view_all', 'team.view', 'inventory.view']));
  });
  it('неверный пароль — ok=false с причиной', async () => {
    const r = await setup({ password: 'nope' }).core.crmTest();
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/неверный email или пароль/);
  });
});

describe('аналитика', () => {
  it('срез данных, SLA, ошибки и темы обучения', async () => {
    const h = setup();
    const snap = await h.core.crm.snapshot(true);
    expect(snap.deals).toHaveLength(7);
    expect(snap.missing).toEqual([]);
    const stuck = stuckDeals(snap).map((x) => x.deal.id);
    expect(stuck).toContain('d1'); // 10 ч при SLA 4 ч
    expect(stuck).not.toContain('d2'); // 5 ч при SLA 24 ч
    const issues = qualityIssues(snap);
    const kinds = (id: string) => issues.filter((i) => i.dealId === id).map((i) => i.kind);
    expect(kinds('d1')).toEqual(expect.arrayContaining(['missing_required_field', 'stuck']));
    expect(kinds('d1')).not.toContain('no_next_action'); // у d1 есть открытая задача t1
    expect(kinds('d2')).toEqual([]);
    expect(kinds('d3')).toEqual(expect.arrayContaining(['no_assignee', 'no_next_action']));
    expect(kinds('d4')).toContain('lost_without_reason');
    expect(kinds('d5')).toContain('status_stage_mismatch');
    expect(kinds('d6')).toContain('lead_without_contact');
    expect(issues.some((i) => i.kind === 'production_unpaid_in_work')).toBe(true);
    expect(issues.some((i) => i.kind === 'production_overdue')).toBe(true);
    const needs = trainingNeeds(issues);
    expect(needs.find((n) => n.employee === 'Анна Соколова')!.topics.map((t) => t.kind)).toEqual(expect.arrayContaining(['missing_required_field']));
    const mg = managerLoad(snap);
    expect(mg.find((m) => m.name === 'Анна Соколова')).toMatchObject({ tasksOverdue: 1 });
    expect(mg.find((m) => m.name === 'Борис Лебедев')).toMatchObject({ doneOnTime: 1, doneLate: 1 });
    expect(mg.some((m) => m.name === 'Клара Уволенная')).toBe(false); // уволенные не учитываются
    expect(overview(snap)).toMatchObject({ newLast24h: 2, unassignedOpen: 1, tasksOverdue: 1, productionOverdue: 1, awaitingPrepayment: 1, lowStock: 1 });
  });
  it('нехватка прав не ломает отчёт: недоступные разделы перечислены', async () => {
    const h = setup({ email: 'weak@aquamaster.ru', password: 'p' });
    const out = await run(h, 'crm_production');
    expect(out).toContain('Нет доступа к разделам');
    expect(out).toContain('Заказов в работе: 1');
  });
});

describe('инструменты CRM для ИИ', () => {
  it('сводка и фильтры; сотрудников видно, клиентов — нет (маскирование)', async () => {
    const h = setup();
    const ov = await run(h, 'crm_overview');
    expect(ov).toContain('Заявки дилеров');
    expect(ov).toContain('Новых за 24 ч: 2');
    const stuck = await run(h, 'crm_deals', { stuck: true });
    expect(stuck).toContain('Водолей');
    expect(stuck).toContain('Анна Соколова');
    const cold = await run(h, 'crm_deals', { pipeline: 'cold_leads' });
    expect(cold).toContain('Иван П.');
    for (const leak of ['Петров', '905 123', 'ivan.petrov', '927 555']) expect(cold, leak).not.toContain(leak);
    expect(await run(h, 'crm_deals', { assignee: 'борис', status: 'lost' })).toContain('Найдено сделок: 1');
    await expect(run(h, 'crm_deals', { pipeline: 'нет-такой' })).rejects.toThrow(/не найдена/);
    const hist = await run(h, 'crm_deal_history', { dealId: 'd1' });
    expect(hist).not.toContain('905 123'); // телефон из комментария замаскирован
    await expect(run(h, 'crm_deal_history', { dealId: '../x' })).rejects.toThrow(/Некорректный/);
  });
  it('без маскирования данные клиентов видны (осознанный выбор пользователя)', async () => {
    const h = setup({ maskPii: false });
    expect(await run(h, 'crm_deals', { pipeline: 'cold_leads' })).toContain('Иван Петров');
  });
  it('отчёты: daily, managers, bottlenecks, quality, training', async () => {
    const h = setup();
    expect(await run(h, 'crm_report', { kind: 'daily' })).toMatch(/Требуют внимания[\s\S]*Анна Соколова/);
    expect(await run(h, 'crm_report', { kind: 'managers' })).toContain('Борис Лебедев');
    const bn = await run(h, 'crm_report', { kind: 'bottlenecks' });
    expect(bn).toContain('Конверсия');
    expect(bn).toContain('не указана'); // отказ без причины
    const quality = await run(h, 'crm_report', { kind: 'quality' });
    expect(quality).toContain('Не заполнены обязательные поля');
    for (const leak of ['Петров', '905 123', 'ivan.petrov']) expect(quality, leak).not.toContain(leak);
    expect(await run(h, 'crm_tasks', {})).not.toContain('905 123');
    expect(await run(h, 'crm_report', { kind: 'training' })).toContain('Заполнение карточки сделки');
    expect(await run(h, 'crm_production', {})).toMatch(/ПРОСРОЧЕНО[\s\S]*ждёт предоплаты|ждёт предоплаты[\s\S]*ПРОСРОЧЕНО/);
    expect(await run(h, 'crm_team', {})).toContain('(не работает)');
  });
  it('без подключения инструменты объясняют, что делать', async () => {
    const h = makeCore();
    expect(await run(h, 'crm_status')).toContain('не подключена');
    await expect(run(h, 'crm_overview')).rejects.toThrow(/не подключена/);
  });
});

describe('безопасность подключения', () => {
  it('за весь сеанс отправлен один вход и только GET; пароль не светится в журнале', async () => {
    const h = setup();
    const start = fx.requests.length;
    for (const [name, input] of [['crm_overview', {}], ['crm_deals', {}], ['crm_tasks', {}], ['crm_team', {}], ['crm_production', {}], ['crm_report', { kind: 'quality' }], ['crm_deal_history', { dealId: 'd1' }]] as const) await run(h, name, input);
    const mine = fx.requests.slice(start);
    const nonGet = mine.filter((r) => r.method !== 'GET');
    expect(nonGet.every((r) => r.method === 'POST' && r.path === '/auth/login')).toBe(true);
    expect(nonGet.length).toBeLessThanOrEqual(1);
    const log = JSON.stringify(h.core.listAudit(300));
    expect(log).not.toContain('ro-pass-123');
    expect(log).toContain('crm.configured');
    expect(h.core.listAudit().find((a) => a.action === 'crm.configured')).toMatchObject({ risk: 'high' });
    expect(h.secrets.get('crm.password')).toBe('ro-pass-123');
    expect(JSON.stringify(h.core.getSettings())).not.toContain('ro-pass-123');
  });
  it('отключение стирает пароль и настройки', async () => {
    const h = setup();
    expect(h.core.crmStatus()).toMatchObject({ configured: true, hasPassword: true });
    h.core.crmDisconnect();
    expect(h.core.crmStatus()).toMatchObject({ configured: false, hasPassword: false, baseUrl: '' });
    expect(h.secrets.has('crm.password')).toBe(false);
  });
  it('настройка проверяет входные данные', () => {
    const h = makeCore();
    expect(() => h.core.crmSave({ baseUrl: 'ftp://x', environment: 'test', email: 'a@b.ru', maskPii: true })).toThrow();
    expect(() => h.core.crmSave({ baseUrl: 'https://crm.x.ru', environment: 'test', email: 'не почта', maskPii: true })).toThrow(/email/);
    expect(() => h.core.crmSave({ baseUrl: 'https://crm.x.ru', environment: 'weird' as never, email: 'a@b.ru', maskPii: true })).toThrow(/Окружение/);
  });
});

describe('CRM в диалоге', () => {
  it('ассистент получает данные без окон подтверждения; промпт сообщает про режим «только чтение»', async () => {
    let sys = '';
    let step = 0;
    const provider: ChatProvider = {
      id: 'crm',
      name: 'crm',
      async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        sys = req.system;
        step++;
        if (step === 1) yield { type: 'tool_use', id: 'c1', name: 'crm_overview', input: {} };
        else yield { type: 'text', text: 'Сводка готова.' };
      },
    };
    const h = setup({}, { liveProvider: provider });
    h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
    const { id } = await chat(h, 'Что в CRM?');
    expect(h.confirms).toHaveLength(0);
    const res = h.core.messages(id).find((m) => m.role === 'tool')!.content[0] as { content: string };
    expect(res.content).toContain('Заявки дилеров');
    expect(sys).toMatch(/ТОЛЬКО ЧТЕНИЯ/);
    expect(sys).toMatch(/тестовое окружение/);
    expect(sys).toMatch(/замаскированы/);
    h.core.crmSave(cfg({ environment: 'production' }));
    await chat(h, 'ещё раз');
    expect(sys).toMatch(/РАБОЧЕЕ окружение/);
  });
});

void loadSnapshot;
void CrmError;

describe('адрес CRM: «/api» подставляется сам', () => {
  it('если указан адрес сайта без /api, вход находит API по /api; неверный адрес — понятная ошибка', async () => {
    const fx = await startCrmFixture();
    try {
      const wrapped = (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (!u.pathname.startsWith('/api/')) return new Response('<!doctype html><html>сайт</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        return fetch(`${u.origin}${u.pathname.slice(4)}${u.search}`, init);
      }) as typeof fetch;
      const h = makeCore({ crmFetch: wrapped, crmNow: () => NOW });
      h.core.crmSave({ baseUrl: fx.url, environment: 'test', email: 'jarvis@aquamaster.ru', maskPii: true }, 'ro-pass-123');
      expect(await run(h, 'crm_status')).toContain('подключена');
      expect(await run(h, 'crm_overview')).toMatch(/воронк|Воронк|заявк/i);
      expect(h.core.crm.client.effectiveBase()).toBe(fx.url + '/api');
      // сайт вообще без API
      const bad = makeCore({ crmFetch: (async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch, crmNow: () => NOW });
      bad.core.crmSave({ baseUrl: 'https://example.com', environment: 'test', email: 'a@b.ru', maskPii: true }, 'pass-12345');
      await expect(bad.core.crm.client.get('/auth/me')).rejects.toThrow(/Не нашёл сервер CRM/);
    } finally {
      await fx.close();
    }
  });
});

describe('адрес CRM: сервер на отдельном поддомене', () => {
  it('сайт crm.домен отдаёт только страницы, а сервер — api.домен: находится по /health, пароль уходит только на найденный сервер', async () => {
    const fx = await startCrmFixture();
    try {
      const logins: string[] = [];
      const wrapped = (async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        if (u.hostname === 'api.example.ru') {
          if (u.pathname === '/auth/login') logins.push(u.hostname);
          return fetch(`${fx.url}${u.pathname}${u.search}`, init);
        }
        if (u.pathname === '/auth/login') logins.push(u.hostname);
        return new Response('<!doctype html>Такой страницы нет', { status: 200, headers: { 'content-type': 'text/html' } });
      }) as typeof fetch;
      const h = makeCore({ crmFetch: wrapped, crmNow: () => NOW });
      h.core.crmSave({ baseUrl: 'https://crm.example.ru', environment: 'test', email: 'jarvis@aquamaster.ru', maskPii: true }, 'ro-pass-123');
      expect(await run(h, 'crm_overview')).toMatch(/воронк|Воронк|заявк/i);
      expect(h.core.crm.client.effectiveBase()).toBe('https://api.example.ru');
      expect(logins).toEqual(['api.example.ru']); // на сайт с «Такой страницы нет» пароль не отправлялся
    } finally {
      await fx.close();
    }
  });
});
