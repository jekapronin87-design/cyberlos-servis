import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import { briefingSpeech, buildBriefingDeck, type AlertDto, type BriefingData, type ChatItemDto, type ClubStatsDto } from '../../shared/deck';
import type { BriefingConfigDto, BriefingPayloadDto, DeckDto } from '../../shared/deck';
import type { CrmDashboardDto } from '../../shared/types';
import { computeAlerts, parseChats, parseClub, parseClubFunnel, zonedParts } from './rules';
import type { MailService } from './mail';

export type BriefingConfig = BriefingConfigDto;

export const DEFAULT_BRIEFING: BriefingConfig = { enabled: true, time: '10:00', tz: 'Asia/Bangkok', speak: true, alerts: true, vip: [], };

export type BriefingPayload = BriefingPayloadDto;

export interface AlertEvent {
  alerts: AlertDto[];
}

/** Что нужно сводке от остального приложения (всё читается только на чтение). */
export interface BriefingDeps {
  db: Db;
  audit: AuditLog;
  mail: MailService;
  /** Сводка CRM; null — CRM не подключена. */
  dashboard: () => Promise<CrmDashboardDto | null>;
  /** GET из живой CRM «Аквамастер»; null — не подключена. */
  crmGet: (() => ((path: string, query?: Record<string, unknown>) => Promise<unknown>) | null) | null;
  userName: () => string;
  now?: () => Date;
}

const ALERT_REPEAT_MS = 12 * 3_600_000;
const tz_ok = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('ru', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export function validateBriefingConfig(raw: unknown, base: BriefingConfig = DEFAULT_BRIEFING): BriefingConfig {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const time = typeof c['time'] === 'string' ? c['time'].trim() : base.time;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Время должно быть в виде ЧЧ:ММ, например 10:00.');
  const tz = typeof c['tz'] === 'string' && c['tz'].trim() ? c['tz'].trim() : base.tz;
  if (!tz_ok(tz)) throw new Error('Неизвестный часовой пояс (пример: Asia/Bangkok).');
  const vip = Array.isArray(c['vip']) ? c['vip'].filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 30) : base.vip;
  return { enabled: c['enabled'] === undefined ? base.enabled : c['enabled'] !== false, time, tz, speak: c['speak'] === undefined ? base.speak : c['speak'] !== false, alerts: c['alerts'] === undefined ? base.alerts : c['alerts'] !== false, vip };
}

/**
 * Утренняя сводка и тревоги. Всё считается обычной арифметикой — нейросеть и её токены не нужны.
 * Каждый день в заданное время (по умолчанию 10:00 по Бангкоку) собираем данные, открываем «Показ» и (если включено) озвучиваем приветствие.
 * Если приложение было закрыто в это время — покажем при первом запуске в тот же день.
 */
