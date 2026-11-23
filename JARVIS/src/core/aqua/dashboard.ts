import type { CrmDashboardDto } from '../../shared/types';

type Get = (path: string, query?: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;

/** Открытые сделки — всё, что не выиграно и не проиграно. */
const OPEN = new Set(['NEW', 'ACTIVE', 'QUALIFIED', 'SCHEDULED']);
const CLOSED_PRODUCTION = /^(DONE|FINISHED|COMPLETED|SHIPPED|CANCELLED|CANCELED)$/i;
/** Сделка «залежалась», если открыта и не менялась дольше этого срока (в живой CRM нет явных SLA стадий — это наш признак простоя). */
export const STUCK_DAYS = 7;
const PAGE = 200;
const MAX_PAGES = 5;
const DAY = 86_400_000;

const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def);
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const rows = (v: unknown): Row[] => (Array.isArray(obj(v)['data']) ? (obj(v)['data'] as Row[]) : []);

/** Читает все страницы списка (до MAX_PAGES). truncated — если страниц было больше. */
async function list(get: Get, path: string, query: Record<string, unknown> = {}): Promise<{ rows: Row[]; truncated: boolean }> {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const r: unknown = await get(path, { ...query, limit: PAGE, ...(cursor ? { cursor } : {}) });
    out.push(...rows(r));
    const next: unknown = obj(r)['nextCursor'];
    cursor = typeof next === 'string' && next ? next : null;
    if (!cursor) return { rows: out, truncated: false };
  }
  return { rows: out, truncated: true };
}

/** Раздел может быть не включён для ключа (403) — тогда его просто нет в сводке, а в `missing` объясняем почему. */
async function optional<T>(name: string, missing: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 404) {
      missing.push(name);
      return fallback;
    }
    throw e;
  }
}

/**
 * Собирает для «Города» и карточек сводку из живой CRM «Аквамастер» (только GET, постранично).
 * Что считается точно: число сделок по воронкам и стадиям, выиграно/проиграно, новые за сутки, без ответственного, задачи (из city/summary),
 * просрочка производства по плановой дате, материалы ниже минимума. «Простой» — открытые сделки без изменений дольше 7 дней.
 */
