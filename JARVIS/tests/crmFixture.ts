import { createServer, type IncomingMessage, type Server } from 'node:http';

export const NOW = new Date('2026-11-21T12:00:00Z');
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ahead = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();

const anna = { id: 'u-anna', email: 'anna@aquamaster.ru', employeeProfile: { fullName: 'Анна Соколова' } };
const boris = { id: 'u-boris', email: 'boris@aquamaster.ru', employeeProfile: { fullName: 'Борис Лебедев' } };

const mkStage = (id: string, key: string, name: string, sortOrder: number, slaHours: number | null, won = false, lost = false) => ({ id, key, name, sortOrder, slaHours, isWonStage: won, isLostStage: lost });
const SALES = [mkStage('s-new', 'new', 'Новая заявка', 0, 4), mkStage('s-spec', 'specification', 'Уточняем спецификацию', 1, 24), mkStage('s-won', 'won', 'Отгружено', 2, null, true), mkStage('s-lost', 'lost', 'Отказ', 3, null, false, true)];
const COLD = [mkStage('c-new', 'new', 'Новый', 0, 2), mkStage('c-contacted', 'contacted', 'Связались', 1, 12), mkStage('c-conv', 'converted', 'Стал клиентом', 2, null, true), mkStage('c-lost', 'lost', 'Отказ', 3, null, false, true)];
const PROD = [mkStage('p-new', 'new', 'Новый заказ', 0, 8), mkStage('p-work', 'in_production', 'В производстве', 1, 240), mkStage('p-done', 'done', 'Завершено', 2, null, true)];

