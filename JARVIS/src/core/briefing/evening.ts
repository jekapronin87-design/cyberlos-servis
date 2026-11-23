import type { EveningData } from '../../shared/deck';
import { dayBounds, zonedParts } from './rules';

type Get = (path: string, query?: Record<string, unknown>) => Promise<unknown>;
type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const DAY = 86_400_000;
const WEEKDAY = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

async function pages(get: Get, path: string, query: Record<string, unknown> = {}, max = 5): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < max; n++) {
    const r: unknown = await get(path, { ...query, limit: 200, ...(cursor ? { cursor } : {}) });
    const d = obj(r)['data'];
    if (Array.isArray(d)) out.push(...(d as Row[]));
    const next: unknown = obj(r)['nextCursor'];
    cursor = typeof next === 'string' && next ? next : null;
    if (!cursor) break;
  }
  return out;
}
/** Раздел можно не включить для ключа (403) или он ещё не готов (404) — тогда это место в отчёте просто пустое, а причина попадает в missing. */
async function opt<T>(name: string, missing: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const st = (e as { status?: number }).status;
    missing.push(`${name}: ${st === 403 ? 'раздел не включён для ключа' : st === 404 ? 'CRM пока этого не отдаёт' : (e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
    return fallback;
  }
}

/**
 * Итоги дня из живой CRM «Аквамастер» (только чтение). «Сегодня» — календарные сутки в часовом поясе пользователя.
 * Дата выигрыша берётся из wonAt/closedAt, а если их нет — из даты последнего изменения выигранной сделки (приблизительно).
 */
export async function buildEveningData(get: Get, now: Date, tz: string, missing: string[]): Promise<EveningData> {
  const key = (ts: unknown): string => {
    const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
    return Number.isFinite(t) ? zonedParts(new Date(t), tz).date : '';
  };
  const days: string[] = [];
  const labels: string[] = [];
  for (let k = 6; k >= 0; k--) {
    const d = new Date(now.getTime() - k * DAY);
    const dk = zonedParts(d, tz).date;
    if (days.includes(dk)) continue;
    days.push(dk);
    labels.push(`${WEEKDAY[new Date(`${dk}T12:00:00Z`).getUTCDay()]} ${Number(dk.slice(8))}`);
  }
  const todayKey = days[days.length - 1]!;

  const deals = await opt('сделки', missing, () => pages(get, 'deals', {}, 5), [] as Row[]);
  const newPerDay = days.map(() => 0);
  const wonPerDay = days.map(() => 0);
  let lost = 0;
  let wonRub = 0;
  for (const d of deals) {
    const ci = days.indexOf(key(d['createdAt']));
    if (ci >= 0) newPerDay[ci]! += 1;
    const sem = str(d['stageSemantic']) || str(obj(d['stage'])['semantic']);
    const when = key(d['wonAt'] ?? d['closedAt'] ?? d['updatedAt']);
    if (sem === 'WON') {
      const wi = days.indexOf(when);
      if (wi >= 0) {
        wonPerDay[wi]! += 1;
        if (when === todayKey) wonRub += num(d['amountRub']);
      }
    } else if (sem === 'LOST' && when === todayKey) lost += 1;
  }

  const b = dayBounds(now, tz);
  const tasksRows = await opt('закрытые задачи', missing, () => pages(get, 'tasks', { status: 'done', completedFrom: b.from.toISOString(), completedTo: b.to.toISOString() }, 3), null as Row[] | null);
  const calls = await opt('звонки', missing, () => pages(get, 'calls', { from: b.from.toISOString(), to: b.to.toISOString() }, 3), null as Row[] | null);
  const orders = await opt('производство', missing, () => pages(get, 'production/orders', {}, 3), null as Row[] | null);

  const callsToday = calls?.filter((c) => key(c['startedAt'] ?? c['calledAt'] ?? c['createdAt']) === todayKey);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const prevN = Math.max(1, days.length - 1);
  return {
    dayLabels: labels,
    today: {
      newDeals: newPerDay[days.length - 1]!,
      won: wonPerDay[days.length - 1]!,
      wonRub,
      lost,
      tasksDone: tasksRows ? tasksRows.filter((t) => key(t['completedAt']) === todayKey).length : null,
      calls: callsToday ? { in: callsToday.filter((c) => /^in/i.test(str(c['direction']))).length, out: callsToday.filter((c) => /^out/i.test(str(c['direction']))).length } : null,
      productionDone: orders ? orders.filter((o) => key(o['finishedAt']) === todayKey).length : null,
    },
    week: { newPerDay, wonPerDay },
    avg: { newPerDay: sum(newPerDay.slice(0, -1)) / prevN, wonPerDay: sum(wonPerDay.slice(0, -1)) / prevN },
  };
}

/** Сегодняшние показатели клуба: из club/funnel.today (если CRM их отдаёт) и списка оплат club/payments. */
export async function buildClubToday(get: Get, now: Date, tz: string, funnelToday: unknown): Promise<{ joined: number; paid: number; paidRub: number; payments?: { who: string; amountRub: number }[] } | undefined> {
  const todayKey = zonedParts(now, tz).date;
  const key = (ts: unknown): string => (typeof ts === 'string' && Number.isFinite(Date.parse(ts)) ? zonedParts(new Date(ts), tz).date : '');
  const f = obj(funnelToday);
  let payments: { who: string; amountRub: number }[] | undefined;
  try {
    const b = dayBounds(now, tz);
    const rows = await pages(get, 'club/payments', { from: b.from.toISOString(), to: b.to.toISOString() }, 2);
    payments = rows.filter((p) => key(p['paidAt']) === todayKey).map((p) => ({ who: str(p['memberName']) || str(obj(p['member'])['name']) || 'Участник', amountRub: num(p['amountRub']) }));
  } catch {
    /* списка оплат у CRM может ещё не быть */
  }
  if (f['joined'] !== undefined || f['paid'] !== undefined) return { joined: num(f['joined']), paid: num(f['paid']), paidRub: num(f['paidRub']), payments: payments?.length ? payments : undefined };
  if (payments) return { joined: 0, paid: payments.length, paidRub: payments.reduce((a, p) => a + p.amountRub, 0), payments: payments.length ? payments : undefined };
  return undefined;
}
