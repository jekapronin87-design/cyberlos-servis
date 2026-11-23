import { describe, expect, it } from 'vitest';
import { buildAquaDashboard } from '../src/core/aqua/dashboard';
import { makeCore } from './helpers';

const NOW = new Date('2026-11-23T08:00:00.000Z');
const d = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const U1 = { id: 'u1', fullName: 'Иван Петров' };
const U2 = { id: 'u2', fullName: 'Анна Смирнова' };

const deal = (id: string, pipe: string, stage: string, sem: string, assignee: typeof U1 | null, updatedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  number: Number(id.slice(1)),
  title: `Сделка ${id}`,
  stageSemantic: sem,
  lostReason: null,
  createdAt: d(30),
  updatedAt: d(updatedDaysAgo),
  pipeline: { id: `p-${pipe}`, name: pipe },
  stage: { id: `s-${stage}`, name: stage, semantic: sem },
  assignee,
  ...extra,
});

const DEALS = [
  deal('d1', 'Продажа', 'КП', 'ACTIVE', U1, 1),
  deal('d2', 'Продажа', 'КП', 'ACTIVE', U1, 10), // залежалась
  deal('d3', 'Продажа', 'Новый', 'NEW', null, 0), // без ответственного
  deal('d4', 'Продажа', 'Выиграно', 'WON', U2, 5),
  deal('d5', 'Продажа', 'Отказ', 'LOST', U2, 5), // отказ без причины
  deal('d6', 'Сервис', 'Заявка', 'ACTIVE', U2, 2),
];

function fakeGet(opts: { forbid?: string[]; pages?: boolean } = {}) {
  const calls: { path: string; query: Record<string, unknown> }[] = [];
  const get = async (path: string, query: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ path, query });
    if (opts.forbid?.includes(path)) throw Object.assign(new Error('403'), { status: 403 });
    switch (path) {
      case 'deals': {
        if (query['from']) return { ok: true, count: 1, nextCursor: null, data: [DEALS[2]] }; // «новые за сутки»
        if (opts.pages && !query['cursor']) return { ok: true, count: 3, nextCursor: 'c1', data: DEALS.slice(0, 3) };
        if (opts.pages) return { ok: true, count: 3, nextCursor: null, data: DEALS.slice(3) };
        return { ok: true, count: DEALS.length, nextCursor: null, data: DEALS };
      }
      case 'city/summary':
        return { ok: true, data: { tasks: { open: 14, overdue: 3 }, production: { ordersByStatus: [{ status: 'IN_PROGRESS', count: 4 }], materialsBelowMinimum: [{ name: 'Лист', stockQty: 1, minQty: 5, unit: 'шт' }] } } };
      case 'tasks':
        return { ok: true, count: 2, nextCursor: null, data: [
          { id: 't1', dueAt: d(1), completedAt: null, assignedUserId: 'u1', assigneeName: 'Иван Петров' },
          { id: 't2', dueAt: d(-2), completedAt: null, assignedUserId: 'u2', assigneeName: 'Анна Смирнова' },
        ] };
      case 'production/orders':
        return { ok: true, count: 3, nextCursor: null, data: [
          { id: 'o1', number: 1, productName: 'Сайберлос 15', status: 'IN_PROGRESS', plannedFor: d(3), finishedAt: null, cancelledAt: null },
          { id: 'o2', number: 2, productName: 'Сайберлос 10', status: 'IN_PROGRESS', plannedFor: d(-5), finishedAt: null, cancelledAt: null },
          { id: 'o3', number: 3, productName: 'Сайберлос 5', status: 'DONE', plannedFor: d(10), finishedAt: d(8), cancelledAt: null },
        ] };
      case 'employees':
        return { ok: true, count: 3, nextCursor: null, data: [U1, U2, { id: 'u3', fullName: 'Без сделок' }] };
    }
    throw Object.assign(new Error('404'), { status: 404 });
  };
  return { get, calls };
}