export async function buildAquaDashboard(get: Get, now: Date): Promise<CrmDashboardDto> {
  const missing: string[] = [];
  let truncated = false;
  const nowMs = now.getTime();

  const deals = await optional('сделки (раздел sales)', missing, async () => {
    const r = await list(get, 'deals');
    truncated = truncated || r.truncated;
    return r.rows;
  }, [] as Row[]);
  const fresh = await optional('новые сделки за сутки', missing, async () => rows(await get('deals', { limit: PAGE, from: new Date(nowMs - DAY).toISOString() })), [] as Row[]);
  const summary = obj(obj(await optional('сводка «Город» (раздел summary)', missing, () => get('city/summary'), {} as unknown))['data']);
  const tasks = await optional('задачи (раздел sales)', missing, async () => (await list(get, 'tasks', { status: 'open' })).rows, [] as Row[]);
  const orders = await optional('производство (раздел production)', missing, async () => {
    const r = await list(get, 'production/orders');
    truncated = truncated || r.truncated;
    return r.rows;
  }, [] as Row[]);
  const employees = await optional('сотрудники (раздел people)', missing, async () => (await list(get, 'employees', { active: 'true' })).rows, [] as Row[]);

  // ---- воронки и стадии ----
  type Stage = { open: number; breaches: number };
  const pipes = new Map<string, { name: string; open: number; won: number; lost: number; stages: Map<string, Stage> }>();
  const issues: CrmDashboardDto['issues'] = [];
  const perUser = new Map<string, { name: string; open: number; stuck: number; tasksOpen: number; tasksOverdue: number }>();
  const user = (id: string, name: string) => {
    let u = perUser.get(id);
    if (!u) perUser.set(id, (u = { name, open: 0, stuck: 0, tasksOpen: 0, tasksOverdue: 0 }));
    return u;
  };
  for (const e of employees) user(str(e['id']), str(e['fullName'], 'Без имени'));

  let stuck = 0;
  let unassigned = 0;
  for (const d of deals) {
    const p = obj(d['pipeline']);
    const st = obj(d['stage']);
    const sem = str(d['stageSemantic'], str(st['semantic']));
    const pid = str(p['id'], 'none');
    const pipe = pipes.get(pid) ?? { name: str(p['name'], 'Без воронки'), open: 0, won: 0, lost: 0, stages: new Map<string, Stage>() };
    pipes.set(pid, pipe);
    const stageName = str(st['name'], '—');
    const stage = pipe.stages.get(stageName) ?? { open: 0, breaches: 0 };
    pipe.stages.set(stageName, stage);
    const asg = obj(d['assignee']);
    const title = str(d['title'], `Сделка ${str(d['number'])}`);
    const id = str(d['id']);
    if (OPEN.has(sem)) {
      pipe.open += 1;
      stage.open += 1;
      const upd = Date.parse(str(d['updatedAt']));
      const isStuck = Number.isFinite(upd) && nowMs - upd > STUCK_DAYS * DAY;
      const who = str(asg['id']) ? user(str(asg['id']), str(asg['fullName'], '—')) : null;
      if (who) who.open += 1;
      if (isStuck) {
        stuck += 1;
        stage.breaches += 1;
        if (who) who.stuck += 1;
        issues.push({ kind: 'stuck', dealId: id, title, pipeline: pipe.name, stage: stageName, who: who ? [who.name] : [], detail: `Не менялась более ${STUCK_DAYS} дней` });
      }
      if (!str(asg['id'])) {
        unassigned += 1;
        issues.push({ kind: 'no_assignee', dealId: id, title, pipeline: pipe.name, stage: stageName, who: [], detail: '' });
      }
    } else if (sem === 'WON') pipe.won += 1;
    else if (sem === 'LOST' || sem === 'JUNK') {
      pipe.lost += 1;
      if (sem === 'LOST' && !str(d['lostReason'])) issues.push({ kind: 'lost_without_reason', dealId: id, title, pipeline: pipe.name, stage: stageName, who: str(asg['fullName']) ? [str(asg['fullName'])] : [], detail: '' });
    }
  }

  // ---- задачи ----
  let tasksOverdueLive = 0;
  for (const t of tasks) {
    const due = Date.parse(str(t['dueAt']));
    const overdue = Number.isFinite(due) && due < nowMs && !t['completedAt'];
    if (overdue) tasksOverdueLive += 1;
    const uid = str(t['assignedUserId']);
    if (uid) {
      const u = user(uid, str(t['assigneeName'], '—'));
      u.tasksOpen += 1;
      if (overdue) u.tasksOverdue += 1;
    }
  }
  const sTasks = obj(summary['tasks']);
  const tasksOpen = typeof sTasks['open'] === 'number' ? (sTasks['open'] as number) : tasks.length;
  const tasksOverdue = typeof sTasks['overdue'] === 'number' ? (sTasks['overdue'] as number) : tasksOverdueLive;

  // ---- производство ----
  let productionOpen = 0;
  let productionOverdue = 0;
  for (const o of orders) {
    if (CLOSED_PRODUCTION.test(str(o['status'])) || o['finishedAt'] || o['cancelledAt']) continue;
    productionOpen += 1;
    const planned = Date.parse(str(o['plannedFor']));
    if (Number.isFinite(planned) && planned < nowMs) {
      productionOverdue += 1;
      issues.push({ kind: 'production_overdue', dealId: str(o['id']), title: `${str(o['productName'], 'Заказ')} №${String(o['number'] ?? '')}`, pipeline: 'Производство', stage: str(o['status']), who: [], detail: 'Плановая дата прошла' });
    }
  }
  if (!orders.length) {
    const by = Array.isArray(obj(summary['production'])['ordersByStatus']) ? (obj(summary['production'])['ordersByStatus'] as Row[]) : [];
    productionOpen = by.filter((x) => !CLOSED_PRODUCTION.test(str(x['status']))).reduce((a, x) => a + (typeof x['count'] === 'number' ? (x['count'] as number) : 0), 0);
  }
  const low = obj(summary['production'])['materialsBelowMinimum'];

  const pipelines = [...pipes.entries()].map(([id, p]) => ({
    name: p.name,
    slug: id,
    open: p.open,
    won: p.won,
    lost: p.lost,
    byStage: [...p.stages.entries()].map(([name, s]) => ({ name, open: s.open, breaches: s.breaches })).filter((s) => s.open > 0 || p.stages.size <= 6),
  }));

  return {
    source: 'aqua',
    overview: {
      pipelines,
      newLast24h: fresh.length,
      unassignedOpen: unassigned,
      stuck,
      tasksOpen,
      tasksOverdue,
      productionOpen,
      productionOverdue,
      awaitingPrepayment: 0,
      lowStock: Array.isArray(low) ? low.length : 0,
    },
    managers: [...perUser.values()]
      .filter((u) => u.open || u.tasksOpen)
      .sort((a, b) => b.open - a.open)
      .map((u) => ({ name: u.name, role: '', openDeals: u.open, stuckDeals: u.stuck, tasksOpen: u.tasksOpen, tasksOverdue: u.tasksOverdue, doneOnTime: 0, doneLate: 0 })),
    issues: issues.slice(0, 300),
    needs: [],
    missing,
    truncated,
    at: now.toISOString(),
  };
}

// ---------- разделы «по нажатию»: что стоит за плиткой или зданием ----------

export interface AquaSection {
  title: string;
  columns: string[];
  rows: string[][];
  total: number;
  note?: string;
}

export type AquaSectionKind = 'production' | 'tasks' | 'stuck' | 'unassigned' | 'lowstock' | 'stage';

