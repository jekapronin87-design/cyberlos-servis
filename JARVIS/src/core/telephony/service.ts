import type { CallDto, CallStateDto, ConsentDto } from '../../shared/types';
import { nowIso, type Db } from '../db/database';
import type { SettingsRepo } from '../db/repositories';
import { COURSES } from '../mentor/courses';
import type { MentorService } from '../mentor/service';
import type { AuditLog } from '../security/audit';
import type { ToolRegistry } from '../tools/registry';
import { checkCallAllowed, maskPhone, normalizePhone } from './policy';
import { SimulatorProvider, type TelephonyProvider } from './provider';
import { runScript, type CallOutcome } from './script';

const MAX_CALL_MS = 15 * 60_000;

interface ConsentRow {
  id: number; phone: string; name: string; email: string; training: number; recording: number; granted_at: string; revoked_at: string | null; source: string;
}
interface CallRow {
  id: number; phone: string; name: string; course_id: string; lesson_id: string; provider: string; started_at: string; ended_at: string | null; status: string; correct: number; total: number; recorded: number; transcript: string | null; summary: string | null;
}

const STATUS_RU: Record<string, string> = {
  running: 'идёт',
  completed: 'урок пройден',
  declined: 'отказался разговаривать',
  opted_out: 'просил больше не звонить',
  no_answer: 'не ответил',
  stopped: 'остановил разговор',
  hung_up: 'завершён',
  error: 'ошибка',
};

interface Live {
  lines: CallStateDto['lines'];
  ctrl: AbortController;
  done: Promise<void>;
  provider: TelephonyProvider;
}

/**
 * Телефония (каркас). Правила: звонок возможен только сотруднику с записанным согласием, только в разрешённое время и в пределах лимитов;
 * в начале звонка ИИ представляется; запись и текст разговора сохраняются ТОЛЬКО при отдельном согласии на запись; в CRM ничего не пишется.
 */
export class TelephonyService {
  private live = new Map<number, Live>();
  readonly simulator = new SimulatorProvider();
  private provider: TelephonyProvider = this.simulator;

  constructor(
    private db: Db,
    private settings: SettingsRepo,
    private audit: AuditLog,
    private mentor: MentorService,
    private now: () => Date = () => new Date(),
    private hearTimeoutMs = 5 * 60_000,
  ) {}

  /** Подключить настоящего оператора (отдельный модуль). Звонки через него разрешены только при явной настройке. */
  setProvider(p: TelephonyProvider): void {
    this.provider = p;
  }

  status(): { provider: string; real: boolean; note: string } {
    return {
      provider: this.provider.name,
      real: this.provider.real,
      note: this.provider.real
        ? 'Подключён реальный оператор связи.'
        : 'Реальные звонки не подключены: работает тренажёр-симулятор (разговор ведётся в окне JARVIS). Чтобы звонить на настоящие номера, нужен оператор связи и отдельная доработка.',
    };
  }

  // ----- согласия -----
  private consentDto(r: ConsentRow): ConsentDto {
    return { id: r.id, phone: r.phone, name: r.name, email: r.email, training: r.training === 1, recording: r.recording === 1, grantedAt: r.granted_at, revokedAt: r.revoked_at, source: r.source };
  }

  private consentRow(phone: string): ConsentRow | undefined {
    return this.db.prepare('SELECT * FROM consents WHERE phone = ?').get(phone) as unknown as ConsentRow | undefined;
  }

  listConsents(): ConsentDto[] {
    return (this.db.prepare('SELECT * FROM consents ORDER BY id DESC').all() as unknown as ConsentRow[]).map((r) => this.consentDto(r));
  }

  /** Внести согласие. confirmed=true означает: сотрудник действительно дал согласие (устно/письменно), это записывает руководитель. */
  grantConsent(i: { phone: string; name: string; email?: string; recording?: boolean; source?: string; confirmed: boolean }): ConsentDto {
    if (i.confirmed !== true) throw new Error('Подтвердите, что сотрудник дал согласие на учебные звонки ИИ-наставника.');
    const phone = normalizePhone(i.phone);
    if (!phone) throw new Error('Некорректный номер телефона');
    const name = i.name.trim().slice(0, 80);
    if (!name) throw new Error('Укажите имя сотрудника');
    const email = (i.email ?? '').trim().toLowerCase().slice(0, 200);
    const source = (i.source ?? '').trim().slice(0, 200);
    const t = nowIso();
    this.db
      .prepare(
        `INSERT INTO consents (phone, name, email, training, recording, granted_at, revoked_at, source) VALUES (?, ?, ?, 1, ?, ?, NULL, ?)
         ON CONFLICT(phone) DO UPDATE SET name = excluded.name, email = excluded.email, training = 1, recording = excluded.recording, granted_at = excluded.granted_at, revoked_at = NULL, source = excluded.source`,
      )
      .run(phone, name, email, i.recording ? 1 : 0, t, source);
    this.audit.record({ actor: 'user', action: 'telephony.consent_granted', target: maskPhone(phone), decision: 'info', details: { recording: i.recording === true } });
    return this.consentDto(this.consentRow(phone)!);
  }

