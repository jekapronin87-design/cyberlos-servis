import type { AlertDto, ChatItemDto, ClubStatsDto, MailItemDto } from '../../shared/deck';
import type { CrmDashboardDto } from '../../shared/types';

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : def);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
const first = (r: Row, keys: string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
};
const DAY = 86_400_000;

// ---------- Telegram-бот клуба (CRM «Аквамастер», раздел club) ----------

const STEP_RU: Record<string, string> = {
  WATCH: 'Смотрят материалы', START: 'Запустили бота', STARTED: 'Запустили бота', NEW: 'Новые', REGISTERED: 'Зарегистрировались', SURVEY: 'Анкета', QUIZ: 'Тест',
  PAYMENT: 'Оплата', PAYMENT_PENDING: 'Ждут оплаты', INVOICE: 'Выставлен счёт', PAID: 'Оплатили', ACTIVE: 'Активные', MEMBER: 'В клубе',
  EXPIRED: 'Доступ закончился', CANCELLED: 'Отменили', LEFT: 'Вышли',
};
const stepName = (s: string): string => STEP_RU[s.toUpperCase()] ?? s;

/** Ответ club/funnel (CRM считает воронку сама): { total, withAccessNow, paying, paidTotalRub, byStep[{step,count,avgDaysInStep,stuckOver3Days}], last7Days }. */
export function parseClubFunnel(dataIn: unknown): ClubStatsDto | null {
  const d = obj(dataIn);
  if (!Array.isArray(d['byStep']) && d['total'] === undefined) return null;
  const l7 = obj(d['last7Days']);
  return {
    total: num(d['total']),
    withAccess: num(d['withAccessNow']),
    paying: num(d['paying']),
    paidRub: num(d['paidTotalRub']),
    byStep: (Array.isArray(d['byStep']) ? (d['byStep'] as unknown[]) : []).map((x) => {
      const s = obj(x);
      return { step: stepName(str(s['step'], 'Без этапа')), count: num(s['count']), stuck: num(s['stuckOver3Days']) };
    }).sort((a, b) => b.count - a.count),
    last7Days: d['last7Days'] ? { joined: num(l7['joined']), paid: num(l7['paid']) } : undefined,
    today: d['today'] ? { joined: num(obj(d['today'])['joined']), paid: num(obj(d['today'])['paid']), paidRub: num(obj(d['today'])['paidRub']) } : undefined,
  };
}
/** Шаги, на которых «застрял» уже не считается (человек дошёл до конца или ушёл). */
const FINAL_STEP = /^(PAID|ACTIVE|MEMBER|EXPIRED|CANCELLED|CANCELED|LEFT|DONE|COMPLETED)$/i;
export const CLUB_STUCK_DAYS = 3;

/** Разбор списка участников клуба. Поля в CRM могут называться по-разному — читаем осторожно, неизвестное считаем нулём. */
export function parseClub(rowsIn: unknown[], now: Date): ClubStatsDto {
  const nowMs = now.getTime();
  let withAccess = 0;
  let paying = 0;
  let paidRub = 0;
  const steps = new Map<string, { count: number; stuck: number }>();
  for (const x of rowsIn) {
    const r = obj(x);
    const step = str(first(r, ['step', 'stage', 'status']), 'Без этапа');
    const paid = num(first(r, ['paidTotalRub', 'paidRub', 'totalPaid', 'paidTotal', 'amountPaid', 'revenueRub']));
    const isPaid = first(r, ['isPaid', 'paid']) === true || paid > 0 || !!first(r, ['paidAt', 'firstPaymentAt']);
    const until = Date.parse(str(first(r, ['accessUntil', 'paidUntil', 'subscriptionUntil', 'expiresAt'])));
    const access = first(r, ['hasAccess', 'accessActive', 'active']) === true || (Number.isFinite(until) && until > nowMs);
    if (isPaid) paying += 1;
    if (access) withAccess += 1;
    paidRub += paid;
    const changed = Date.parse(str(first(r, ['stepChangedAt', 'stepUpdatedAt', 'updatedAt', 'lastActivityAt', 'createdAt'])));
    const stuck = !FINAL_STEP.test(step) && Number.isFinite(changed) && nowMs - changed > CLUB_STUCK_DAYS * DAY;
    const e = steps.get(step) ?? { count: 0, stuck: 0 };
    e.count += 1;
    if (stuck) e.stuck += 1;
    steps.set(step, e);
  }
  return {
    total: rowsIn.length,
    withAccess,
    paying,
    paidRub,
    byStep: [...steps.entries()].map(([step, v]) => ({ step: stepName(step), ...v })).sort((a, b) => b.count - a.count),
  };
}