describe('Аквамастер: сводка для «Города»', () => {
  it('считает воронки, стадии, простой, без ответственного, задачи, производство и менеджеров', async () => {
    const dash = await buildAquaDashboard(fakeGet().get, NOW);
    expect(dash.source).toBe('aqua');
    const sale = dash.overview.pipelines.find((p) => p.name === 'Продажа')!;
    expect(sale).toMatchObject({ open: 3, won: 1, lost: 1 });
    expect(sale.byStage.find((s) => s.name === 'КП')).toEqual({ name: 'КП', open: 2, breaches: 1 });
    expect(dash.overview.pipelines.find((p) => p.name === 'Сервис')!.open).toBe(1);
    expect(dash.overview).toMatchObject({ newLast24h: 1, unassignedOpen: 1, stuck: 1, tasksOpen: 14, tasksOverdue: 3, productionOpen: 2, productionOverdue: 1, lowStock: 1 });
    const mgr = Object.fromEntries(dash.managers.map((m) => [m.name, m]));
    expect(mgr['Иван Петров']).toMatchObject({ openDeals: 2, stuckDeals: 1, tasksOpen: 1, tasksOverdue: 1 });
    expect(mgr['Анна Смирнова']).toMatchObject({ openDeals: 1, tasksOpen: 1, tasksOverdue: 0 });
    expect(mgr['Без сделок']).toBeUndefined();
    const kinds = dash.issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(['lost_without_reason', 'no_assignee', 'production_overdue', 'stuck']);
    expect(dash.missing).toEqual([]);
    expect(dash.truncated).toBe(false);
  });

  it('листает страницы сделок; без раздела (403) — сводка строится, а в missing объяснено чего нет', async () => {
    const f = fakeGet({ pages: true });
    const dash = await buildAquaDashboard(f.get, NOW);
    expect(dash.overview.pipelines.find((p) => p.name === 'Продажа')!.open).toBe(3);
    expect(f.calls.some((c) => c.path === 'deals' && c.query['cursor'] === 'c1')).toBe(true);
    const g = fakeGet({ forbid: ['production/orders', 'employees'] });
    const d2 = await buildAquaDashboard(g.get, NOW);
    expect(d2.missing.join('|')).toMatch(/производство.*сотрудники|сотрудники.*производство/);
    expect(d2.overview.productionOpen).toBe(4); // из city/summary
    expect(d2.managers.length).toBeGreaterThan(0);
  });

  it('другие ошибки (например, лимит запросов) не скрываются', async () => {
    await expect(buildAquaDashboard(async () => { throw Object.assign(new Error('429'), { status: 429 }); }, NOW)).rejects.toThrow('429');
  });

  it('через сервис: только GET /api/readonly, ключ не нужен для сборки без ключа — понятная ошибка', async () => {
    const urls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      urls.push(`${init.method} ${new URL(url).pathname}`);
      const p = new URL(url).pathname.replace('/api/readonly/', '');
      const body = p === 'deals' ? { ok: true, count: 0, nextCursor: null, data: [] } : p === 'city/summary' ? { ok: true, data: {} } : { ok: true, count: 0, nextCursor: null, data: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const h = makeCore({ crmFetch: f });
    await expect(h.core.aquaDashboard()).rejects.toThrow(/не подключена/);
    h.core.aquaSave({ baseUrl: '', maskPii: true }, 'sro_TestKey1234567890abcdefghijklmnop');
    const dash = await h.core.aquaDashboard();
    expect(dash.source).toBe('aqua');
    expect(urls.length).toBeGreaterThan(3);
    expect(urls.every((u) => u.startsWith('GET /api/readonly/'))).toBe(true);
    const n = urls.length;
    await h.core.aquaDashboard(); // кэш 60 с — лимит CRM не расходуется
    expect(urls.length).toBe(n);
  });

  it('через сервис с включённым маскированием даты не портятся: простой считается верно', async () => {
    const old = new Date(Date.now() - 12 * 86_400_000).toISOString();
    const f = (async (url: string) => {
      const p = new URL(url).pathname.replace('/api/readonly/', '');
      const data = p === 'deals' ? [{ id: 'd1', title: 'Иванов +7 912 345-67-89', stageSemantic: 'ACTIVE', updatedAt: old, pipeline: { id: 'p', name: 'Продажа' }, stage: { name: 'КП', semantic: 'ACTIVE' }, assignee: { id: 'u1', fullName: 'Иван' } }] : [];
      return new Response(JSON.stringify(p === 'city/summary' ? { ok: true, data: {} } : { ok: true, count: data.length, nextCursor: null, data }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = makeCore({ crmFetch: f });
    h.core.aquaSave({ baseUrl: '', maskPii: true }, 'sro_TestKey1234567890abcdefghijklmnop');
    const dash = await h.core.aquaDashboard();
    expect(dash.overview.stuck).toBe(1);
    expect(JSON.stringify(dash)).not.toContain('345-67-89');
  });
});