  revokeConsent(phone: string): void {
    const p = normalizePhone(phone);
    if (!p || !this.consentRow(p)) throw new Error('Согласие не найдено');
    this.db.prepare('UPDATE consents SET revoked_at = ?, recording = 0 WHERE phone = ?').run(nowIso(), p);
    this.audit.record({ actor: 'user', action: 'telephony.consent_revoked', target: maskPhone(p), decision: 'info' });
  }

  // ----- звонки -----
  private countCalls(phone?: string): number {
    const d = this.now();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    const r = phone
      ? this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE started_at >= ? AND phone = ?').get(start, phone)
      : this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE started_at >= ?').get(start);
    return (r as { n: number }).n;
  }

  /** Проверка без звонка — для подсказки в окне. */
  canCall(phone: string): { ok: boolean; reason?: string } {
    const p = normalizePhone(phone);
    if (!p) return { ok: false, reason: 'Некорректный номер телефона' };
    const c = this.consentRow(p);
    const r = checkCallAllowed({
      consent: c ? { training: c.training === 1, revokedAt: c.revoked_at } : null,
      settings: this.settings.get(),
      now: this.now(),
      callsToday: this.countCalls(),
      callsTodayToNumber: this.countCalls(p),
    });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  startCall(i: { phone: string; courseId: string; lessonId: string }): { callId: number } {
    if (this.provider.real) throw new Error('Реальные звонки пока не разрешены в этой версии.');
    const p = normalizePhone(i.phone);
    const check = this.canCall(i.phone);
    if (!check.ok || !p) {
      this.audit.record({ actor: 'user', action: 'telephony.call_denied', target: p ? maskPhone(p) : '?', decision: 'denied', details: { reason: check.reason } });
      throw new Error(check.reason ?? 'Звонок невозможен');
    }
    const lesson = COURSES.find((c) => c.id === i.courseId)?.lessons.find((l) => l.id === i.lessonId);
    if (!lesson) throw new Error('Урок не найден');
    const consent = this.consentRow(p)!;
    const recording = consent.recording === 1;
    const r = this.db
      .prepare('INSERT INTO calls (phone, name, course_id, lesson_id, provider, started_at, status, recorded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p, consent.name, i.courseId, i.lessonId, this.provider.id, nowIso(), 'running', recording ? 1 : 0);
    const callId = Number(r.lastInsertRowid);
    this.audit.record({ actor: 'user', action: 'telephony.call_started', target: maskPhone(p), decision: 'info', details: { callId, courseId: i.courseId, lessonId: i.lessonId, provider: this.provider.id, recording } });

    const ctrl = new AbortController();
    const live: Live = { lines: [], ctrl, provider: this.provider, done: Promise.resolve() };
    this.live.set(callId, live);
    const timer = setTimeout(() => ctrl.abort(), MAX_CALL_MS);
    live.done = (async () => {
      let outcome: CallOutcome | 'error' = 'error';
      let correct = 0;
      let total = 0;
      try {
        const line = await this.provider.dial(p, callId);
        ctrl.signal.addEventListener('abort', () => line.hangup(), { once: true });
        const res = await runScript({
          line,
          signal: ctrl.signal,
          lesson,
          name: consent.name.split(/\s+/)[0] ?? '',
          recording,
          hearTimeoutMs: this.hearTimeoutMs,
          log: (who, text) => live.lines.push({ who, text }),
        });
        outcome = res.outcome;
        correct = res.correct;
        total = res.total;
        if (consent.email) for (const a of res.answers) this.safe(() => this.mentor.answer(consent.email, i.courseId, i.lessonId, a.stepIdx, a.choice));
        if (res.outcome === 'opted_out') {
          this.db.prepare('UPDATE consents SET revoked_at = ?, recording = 0 WHERE phone = ?').run(nowIso(), p);
          this.audit.record({ actor: 'system', action: 'telephony.opt_out', target: maskPhone(p), decision: 'info', details: { callId } });
        }
      } catch (e) {
        live.lines.push({ who: 'system', text: 'Ошибка связи: ' + (e instanceof Error ? e.message : String(e)) });
      } finally {
        clearTimeout(timer);
        const summary = `${STATUS_RU[outcome] ?? outcome}${total ? `; верных ответов ${correct} из ${total}` : ''}`;
        // Текст разговора хранится ТОЛЬКО при согласии на запись.
        const transcript = recording ? live.lines.map((l) => `${l.who === 'jarvis' ? 'ИИ' : l.who === 'employee' ? 'Сотрудник' : '—'}: ${l.text}`).join('\n') : null;
        this.db.prepare('UPDATE calls SET ended_at = ?, status = ?, correct = ?, total = ?, transcript = ?, summary = ? WHERE id = ?').run(nowIso(), outcome, correct, total, transcript, summary, callId);
        this.audit.record({ actor: 'system', action: 'telephony.call_finished', target: maskPhone(p), decision: 'info', details: { callId, outcome, correct, total } });
      }
    })();
    return { callId };
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch {
      /* запись в журнал обучения не должна ломать звонок */
    }
  }

  state(callId: number): CallStateDto {
    const live = this.live.get(callId);
    const row = this.db.prepare('SELECT status FROM calls WHERE id = ?').get(callId) as { status: string } | undefined;
    if (!row) throw new Error('Звонок не найден');
    const line = this.simulator.lines.get(callId);
    // Реплики видны только пока звонок идёт в окне (симулятор) — после завершения остаётся журнал без текста (кроме записи с согласия).
    return { id: callId, status: row.status, lines: live ? [...live.lines] : [], awaitingReply: !!line?.awaiting, finished: row.status !== 'running' };
  }

  reply(callId: number, text: string): void {
    const line = this.simulator.lines.get(callId);
    const clean = text.trim().slice(0, 500);
    if (!line || !this.live.has(callId) || !clean) throw new Error('Звонок не активен');
    line.push(clean);
  }

  hangup(callId: number): void {
    this.live.get(callId)?.ctrl.abort();
  }

  /** Для тестов и выхода из приложения. */
  async waitFinished(callId: number): Promise<void> {
    await this.live.get(callId)?.done;
  }

  stopAll(): void {
    for (const l of this.live.values()) l.ctrl.abort();
  }

  listCalls(limit = 50): CallDto[] {
    return (this.db.prepare('SELECT * FROM calls ORDER BY id DESC LIMIT ?').all(limit) as unknown as CallRow[]).map((r) => ({
      id: r.id, phone: maskPhone(r.phone), name: r.name, courseId: r.course_id, lessonId: r.lesson_id, provider: r.provider, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, correct: r.correct, total: r.total, recorded: r.recorded === 1, summary: r.summary,
    }));
  }

  transcript(callId: number): string | null {
    const r = this.db.prepare('SELECT transcript FROM calls WHERE id = ?').get(callId) as { transcript: string | null } | undefined;
    return r?.transcript ?? null;
  }

  /** Удалить запись разговора (по праву сотрудника). */
  deleteTranscript(callId: number): void {
    this.db.prepare('UPDATE calls SET transcript = NULL, recorded = 0 WHERE id = ?').run(callId);
    this.audit.record({ actor: 'user', action: 'telephony.transcript_deleted', target: String(callId), decision: 'info' });
  }

  registerTools(tools: ToolRegistry): void {
    tools.register({
      name: 'call_log',
      description: 'Журнал учебных звонков наставника (номера замаскированы): когда звонили, кому, итог. Только чтение.',
      risk: 'safe',
      mutates: false,
      domain: 'local',
      inputSchema: { type: 'object', properties: {} },
      describe: () => 'Показать журнал учебных звонков',
      execute: () =>
        this.listCalls(20)
          .map((c) => `#${c.id} ${c.startedAt.slice(0, 16).replace('T', ' ')} · ${c.name} (${c.phone}) · урок ${c.courseId}/${c.lessonId} · ${c.summary ?? STATUS_RU[c.status] ?? c.status}`)
          .join('\n') || 'Звонков пока не было.',
    });
  }
}
