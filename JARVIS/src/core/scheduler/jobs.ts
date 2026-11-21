import { nowIso, type Db } from '../db/database';

export type JobKind = 'daily' | 'weekdays' | 'interval' | 'once';
export type JobStatus = 'ok' | 'error' | 'stopped' | 'skipped';

export interface Job {
  id: number;
  title: string;
  prompt: string;
  kind: JobKind;
  atTime: string | null;
  intervalMin: number | null;
  runAt: string | null;
  enabled: boolean;
  notify: boolean;
  speak: boolean;
  conversationId: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: JobStatus | null;
  lastSummary: string | null;
  createdAt: string;
}

export interface JobInput {
  title: string;
  prompt: string;
  kind: JobKind;
  atTime?: string | null;
  intervalMin?: number | null;
  runAt?: string | null;
  notify?: boolean;
  speak?: boolean;
}

export const MIN_INTERVAL = 5;
export const MAX_JOBS = 30;

export function validateJob(i: JobInput): Required<Pick<JobInput, 'title' | 'prompt' | 'kind'>> & { atTime: string | null; intervalMin: number | null; runAt: string | null; notify: boolean; speak: boolean } {
  const title = String(i.title ?? '').trim();
  const prompt = String(i.prompt ?? '').trim();
  if (!title || title.length > 80) throw new Error('Название: от 1 до 80 символов');
  if (!prompt || prompt.length > 2000) throw new Error('Текст задачи: от 1 до 2000 символов');
  if (!['daily', 'weekdays', 'interval', 'once'].includes(i.kind)) throw new Error('Неизвестный тип расписания');
  let atTime: string | null = null;
  let intervalMin: number | null = null;
  let runAt: string | null = null;
  if (i.kind === 'daily' || i.kind === 'weekdays') {
    if (typeof i.atTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(i.atTime)) throw new Error('Время: формат ЧЧ:ММ, например 09:00');
    atTime = i.atTime;
  } else if (i.kind === 'interval') {
    if (!Number.isInteger(i.intervalMin) || (i.intervalMin as number) < MIN_INTERVAL || (i.intervalMin as number) > 1440) throw new Error(`Интервал: от ${MIN_INTERVAL} до 1440 минут`);
    intervalMin = i.intervalMin as number;
  } else {
    const d = new Date(String(i.runAt));
    if (!i.runAt || Number.isNaN(d.getTime())) throw new Error('Некорректная дата запуска');
    runAt = d.toISOString();
  }
  return { title, prompt, kind: i.kind, atTime, intervalMin, runAt, notify: i.notify !== false, speak: i.speak === true };
}

/**
 * Следующий запуск строго после `from` (локальное время компьютера).
 * daily — каждый день в HH:MM, weekdays — по будням (пн–пт), interval — каждые N минут, once — один раз.
 */
export function computeNext(job: Pick<Job, 'kind' | 'atTime' | 'intervalMin' | 'runAt'>, from: Date): Date | null {
  if (job.kind === 'once') {
    const d = new Date(job.runAt ?? '');
    return d.getTime() > from.getTime() ? d : null;
  }
  if (job.kind === 'interval') return new Date(from.getTime() + (job.intervalMin ?? 60) * 60_000);
  const [h, m] = (job.atTime ?? '09:00').split(':').map(Number) as [number, number];
  for (let add = 0; add < 8; add++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add, h, m, 0, 0);
    if (d.getTime() <= from.getTime()) continue;
    if (job.kind === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
    return d;
  }
  return null;
}

interface Row {
  id: number; title: string; prompt: string; kind: JobKind; at_time: string | null; interval_min: number | null; run_at: string | null;
  enabled: number; notify: number; speak: number; conversation_id: number | null; next_run_at: string | null; last_run_at: string | null;
  last_status: JobStatus | null; last_summary: string | null; created_at: string;
}

const toJob = (r: Row): Job => ({
  id: r.id, title: r.title, prompt: r.prompt, kind: r.kind, atTime: r.at_time, intervalMin: r.interval_min, runAt: r.run_at,
  enabled: !!r.enabled, notify: !!r.notify, speak: !!r.speak, conversationId: r.conversation_id, nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at, lastStatus: r.last_status, lastSummary: r.last_summary, createdAt: r.created_at,
});

export class JobRepo {
  constructor(private db: Db) {}

  list(): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY id').all() as unknown as Row[]).map(toJob);
  }
  get(id: number): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toJob(r) : null;
  }
  create(input: JobInput, now = new Date()): Job {
    if (this.list().length >= MAX_JOBS) throw new Error(`Не больше ${MAX_JOBS} задач`);
    const v = validateJob(input);
    const next = computeNext({ kind: v.kind, atTime: v.atTime, intervalMin: v.intervalMin, runAt: v.runAt }, now);
    if (v.kind === 'once' && !next) throw new Error('Время запуска уже прошло');
    const res = this.db
      .prepare(`INSERT INTO jobs (title, prompt, kind, at_time, interval_min, run_at, notify, speak, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(v.title, v.prompt, v.kind, v.atTime, v.intervalMin, v.runAt, v.notify ? 1 : 0, v.speak ? 1 : 0, next?.toISOString() ?? null, nowIso());
    return this.get(Number(res.lastInsertRowid))!;
  }
  setEnabled(id: number, enabled: boolean, now = new Date()): Job {
    const j = this.get(id);
    if (!j) throw new Error('Задача не найдена');
    const next = enabled ? computeNext(j, now) : null;
    this.db.prepare('UPDATE jobs SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, next?.toISOString() ?? null, id);
    return this.get(id)!;
  }
  remove(id: number): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }
  setConversation(id: number, conversationId: number): void {
    this.db.prepare('UPDATE jobs SET conversation_id = ? WHERE id = ?').run(conversationId, id);
  }
  /** Фиксирует итог запуска и планирует следующий (или выключает разовую). */
  finish(id: number, status: JobStatus, summary: string, startedAt: Date, now = new Date()): Job {
    const j = this.get(id)!;
    const next = computeNext(j, now);
    this.db
      .prepare('UPDATE jobs SET last_run_at = ?, last_status = ?, last_summary = ?, next_run_at = ?, enabled = ? WHERE id = ?')
      .run(startedAt.toISOString(), status, summary.slice(0, 2000), next?.toISOString() ?? null, j.kind === 'once' ? 0 : j.enabled ? 1 : 0, id);
    this.db.prepare('INSERT INTO job_runs (job_id, started_at, finished_at, status, summary) VALUES (?, ?, ?, ?, ?)').run(id, startedAt.toISOString(), now.toISOString(), status, summary.slice(0, 2000));
    this.db.prepare('DELETE FROM job_runs WHERE job_id = ? AND id NOT IN (SELECT id FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 30)').run(id, id);
    return this.get(id)!;
  }
  /** Пересчитывает ближайший запуск без выполнения (пропуск давно прошедших). */
  reschedule(id: number, now = new Date()): void {
    const j = this.get(id)!;
    const next = computeNext(j, now);
    this.db.prepare('UPDATE jobs SET next_run_at = ?, enabled = ? WHERE id = ?').run(next?.toISOString() ?? null, j.kind === 'once' && !next ? 0 : j.enabled ? 1 : 0, id);
  }
  runs(id: number): { startedAt: string; status: JobStatus; summary: string | null }[] {
    return (this.db.prepare('SELECT started_at, status, summary FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 10').all(id) as { started_at: string; status: JobStatus; summary: string | null }[]).map((r) => ({ startedAt: r.started_at, status: r.status, summary: r.summary }));
  }
}