export class BriefingService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(p: BriefingPayload) => void>();
  private alertListeners = new Set<(e: AlertEvent) => void>();
  private pending: BriefingPayload | null = null;
  private busy = false;
  private lastAlertCheck = 0;

  constructor(private deps: BriefingDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private read<T>(key: string, def: T): T {
    const r = this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(`briefing.${key}`) as { value: string } | undefined;
    if (!r) return def;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return def;
    }
  }
  private write(key: string, value: unknown): void {
    this.deps.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(`briefing.${key}`, JSON.stringify(value), nowIso());
  }

  config(): BriefingConfig {
    try {
      return validateBriefingConfig(this.read('config', DEFAULT_BRIEFING));
    } catch {
      return DEFAULT_BRIEFING;
    }
  }
  save(raw: unknown): BriefingConfig {
    const c = validateBriefingConfig(raw, this.config());
    this.write('config', c);
    this.deps.audit.record({ actor: 'user', action: 'briefing.configured', decision: 'info', details: { enabled: c.enabled, time: c.time, tz: c.tz, alerts: c.alerts } });
    return c;
  }
  lastDate(): string {
    return this.read('lastDate', '');
  }

  onBriefing(cb: (p: BriefingPayload) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onAlerts(cb: (e: AlertEvent) => void): () => void {
    this.alertListeners.add(cb);
    return () => this.alertListeners.delete(cb);
  }
  /** Окно могло ещё не открыться, когда сводка была готова — отдаём её при запросе. */
  takePending(): BriefingPayload | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  start(tickMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 4000).unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Раз в 30 секунд: пора ли сводке, пора ли проверить тревоги. */
  async tick(): Promise<void> {
    const c = this.config();
    const t = zonedParts(this.now(), c.tz);
    if (c.enabled && t.hm >= c.time && t.hm < '22:00' && this.lastDate() !== t.date) {
      this.write('lastDate', t.date); // записываем до сбора: даже если что-то упадёт, не будем показывать по кругу
      await this.run(false).catch((e) => this.deps.audit.record({ actor: 'system', action: 'briefing.failed', decision: 'error', details: { error: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    if (c.alerts && Date.now() - this.lastAlertCheck >= 15 * 60_000) {
      this.lastAlertCheck = Date.now();
      await this.checkAlerts().catch(() => undefined);
    }
  }

  /** Собирает всё, что подключено. Каждый источник независим: упал один — остальные работают. */
  async collect(): Promise<BriefingData> {
    const c = this.config();
    const now = this.now();
    const missing: string[] = [];
    const [dash, club, mail, chats] = await Promise.all([
      this.deps.dashboard().catch((e) => (missing.push(`CRM: ${msg(e)}`), null)),
      this.collectClub(now, missing),
      this.deps.mail.list().length ? this.deps.mail.collect(c.vip, now).catch((e) => (missing.push(`почта: ${msg(e)}`), null)) : Promise.resolve(null),
      this.collectChats(now, missing),
    ]);
    if (mail) missing.push(...mail.errors);
    if (!dash && !missing.some((m) => m.startsWith('CRM'))) missing.push('CRM не подключена');
    if (dash) missing.push(...dash.missing.map((m) => `в CRM нет раздела: ${m}`));
    return { userName: this.deps.userName(), at: now.toISOString(), tz: c.tz, dash, club, mail: mail ? { items: mail.items, accounts: mail.accounts, errors: mail.errors } : null, chats: chats ? { items: chats } : null, missing };
  }

  private async collectClub(now: Date, missing: string[]): Promise<ClubStatsDto | null> {
    const get = this.deps.crmGet?.();
    if (!get) return null;
    try {
      // Сначала готовая воронка от CRM (club/funnel); у старой версии CRM её нет — считаем сами по списку участников
      try {
        const f = parseClubFunnel(obj((await get('club/funnel')) as unknown)['data']);
        if (f) return f;
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
      const rows: unknown[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 10; n++) {
        const r = (await get('club/members', { limit: 200, ...(cursor ? { cursor } : {}) })) as { data?: unknown; nextCursor?: unknown } | null;
        if (Array.isArray(r?.data)) rows.push(...r.data);
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
        if (!cursor) break;
      }
      return parseClub(rows, now);
    } catch (e) {
      missing.push(`клуб (Telegram-бот): ${status(e) === 403 ? 'раздел club не включён для ключа' : status(e) === 404 ? 'в CRM пока нет этого раздела' : msg(e)}`);
      return null;
    }
  }

  private async collectChats(now: Date, missing: string[]): Promise<ChatItemDto[] | null> {
    const get = this.deps.crmGet?.();
    if (!get) return null;
    try {
      const rows: unknown[] = [];
      let cursor: string | null = null;
      const from = new Date(now.getTime() - 36 * 3_600_000).toISOString();
      for (let n = 0; n < 5; n++) {
        const r = (await get('messages', { limit: 200, from, ...(cursor ? { cursor } : {}) })) as { data?: unknown; nextCursor?: unknown } | null;
        if (Array.isArray(r?.data)) rows.push(...r.data);
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
        if (!cursor) break;
      }
      return parseChats(rows, now);
    } catch (e) {
      missing.push(`рабочие чаты: ${status(e) === 404 ? 'CRM ещё не отдаёт сообщения (раздел messages не готов)' : status(e) === 403 ? 'раздел не включён для ключа' : msg(e)}`);
      return null;
    }
  }

  /** Показать сводку сейчас (по расписанию или по кнопке/голосу). */
  async run(manual: boolean): Promise<BriefingPayload> {
    if (this.busy) throw new Error('Сводка уже собирается — подождите несколько секунд.');
    this.busy = true;
    try {
      const data = await this.collect();
      const alerts = computeAlerts({ dash: data.dash, club: data.club, mail: data.mail?.items ?? null, chats: data.chats?.items ?? null, now: this.now() });
      const payload: BriefingPayload = { deck: buildBriefingDeck(data, alerts), speech: briefingSpeech(data, alerts), alerts, manual, speak: this.config().speak };
      // тревоги из сводки считаем «уже показанными», чтобы тут же не продублировать их уведомлением
      this.markSeen(alerts);
      this.pending = this.listeners.size ? null : payload;
      for (const l of this.listeners) l(payload);
      this.deps.audit.record({ actor: manual ? 'user' : 'system', action: 'briefing.shown', decision: 'info', details: { slides: payload.deck.slides.length, alerts: alerts.length, manual } });
      return payload;
    } finally {
      this.busy = false;
    }
  }

  private markSeen(alerts: AlertDto[]): void {
    const seen = this.read<Record<string, number>>('alertSeen', {});
    const t = Date.now();
    for (const a of alerts) seen[a.key] = t;
    this.write('alertSeen', prune(seen, t));
  }

  /** Проверка тревог раз в 15 минут: только НОВЫЕ (или давно не напоминавшиеся) попадают в уведомление. */
  async checkAlerts(): Promise<AlertDto[]> {
    const data = await this.collect();
    const all = computeAlerts({ dash: data.dash, club: data.club, mail: data.mail?.items ?? null, chats: data.chats?.items ?? null, now: this.now() });
    const seen = this.read<Record<string, number>>('alertSeen', {});
    const t = Date.now();
    const fresh = all.filter((a) => a.level !== 'info' && !(seen[a.key] && t - seen[a.key]! < ALERT_REPEAT_MS));
    if (!fresh.length) return [];
    for (const a of fresh) seen[a.key] = t;
    this.write('alertSeen', prune(seen, t));
    this.deps.audit.record({ actor: 'system', action: 'briefing.alerts', decision: 'info', details: { count: fresh.length } });
    for (const l of this.alertListeners) l({ alerts: fresh });
    return fresh;
  }
}

const prune = (seen: Record<string, number>, t: number): Record<string, number> => Object.fromEntries(Object.entries(seen).filter(([, v]) => t - v < 3 * 86_400_000));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const status = (e: unknown): number | undefined => (e as { status?: number }).status;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);