export const pipelines = [
  { id: 'pl-sales', slug: 'dealer_sales', name: 'Заявки дилеров', stages: SALES, fields: [{ id: 'f-region', label: 'Регион дилера', type: 'text', required: true }], dealsCount: 3 },
  { id: 'pl-cold', slug: 'cold_leads', name: 'Заявки с сайта', stages: COLD, fields: [], dealsCount: 5 },
  { id: 'pl-prod', slug: 'production', name: 'Производство', stages: PROD, fields: [], dealsCount: 1 },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deal = (o: Record<string, unknown>): Record<string, any> => ({ customFields: null, lostReason: null, leadName: null, leadPhone: null, leadEmail: null, leadSource: null, assignees: [], dealerOrg: null, productionOrder: null, ...o });

export const deals = [
  deal({ id: 'd1', pipelineId: 'pl-sales', stageId: 's-new', stage: SALES[0], title: 'Дилер «Водолей»: 3 станции', status: 'open', createdAt: ago(30), updatedAt: ago(10), assignees: [{ user: anna }] }),
  deal({ id: 'd2', pipelineId: 'pl-sales', stageId: 's-spec', stage: SALES[1], title: 'Дилер «Ручей»: монтаж', status: 'open', createdAt: ago(40), updatedAt: ago(5), assignees: [{ user: boris }], customFields: { 'f-region': 'Татарстан' } }),
  deal({ id: 'd3', pipelineId: 'pl-cold', stageId: 'c-new', stage: COLD[0], title: 'Заявка с сайта: Иван Петров', status: 'open', createdAt: ago(1), updatedAt: ago(1), leadName: 'Иван Петров', leadPhone: '+7 905 123 45 67', leadEmail: 'ivan.petrov@mail.ru', leadSource: 'lpmotor_webhook' }),
  deal({ id: 'd4', pipelineId: 'pl-cold', stageId: 'c-lost', stage: COLD[3], title: 'Заявка: Ольга Н.', status: 'lost', createdAt: ago(200), updatedAt: ago(100), leadName: 'Ольга Новикова', leadPhone: '+7 927 555 11 22', leadSource: 'manual', assignees: [{ user: boris }] }),
  deal({ id: 'd5', pipelineId: 'pl-cold', stageId: 'c-conv', stage: COLD[2], title: 'Заявка: Сергей К.', status: 'open', createdAt: ago(300), updatedAt: ago(250), leadPhone: '+7 917 000 00 01', assignees: [{ user: anna }] }),
  deal({ id: 'd6', pipelineId: 'pl-cold', stageId: 'c-contacted', stage: COLD[1], title: 'Холодный контакт без телефона', status: 'open', createdAt: ago(6), updatedAt: ago(2), assignees: [{ user: boris }] }),
  deal({ id: 'd7', pipelineId: 'pl-prod', stageId: 'p-work', stage: PROD[1], title: 'Производство: СайберЛос 10 ×4', status: 'open', createdAt: ago(100), updatedAt: ago(50), assignees: [{ user: anna }] }),
];

export const tasks = [
  { id: 't1', title: 'Позвонить дилеру «Водолей»', dealId: 'd1', status: 'open', dueAt: ago(20), completedAt: null, createdAt: ago(48), assignee: anna, deal: { id: 'd1', title: 'Дилер «Водолей»' } },
  { id: 't2', title: 'Отправить КП', dealId: 'd2', status: 'open', dueAt: ahead(24), completedAt: null, createdAt: ago(10), assignee: boris, deal: { id: 'd2', title: 'Дилер «Ручей»' } },
  { id: 't3', title: 'Сверить спецификацию', dealId: null, status: 'done', dueAt: ago(60), completedAt: ago(70), createdAt: ago(100), assignee: boris, deal: null },
  { id: 't4', title: 'Подготовить договор', dealId: null, status: 'done', dueAt: ago(60), completedAt: ago(30), createdAt: ago(100), assignee: boris, deal: null },
];

export const team = [
  { id: 'u-anna', email: anna.email, phone: '+7 900 000 00 01', isActive: true, terminatedAt: null, role: { key: 'sales_manager', name: 'Менеджер по продажам' }, profile: { fullName: 'Анна Соколова' } },
  { id: 'u-boris', email: boris.email, phone: null, isActive: true, terminatedAt: null, role: { key: 'sales_head', name: 'РОП' }, profile: { fullName: 'Борис Лебедев' } },
  { id: 'u-clara', email: 'clara@aquamaster.ru', phone: null, isActive: false, terminatedAt: ago(500), role: { key: 'assembler', name: 'Сборщик' }, profile: { fullName: 'Клара Уволенная' } },
];

export const production = [
  { id: 'o1', dealId: 'd7', kind: 'customer_order', quantity: 4, plannedReadyAt: ago(48), requiresPrepayment: true, paidAt: null, startedAt: ago(60), completedAt: null, createdAt: ago(100), deal: { id: 'd7', title: 'Производство: СайберЛос 10 ×4', stage: PROD[1], dealerOrg: { name: 'Водолей' } }, shopProductVariant: { label: '10 чел.', product: { name: 'Станция СайберЛос' } }, responsibleUser: anna },
];

export const inventory = [
  { id: 'v1', productName: 'Станция СайберЛос', categoryName: 'Станции', label: '10 чел.', stockQty: 1 },
  { id: 'v2', productName: 'Станция СайберЛос', categoryName: 'Станции', label: '5 чел.', stockQty: 12 },
];

export const READ_PERMS = ['pipeline.view_all', 'tasks.view_all', 'team.view', 'inventory.view', 'pipeline.production.view'];

export interface Account {
  password: string;
  role: 'staff' | 'admin';
  roleRef: { key: string; name: string } | null;
  permissions?: string[];
}

export interface Fixture {
  url: string;
  requests: { method: string; path: string }[];
  accounts: Record<string, Account>;
  /** Следующий запрос с токеном вернёт 401 (проверка повторного входа). */
  expireTokens(): void;
  logins: number;
  close(): Promise<void>;
}

export async function startCrmFixture(): Promise<Fixture> {
  const accounts: Record<string, Account> = {
    'jarvis@aquamaster.ru': { password: 'ro-pass-123', role: 'staff', roleRef: { key: 'jarvis_readonly', name: 'Джарвис (чтение)' }, permissions: [...READ_PERMS] },
    'admin@aquamaster.ru': { password: 'admin-pass', role: 'admin', roleRef: null },
    'power@aquamaster.ru': { password: 'p', role: 'staff', roleRef: { key: 'sales_head', name: 'РОП' }, permissions: [...READ_PERMS, 'pipeline.manage_all', 'deals.bulk_delete'] },
    'weak@aquamaster.ru': { password: 'p', role: 'staff', roleRef: { key: 'assembler', name: 'Сборщик' }, permissions: ['pipeline.production.view'] },
  };
  const fx: Fixture = { url: '', requests: [], accounts, logins: 0, expireTokens: () => (valid = new Set()), close: async () => {} };
  let valid = new Set<string>();
  let counter = 0;
  const body = async (req: IncomingMessage): Promise<string> => {
    let s = '';
    for await (const c of req) s += c;
    return s;
  };

  const srv: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    fx.requests.push({ method, path: u.pathname });
    const send = (code: number, json: unknown): void => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    };
    if (method === 'POST' && u.pathname === '/auth/login') {
      const j = JSON.parse((await body(req)) || '{}') as { email?: string; password?: string };
      const a = accounts[j.email ?? ''];
      if (!a || a.password !== j.password) return send(401, { error: 'Неверный email или пароль' });
      fx.logins++;
      const token = `tok-${j.email}-${++counter}`;
      valid.add(token);
      return send(200, { token, user: { id: 'x', email: j.email, role: a.role } });
    }
    if (method !== 'GET') return send(405, { error: 'method not allowed' });
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (!valid.has(token)) return send(401, { error: 'Невалидный или истёкший токен' });
    const email = token.split('-').slice(1, -1).join('-');
    const acc = accounts[email]!;
    const perms = new Set(acc.permissions ?? []);
    const full = acc.role === 'admin' && !acc.roleRef;
    const can = (...p: string[]): boolean => full || p.some((x) => perms.has(x)) || perms.has('pipeline.manage_all');
    if (u.pathname === '/auth/me') return send(200, { id: 'x', email, role: acc.role, roleRef: acc.roleRef, permissions: acc.roleRef ? acc.permissions : undefined });
    if (u.pathname === '/crm/pipelines') return can('pipeline.view_all') || perms.has('pipeline.production.view') ? send(200, pipelines) : send(403, { error: 'Недостаточно прав' });
    const m = u.pathname.match(/^\/crm\/pipelines\/([\w-]+)\/deals$/);
    if (m) return can('pipeline.view_all') ? send(200, deals.filter((d) => d.pipelineId === m[1])) : send(403, { error: 'Недостаточно прав' });
    if (u.pathname === '/crm/tasks') return can('tasks.view_all') ? send(200, tasks) : send(403, { error: 'Недостаточно прав' });
    if (u.pathname === '/crm/team') return can('team.view') ? send(200, team) : send(403, { error: 'Недостаточно прав' });
    if (u.pathname === '/crm/production-orders') return can('pipeline.production.view') ? send(200, production) : send(403, { error: 'Недостаточно прав' });
    if (u.pathname === '/crm/inventory') return can('inventory.view') ? send(200, inventory) : send(403, { error: 'Недостаточно прав' });
    const h = u.pathname.match(/^\/crm\/pipelines\/deals\/([\w-]+)\/history$/);
    if (h) return send(200, [{ id: 'e1', kind: 'stage_change', fromStageName: null, toStageName: 'Новая заявка', note: null, changedBy: anna, createdAt: ago(30) }, { id: 'e2', kind: 'comment', fromStageName: 'Новая заявка', toStageName: 'Новая заявка', note: 'Клиент просил перезвонить +7 905 123 45 67', changedBy: boris, createdAt: ago(12) }]);
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  fx.url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  fx.close = () => new Promise<void>((r) => srv.close(() => r()));
  return fx;
}