// ---------- Рабочие чаты (Telegram и Max, приходят из CRM) ----------

const CHANNEL_RU: Record<string, string> = { telegram: 'Telegram', tg: 'Telegram', max: 'Max', vk: 'VK', whatsapp: 'WhatsApp' };
/** Разбор сообщений: «без ответа» — если последнее сообщение в переписке входящее. */
export function parseChats(rowsIn: unknown[], now: Date, windowHours = 36): ChatItemDto[] {
  const since = now.getTime() - windowHours * 3_600_000;
  const when = (r: Row): number => Date.parse(str(first(r, ['createdAt', 'sentAt', 'at', 'date'])));
  const byConv = new Map<string, Row[]>();
  for (const x of rowsIn) {
    const r = obj(x);
    const at = when(r);
    if (!Number.isFinite(at) || at < since) continue;
    const conv = str(first(r, ['threadId', 'conversationId', 'chatId', 'dealId']), str(obj(r['contact'])['id'], str(first(r, ['chatTitle', 'from', 'senderName', 'contactName']), 'unknown')));
    const list = byConv.get(conv) ?? [];
    list.push(r);
    byConv.set(conv, list);
  }
  const out: ChatItemDto[] = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => when(a) - when(b));
    const last = list[list.length - 1]!;
    const dir = str(first(last, ['direction', 'dir', 'type'])).toLowerCase();
    const outgoing = ['out', 'outgoing', 'outbound', 'sent'].includes(dir) || first(last, ['fromMe', 'isOutgoing', 'outgoing']) === true;
    // Ответ мог быть дан и позже: если у входящего заполнено answeredAt, сотрудник уже отозвался
    const answered = !outgoing && (!!last['answeredAt'] || list.some((m) => !!m['answeredAt'] && when(m) >= when(last)));
    const ch = str(first(last, ['channel', 'source', 'messenger', 'provider'])).toLowerCase();
    const who = str(obj(last['contact'])['fullName'], str(first(last, ['chatTitle', 'contactName', 'senderName', 'from', 'authorName']), 'Клиент'));
    const mgr = str(obj(last['assignee'])['fullName']);
    out.push({
      channel: CHANNEL_RU[ch] ?? (ch ? ch : 'Чат'),
      from: (mgr && !outgoing ? `${who} → ${mgr}` : who).slice(0, 70),
      text: str(first(last, ['text', 'body', 'content', 'message'])).replace(/\s+/g, ' ').slice(0, 140),
      at: new Date(when(last)).toISOString(),
      unanswered: !outgoing && !answered,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ---------- Почта ----------

export interface RawMail {
  account: string;
  from: string;
  fromName?: string;
  subject: string;
  date: string;
  seen: boolean;
  flagged?: boolean;
  /** Метки Gmail (например, «\\Important»). */
  labels?: string[];
}

const SUBJECT_HOT = /(срочн|счёт|счет|оплат|договор|претенз|возврат|акт\b|суд\b|штраф|налог|налоговая|просроч|задолженн|предписан|urgent|invoice|payment|contract|overdue|deadline|asap)/i;
const NOISE = /(no-?reply|noreply|newsletter|mailer|notification|digest|promo|рассылк|unsubscribe|marketing|news@|info@.*(shop|store))/i;

export function scoreMail(m: RawMail, vip: string[]): MailItemDto {
  const reasons: string[] = [];
  let score = 0;
  const hay = `${m.from} ${m.fromName ?? ''}`.toLowerCase();
  const isVip = vip.some((v) => v.trim() && hay.includes(v.trim().toLowerCase()));
  if (isVip) (score += 3, reasons.push('важный отправитель'));
  if ((m.labels ?? []).some((l) => /important/i.test(l))) (score += 2, reasons.push('Gmail: важное'));
  if (m.flagged) (score += 2, reasons.push('с флажком'));
  if (SUBJECT_HOT.test(m.subject)) (score += 2, reasons.push('срочное/деньги/документы'));
  if (NOISE.test(m.from) && !isVip) score -= 3;
  return { account: m.account, from: (m.fromName || m.from).slice(0, 60), subject: m.subject.slice(0, 120), date: m.date, seen: m.seen, score, important: score >= 2 && !m.seen, reasons };
}

// ---------- Тревоги ----------

export interface AlertInput {
  dash: CrmDashboardDto | null;
  club: ClubStatsDto | null;
  mail: MailItemDto[] | null;
  chats: ChatItemDto[] | null;
  now: Date;
}

const plural = (n: number, a: string, b: string, c: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`;
};

/** Правила тревог — обычная арифметика, без нейросети. `key` меняется вместе с числом: изменилось — напомним снова. */
export function computeAlerts(i: AlertInput): AlertDto[] {
  const out: AlertDto[] = [];
  const o = i.dash?.overview;
  if (o) {
    if (o.productionOverdue > 0) out.push({ key: `prod:${o.productionOverdue}`, level: 'hot', title: `Производство: просрочено ${plural(o.productionOverdue, 'заказ', 'заказа', 'заказов')}`, detail: 'Плановая дата прошла, а заказ не закрыт' });
    if (o.unassignedOpen > 0) out.push({ key: `unassigned:${o.unassignedOpen}`, level: o.unassignedOpen > 3 ? 'hot' : 'warn', title: `${plural(o.unassignedOpen, 'открытая сделка', 'открытые сделки', 'открытых сделок')} без ответственного`, detail: 'Никто не ведёт — клиент ждёт' });
    if (o.tasksOverdue > 0) out.push({ key: `tasks:${o.tasksOverdue}`, level: o.tasksOverdue >= 10 ? 'hot' : 'warn', title: `Просрочено ${plural(o.tasksOverdue, 'задача', 'задачи', 'задач')}`, detail: `Всего открытых задач: ${o.tasksOpen}` });
    if (o.stuck > 0) out.push({ key: `stuck:${o.stuck}`, level: 'warn', title: `${plural(o.stuck, 'сделка', 'сделки', 'сделок')} без движения больше 7 дней`, detail: 'Откройте «Город» → «Застряло», чтобы увидеть, какие именно' });
    if (o.lowStock > 0) out.push({ key: `stock:${o.lowStock}`, level: 'warn', title: `${plural(o.lowStock, 'материал', 'материала', 'материалов')} ниже минимума на складе`, detail: 'Пора заказывать, чтобы не встало производство' });
  }
  const stuckClub = i.club?.byStep.reduce((a, s) => a + s.stuck, 0) ?? 0;
  if (stuckClub > 0) out.push({ key: `club:${stuckClub}`, level: 'warn', title: `В боте клуба без движения: ${plural(stuckClub, 'человек', 'человека', 'человек')}`, detail: `Не двигаются по этапам дольше ${CLUB_STUCK_DAYS} дней` });
  const imp = (i.mail ?? []).filter((m) => m.important);
  if (imp.length) out.push({ key: `mail:${imp.length}:${imp[0]!.subject.slice(0, 20)}`, level: imp.some((m) => m.reasons.includes('важный отправитель')) ? 'hot' : 'warn', title: `Важная почта: ${imp.length}`, detail: imp.slice(0, 2).map((m) => `${m.from} — ${m.subject}`).join(' · ') });
  const un = (i.chats ?? []).filter((c) => c.unanswered);
  if (un.length) {
    const oldest = Math.min(...un.map((c) => Date.parse(c.at)));
    const hours = (i.now.getTime() - oldest) / 3_600_000;
    out.push({ key: `chats:${un.length}`, level: hours >= 4 ? 'hot' : 'warn', title: `В рабочих чатах без ответа: ${un.length}`, detail: hours >= 1 ? `Самому старому ${Math.floor(hours)} ч` : 'Написали в последний час' });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'hot' ? -1 : b.level === 'hot' ? 1 : 0));
}

// ---------- Время в поясе ----------

export function zonedParts(d: Date, tz: string): { date: string; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p['year']}-${p['month']}-${p['day']}`, hm: `${p['hour']}:${p['minute']}` };
}