const ruDate = (iso: unknown): string => {
  const t = Date.parse(str(iso));
  if (!Number.isFinite(t)) return '—';
  const x = new Date(t);
  return `${String(x.getUTCDate()).padStart(2, '0')}.${String(x.getUTCMonth() + 1).padStart(2, '0')}.${x.getUTCFullYear()}`;
};
const money = (v: unknown): string => (typeof v === 'number' ? `${Math.round(v).toLocaleString('ru-RU')} ₽` : '—');
const SHOW = 60;

/** Строки таблицы для плитки/здания: те же данные, что видит человек в CRM, только читаем. */
export async function buildAquaSection(get: Get, kind: AquaSectionKind, arg: { pipeline?: string; stage?: string }, now: Date): Promise<AquaSection> {
  const nowMs = now.getTime();
  const cut = <T,>(all: T[]): { shown: T[]; note?: string } => ({ shown: all.slice(0, SHOW), note: all.length > SHOW ? `Показано ${SHOW} из ${all.length}.` : undefined });
  const dealRow = (d: Row): string[] => [
    String(d['number'] ?? ''),
    str(d['title'], '—'),
    `${str(obj(d['pipeline'])['name'])} · ${str(obj(d['stage'])['name'])}`,
    str(obj(d['assignee'])['fullName'], 'не назначен'),
    money(d['amountRub']),
    ruDate(d['updatedAt']),
  ];
  const dealCols = ['№', 'Сделка', 'Воронка · стадия', 'Ответственный', 'Сумма', 'Изменена'];

  if (kind === 'production') {
    const all = (await list(get, 'production/orders')).rows.filter((o) => !CLOSED_PRODUCTION.test(str(o['status'])) && !o['finishedAt'] && !o['cancelledAt']);
    all.sort((a, b) => Date.parse(str(a['plannedFor'])) - Date.parse(str(b['plannedFor'])));
    const { shown, note } = cut(all);
    return {
      title: 'Производство: заказы в работе',
      columns: ['№', 'Изделие', 'Статус', 'План', 'Сейчас на этапе', 'Срок'],
      total: all.length,
      note,
      rows: shown.map((o) => {
        const stages = Array.isArray(o['stages']) ? (o['stages'] as Row[]) : [];
        const cur = stages.find((s) => !/^DONE$/i.test(str(s['status'])));
        const planned = Date.parse(str(o['plannedFor']));
        return [String(o['number'] ?? ''), str(o['productName'], '—'), str(o['status']), ruDate(o['plannedFor']), cur ? `${str(cur['name'])}${str(cur['assigneeName']) ? ` (${str(cur['assigneeName'])})` : ''}` : '—', Number.isFinite(planned) && planned < nowMs ? 'просрочено' : 'в срок'];
      }),
    };
  }
  if (kind === 'tasks') {
    const all = (await list(get, 'tasks', { status: 'overdue' })).rows;
    const { shown, note } = cut(all);
    return { title: 'Просроченные задачи', columns: ['Задача', 'Ответственный', 'Срок', 'Тип'], total: all.length, note, rows: shown.map((t) => [str(t['title'], '—'), str(t['assigneeName'], '—'), ruDate(t['dueAt']), str(t['type'])]) };
  }
  if (kind === 'lowstock') {
    const s = obj(obj(await get('city/summary'))['data']);
    const low = Array.isArray(obj(s['production'])['materialsBelowMinimum']) ? (obj(s['production'])['materialsBelowMinimum'] as Row[]) : [];
    return { title: 'Материалы ниже минимума', columns: ['Материал', 'Остаток', 'Минимум', 'Ед.'], total: low.length, rows: low.slice(0, SHOW).map((m) => [str(m['name']), String(m['stockQty'] ?? ''), String(m['minQty'] ?? ''), str(m['unit'])]) };
  }

  const deals = (await list(get, 'deals')).rows;
  if (kind === 'stuck' || kind === 'unassigned') {
    const open = deals.filter((d) => OPEN.has(str(d['stageSemantic'], str(obj(d['stage'])['semantic']))));
    const all = kind === 'stuck' ? open.filter((d) => nowMs - Date.parse(str(d['updatedAt'])) > STUCK_DAYS * DAY) : open.filter((d) => !str(obj(d['assignee'])['id']));
    all.sort((a, b) => Date.parse(str(a['updatedAt'])) - Date.parse(str(b['updatedAt'])));
    const { shown, note } = cut(all);
    return { title: kind === 'stuck' ? `Сделки без движения дольше ${STUCK_DAYS} дней` : 'Сделки без ответственного', columns: dealCols, total: all.length, note, rows: shown.map(dealRow) };
  }
  // stage: все сделки воронки (и стадии, если указана)
  const all = deals.filter((d) => str(obj(d['pipeline'])['name']) === arg.pipeline && (!arg.stage || str(obj(d['stage'])['name']) === arg.stage));
  all.sort((a, b) => Date.parse(str(b['updatedAt'])) - Date.parse(str(a['updatedAt'])));
  const { shown, note } = cut(all);
  return { title: `${arg.pipeline ?? 'Воронка'}${arg.stage ? ' · ' + arg.stage : ''}`, columns: dealCols, total: all.length, note, rows: shown.map(dealRow) };
}
