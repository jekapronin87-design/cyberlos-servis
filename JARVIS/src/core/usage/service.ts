import type { Db } from '../db/database';

/** Цены за миллион токенов (USD): вход, выход. Ориентировочные, по семейству модели; кэш: чтение ×0,1, запись ×1,25. */
export const PRICE_TABLE: { match: RegExp; input: number; output: number; label: string }[] = [
  { match: /haiku/i, input: 1, output: 5, label: 'Haiku (самая дешёвая)' },
  { match: /sonnet/i, input: 3, output: 15, label: 'Sonnet' },
  { match: /opus/i, input: 5, output: 25, label: 'Opus (дорогая)' },
  { match: /fable/i, input: 5, output: 25, label: 'Fable' },
];
const DEFAULT_PRICE = { input: 3, output: 15 };

export interface UsageRow {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

export interface UsageSummary {
  today: { usd: number; calls: number; tokens: number };
  month: { usd: number; calls: number; tokens: number };
  rows: UsageRow[];
  /** Дневной лимит, $ (0 — без лимита). */
  budgetUsd: number;
}

export function priceOf(model: string): { input: number; output: number } {
  return PRICE_TABLE.find((p) => p.match.test(model)) ?? DEFAULT_PRICE;
}

export function costUsd(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = priceOf(model);
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25) / 1_000_000;
}

/** Учёт расхода токенов платных моделей. Тексты запросов не хранятся — только числа. */
export class UsageService {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  record(model: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (day, model, calls, input, output, cache_read, cache_write) VALUES (?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
      )
      .run(this.day(), model, u.input, u.output, u.cacheRead ?? 0, u.cacheWrite ?? 0);
  }

  private rows(prefix: string): UsageRow[] {
    const r = this.db.prepare('SELECT model, SUM(calls) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cr, SUM(cache_write) AS cw FROM ai_usage WHERE day LIKE ? GROUP BY model').all(`${prefix}%`) as { model: string; calls: number; input: number; output: number; cr: number; cw: number }[];
    return r.map((x) => ({ model: x.model, calls: x.calls, input: x.input, output: x.output, cacheRead: x.cr, cacheWrite: x.cw, usd: costUsd(x.model, { input: x.input, output: x.output, cacheRead: x.cr, cacheWrite: x.cw }) }));
  }

  todayUsd(): number {
    return this.rows(this.day()).reduce((a, r) => a + r.usd, 0);
  }

  summary(budgetUsd: number): UsageSummary {
    const sum = (rs: UsageRow[]): { usd: number; calls: number; tokens: number } => ({
      usd: Math.round(rs.reduce((a, r) => a + r.usd, 0) * 100) / 100,
      calls: rs.reduce((a, r) => a + r.calls, 0),
      tokens: rs.reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0),
    });
    const month = this.rows(this.day().slice(0, 7));
    return { today: sum(this.rows(this.day())), month: sum(month), rows: month.sort((a, b) => b.usd - a.usd), budgetUsd };
  }
}
