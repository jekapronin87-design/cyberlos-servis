import type { ChatEvent } from '../../shared/types';
import type { ConversationRepo } from '../db/repositories';
import type { ProviderManager } from '../providers/manager';
import type { SettingsRepo } from '../db/repositories';
import type { AuditLog } from '../security/audit';
import { JobRepo, type Job, type JobStatus } from './jobs';

/** Запуски, пропущенные дольше этого (компьютер был выключен), не выполняются «задним числом». */
export const CATCHUP_MS = 12 * 3_600_000;
export const JOB_TIMEOUT_MS = 5 * 60_000;
export const JOB_MAX_STEPS = 6;

export interface JobResultEvent {
  job: Job;
  status: JobStatus;
  summary: string;
  /** Итог — «всё спокойно» (OK): уведомление не показывается. */
  quiet: boolean;
}

export interface SchedulerDeps {
  jobs: JobRepo;
  conversations: ConversationRepo;
  settings: SettingsRepo;
  providers: ProviderManager;
  audit: AuditLog;
  /** Запуск диалога в фоновом режиме (ChatOrchestrator.run). */
  run: (conversationId: number, text: string, emit: (e: ChatEvent) => void, signal: AbortSignal, opts: { background: boolean; maxSteps: number }) => Promise<void>;
  notify: (e: JobResultEvent) => void;
  now?: () => Date;
  timeoutMs?: number;
}

const PREFIX =
  '[Фоновая задача по расписанию. Пользователя рядом нет: действия, требующие подтверждения, недоступны. ' +
  'Если ничего важного нет — ответь одним словом «OK». Иначе — короткий итог (до 5 предложений) и что стоит сделать.]\n\n';

const QUIET = /^\s*(ok|ок|ничего критичного|всё спокойно|все спокойно)[\s.!]*$/i;

/**
 * Планировщик: раз в полминуты проверяет задачи и выполняет подошедшие — по одной за раз.
 * Работает только пока JARVIS запущен. В фоне ассистент может лишь читать и анализировать (всё, что требует
 * подтверждения, отклоняется), каждый запуск ограничен 6 шагами и 5 минутами, «Стоп» прерывает его.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: { jobId: number; ctrl: AbortController } | null = null;

  constructor(private d: SchedulerDeps) {}

  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort();
  }

  abort(): void {
    this.running?.ctrl.abort();
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Один проход: выполнить самую раннюю из подошедших задач. */
  async tick(now: Date = this.now()): Promise<void> {
    if (this.running) return;
    const due = this.d.jobs
      .list()
      .filter((j) => j.enabled && j.nextRunAt && new Date(j.nextRunAt).getTime() <= now.getTime())
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
    for (const job of due) {
      if (now.getTime() - new Date(job.nextRunAt!).getTime() > CATCHUP_MS) {
        // Компьютер долго был выключен — не выполняем «вчерашнее», просто планируем следующий запуск.
        this.d.audit.record({ actor: 'system', action: 'job.skipped_missed', target: String(job.id), decision: 'info', details: { title: job.title } });
        this.d.jobs.reschedule(job.id, now);
        continue;
      }
      await this.execute(job.id);
      return;
    }
  }

  /** Запустить сейчас (кнопка «Выполнить сейчас»). */
  async runNow(id: number): Promise<JobResultEvent> {
    if (this.running) throw new Error('Уже выполняется другая задача — дождитесь окончания или нажмите «Стоп».');
    return this.execute(id);
  }

  private async execute(id: number): Promise<JobResultEvent> {
    const job = this.d.jobs.get(id);
    if (!job) throw new Error('Задача не найдена');
    const started = this.now();
    const ctrl = new AbortController();
    this.running = { jobId: id, ctrl };
    const timeout = setTimeout(() => ctrl.abort(), this.d.timeoutMs ?? JOB_TIMEOUT_MS);
    let status: JobStatus = 'ok';
    let summary = '';
    try {
      const resolved = this.d.providers.resolve(this.d.settings.get());
      if (resolved.mode !== 'live') {
        status = 'error';
        summary = 'Для задач по расписанию нужна модель Claude: введите ключ в «Настройках».';
      } else {
        let convId = job.conversationId;
        if (!convId || !this.d.conversations.get(convId)) {
          convId = this.d.conversations.create(`⏱ ${job.title}`).id;
          this.d.jobs.setConversation(id, convId);
        }
        this.d.audit.record({ actor: 'system', action: 'job.start', target: String(id), decision: 'info', details: { title: job.title } });
        const out = { lastText: '', failure: '', finished: 'done' as 'done' | 'stopped' | 'error' };
        await this.d.run(
          convId,
          PREFIX + job.prompt,
          (e) => {
            if (e.type === 'message' && e.message.role === 'assistant') {
              const t = e.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
              if (t) out.lastText = t;
            } else if (e.type === 'run_finished') {
              out.finished = e.status;
              out.failure = e.error ?? '';
            }
          },
          ctrl.signal,
          { background: true, maxSteps: JOB_MAX_STEPS },
        );
        summary = out.lastText;
        if (out.finished === 'stopped') {
          status = 'stopped';
          summary ||= 'Остановлено (кнопка «Стоп» или таймаут 5 минут).';
        } else if (out.finished === 'error') {
          status = 'error';
          summary = out.failure || 'Ошибка выполнения';
        } else if (!summary) {
          summary = 'Задача выполнена, текстового итога нет.';
        }
      }
    } catch (e) {
      status = 'error';
      summary = e instanceof Error ? e.message : 'Ошибка выполнения';
    } finally {
      clearTimeout(timeout);
      this.running = null;
    }
    const done = this.d.jobs.finish(id, status, summary, started, this.now());
    this.d.audit.record({ actor: 'system', action: 'job.finish', target: String(id), decision: status === 'ok' ? 'info' : 'error', details: { status } });
    const ev: JobResultEvent = { job: done, status, summary, quiet: status === 'ok' && QUIET.test(summary) };
    if (done.notify && !ev.quiet) this.d.notify(ev);
    return ev;
  }
}
