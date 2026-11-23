// «Показ»: презентация на экране в космическом дизайне. Модель или ядро собирают колоду слайдов (данные), интерфейс красиво анимирует их.
// Колода — только данные: любые строки выводятся как текст (без разметки), числа проверяются — поэтому данные из CRM/сайтов не могут ничего исполнить.
import type { CrmDashboardDto } from './types';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral';

export type SlideDto =
  | { kind: 'title'; title: string; subtitle?: string }
  | { kind: 'kpis'; title: string; subtitle?: string; items: { label: string; value: number; unit?: string; note?: string; tone?: Tone }[] }
  | { kind: 'bars'; title: string; subtitle?: string; unit?: string; items: { label: string; value: number; note?: string; tone?: Tone }[] }
  | { kind: 'funnel'; title: string; subtitle?: string; stages: { label: string; value: number; tone?: Tone }[] }
  | { kind: 'donut'; title: string; subtitle?: string; items: { label: string; value: number; tone?: Tone }[] }
  | { kind: 'table'; title: string; subtitle?: string; columns: string[]; rows: string[][] }
  | { kind: 'text'; title: string; bullets: string[]; subtitle?: string }
  /** Тревоги: красные/жёлтые карточки с пульсацией. */
  | { kind: 'alerts'; title: string; subtitle?: string; items: { level: 'hot' | 'warn' | 'info'; title: string; detail?: string }[] };

export interface DeckDto {
  title: string;
  /** Подпись источника: «Живые данные CRM «Аквамастер»», «ПРИМЕР» и т. п. */
  source?: string;
  slides: SlideDto[];
  /** Секунд на слайд при автопоказе (по умолчанию 9). */
  autoplaySec?: number;
}

export const MAX_SLIDES = 24;
const TONES: Tone[] = ['good', 'bad', 'warn', 'neutral'];
const s = (v: unknown, max = 160): string => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e12, Math.min(1e12, v)) : Number.isFinite(Number(v)) ? Number(v) : 0);
const tone = (v: unknown): Tone | undefined => (TONES.includes(v as Tone) ? (v as Tone) : undefined);
const arr = (v: unknown, max: number): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max) as Record<string, unknown>[] : []);

/** Приводит произвольный JSON (например, от модели) к безопасной колоде или бросает понятную ошибку. */
export function sanitizeDeck(input: unknown): DeckDto {
  const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const slides: SlideDto[] = [];
  for (const raw of arr(d['slides'], MAX_SLIDES)) {
    const kind = s(raw['kind'], 20);
    const title = s(raw['title'], 100) || ' ';
    const subtitle = s(raw['subtitle'], 160) || undefined;
    if (kind === 'title') slides.push({ kind, title, subtitle });
    else if (kind === 'kpis') slides.push({ kind, title, subtitle, items: arr(raw['items'], 8).map((i) => ({ label: s(i['label'], 40), value: n(i['value']), unit: s(i['unit'], 12) || undefined, note: s(i['note'], 60) || undefined, tone: tone(i['tone']) })) });
    else if (kind === 'bars') slides.push({ kind, title, subtitle, unit: s(raw['unit'], 12) || undefined, items: arr(raw['items'], 12).map((i) => ({ label: s(i['label'], 40), value: n(i['value']), note: s(i['note'], 60) || undefined, tone: tone(i['tone']) })) });
    else if (kind === 'funnel') slides.push({ kind, title, subtitle, stages: arr(raw['stages'], 10).map((i) => ({ label: s(i['label'], 40), value: n(i['value']), tone: tone(i['tone']) })) });
    else if (kind === 'donut') slides.push({ kind, title, subtitle, items: arr(raw['items'], 8).map((i) => ({ label: s(i['label'], 40), value: Math.max(0, n(i['value'])), tone: tone(i['tone']) })) });
    else if (kind === 'table') {
      const columns = (Array.isArray(raw['columns']) ? (raw['columns'] as unknown[]) : []).slice(0, 8).map((c) => s(c, 30));
      const rows = (Array.isArray(raw['rows']) ? (raw['rows'] as unknown[]) : []).slice(0, 14).map((r) => (Array.isArray(r) ? (r as unknown[]).slice(0, columns.length).map((c) => s(c, 60)) : []));
      slides.push({ kind, title, subtitle, columns, rows });
    } else if (kind === 'alerts') slides.push({ kind, title, subtitle, items: arr(raw['items'], 8).map((i) => ({ level: (['hot', 'warn', 'info'].includes(String(i['level'])) ? i['level'] : 'info') as 'info', title: s(i['title'], 90), detail: s(i['detail'], 160) || undefined })) });
    else if (kind === 'text') slides.push({ kind, title, subtitle, bullets: (Array.isArray(raw['bullets']) ? (raw['bullets'] as unknown[]) : []).slice(0, 8).map((b) => s(b, 200)).filter(Boolean) });
  }
  if (slides.length === 0) throw new Error('В колоде нет ни одного слайда (kind: title, kpis, bars, funnel, donut, table, text).');
  const sec = n(d['autoplaySec']);
  return { title: s(d['title'], 80) || 'Показ', source: s(d['source'], 80) || undefined, slides, autoplaySec: sec >= 3 && sec <= 40 ? sec : undefined };
}

// ---------- Колода «Статистика» из сводки CRM ----------

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Короткие факты «главное» — их же ассистент проговаривает голосом. */
export function statsFacts(dash: CrmDashboardDto): string[] {
  const o = dash.overview;
  const facts: string[] = [];
  const open = sum(o.pipelines.map((p) => p.open));
  facts.push(`В работе ${open} сделок в ${o.pipelines.length} направлениях, новых за сутки — ${o.newLast24h}.`);
  const big = [...o.pipelines].sort((a, b) => b.open - a.open)[0];
  if (big && big.open > 0) facts.push(`Больше всего в работе — «${big.name}»: ${big.open}.`);
  const stages = o.pipelines.flatMap((p) => p.byStage.map((st) => ({ p: p.name, ...st }))).filter((x) => x.breaches > 0).sort((a, b) => b.breaches - a.breaches);
  if (stages[0]) facts.push(`Дольше всего зависают сделки на стадии «${stages[0].name}» (${stages[0].p}): ${stages[0].breaches}.`);
  if (o.stuck > 0) facts.push(`Без движения дольше срока: ${o.stuck}.`);
  if (o.unassignedOpen > 0) facts.push(`Без ответственного: ${o.unassignedOpen}.`);
  if (o.tasksOverdue > 0) facts.push(`Просроченных задач: ${o.tasksOverdue} из ${o.tasksOpen}.`);
  if (o.productionOpen > 0 || o.productionOverdue > 0) facts.push(`Производство: в работе ${o.productionOpen}, просрочено ${o.productionOverdue}.`);
  if (o.lowStock > 0) facts.push(`Материалов ниже минимума: ${o.lowStock}.`);
  return facts;
}

export function buildStatsDeck(dash: CrmDashboardDto, opts: { sample?: boolean; now?: Date } = {}): DeckDto {
  const o = dash.overview;
  const live = dash.source === 'aqua';
  const slides: SlideDto[] = [];
  const when = (opts.now ?? new Date(dash.at)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  slides.push({ kind: 'title', title: 'Статистика бизнеса', subtitle: `${when} · ${opts.sample ? 'пример данных' : live ? 'живые данные CRM «Аквамастер»' : 'данные CRM'}` });

  const open = sum(o.pipelines.map((p) => p.open));
  slides.push({
    kind: 'kpis',
    title: 'Главное сейчас',
    items: [
      { label: 'В работе', value: open, note: `${o.pipelines.length} направлений` },
      { label: 'Новых за сутки', value: o.newLast24h, tone: 'good' },
      { label: 'Без ответственного', value: o.unassignedOpen, tone: o.unassignedOpen ? 'warn' : 'good' },
      { label: 'Без движения', value: o.stuck, tone: o.stuck ? 'bad' : 'good', note: 'дольше срока' },
      { label: 'Задач просрочено', value: o.tasksOverdue, tone: o.tasksOverdue ? 'bad' : 'good', note: `из ${o.tasksOpen}` },
      { label: 'Производство в работе', value: o.productionOpen },
    ],
  });
  if (o.pipelines.length > 1) {
    slides.push({ kind: 'bars', title: 'Сделки в работе по направлениям', unit: 'шт', items: o.pipelines.map((p) => ({ label: p.name, value: p.open, note: `выиграно ${p.won} · проиграно ${p.lost}` })) });
  }
  for (const p of o.pipelines.slice(0, 6)) {
    const stages = p.byStage.filter((st) => st.open > 0 || p.byStage.length <= 6);
    if (stages.length === 0) continue;
    slides.push({ kind: 'funnel', title: p.name, subtitle: `в работе ${p.open} · выиграно ${p.won} · проиграно ${p.lost}`, stages: stages.map((st) => ({ label: st.name, value: st.open, tone: st.breaches > 0 ? 'bad' : undefined })) });
  }
  const won = sum(o.pipelines.map((p) => p.won));
  const lost = sum(o.pipelines.map((p) => p.lost));
  if (open + won + lost > 0) slides.push({ kind: 'donut', title: 'Итог по сделкам', subtitle: 'за всё время', items: [{ label: 'В работе', value: open }, { label: 'Выиграно', value: won, tone: 'good' }, { label: 'Проиграно', value: lost, tone: 'bad' }] });
  if (dash.managers.length > 0) {
    slides.push({ kind: 'bars', title: 'Нагрузка менеджеров', subtitle: 'сделок в работе', unit: 'шт', items: dash.managers.slice(0, 8).map((m) => ({ label: m.name, value: m.openDeals, tone: m.tasksOverdue > 2 ? 'warn' : undefined, note: m.tasksOverdue ? `просрочено задач: ${m.tasksOverdue}` : undefined })) });
  }
  slides.push({
    kind: 'kpis',
    title: 'Производство и склад',
    items: [
      { label: 'Заказов в работе', value: o.productionOpen },
      { label: 'Просрочено', value: o.productionOverdue, tone: o.productionOverdue ? 'bad' : 'good' },
      { label: 'Материалов ниже минимума', value: o.lowStock, tone: o.lowStock ? 'warn' : 'good' },
    ],
  });
  const groups = new Map<string, number>();
  for (const i of dash.issues) groups.set(i.kind, (groups.get(i.kind) ?? 0) + 1);
  const NAMES: Record<string, string> = { stuck: 'Без движения', no_assignee: 'Нет ответственного', lost_without_reason: 'Отказ без причины', production_overdue: 'Просрочено производство', missing_required_field: 'Не заполнены поля', no_next_action: 'Нет следующего действия', status_stage_mismatch: 'Статус ≠ стадии', lead_without_contact: 'Нет контактов', production_unpaid_in_work: 'Производство без предоплаты' };
  if (groups.size > 0) slides.push({ kind: 'bars', title: 'Что не так', subtitle: 'замечания по работе в CRM', unit: 'шт', items: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: NAMES[k] ?? k, value: v, tone: 'warn' as Tone })) });
  slides.push({ kind: 'text', title: 'Главное — коротко', bullets: statsFacts(dash) });
  return sanitizeDeck({ title: 'Статистика бизнеса', source: opts.sample ? 'ПРИМЕР ДАННЫХ' : live ? 'Живые данные · CRM «Аквамастер»' : 'Данные CRM', autoplaySec: 9, slides });
}

// ---------- Утренняя сводка ----------

export interface AlertDto {
  /** Ключ для «не повторять одно и то же»: меняется, когда меняется суть (например, число просрочек). */
  key: string;
  level: 'hot' | 'warn' | 'info';
  title: string;
  detail?: string;
}

export interface ClubStatsDto {
  total: number;
  withAccess: number;
  paying: number;
  paidRub: number;
  byStep: { step: string; count: number; stuck: number }[];
}

export interface MailItemDto {
  account: string;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
  score: number;
  important: boolean;
  reasons: string[];
}

export interface ChatItemDto {
  channel: string;
  from: string;
  text: string;
  at: string;
  unanswered: boolean;
}

export interface BriefingData {
  userName: string;
  at: string;
  tz: string;
  dash: CrmDashboardDto | null;
  club: ClubStatsDto | null;
  mail: { items: MailItemDto[]; accounts: number; errors: string[] } | null;
  chats: { items: ChatItemDto[] } | null;
  /** Что не удалось получить и почему (показывается на последнем слайде). */
  missing: string[];
}

const dayName = (d: Date, tz: string): string => d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
const hourOf = (d: Date, tz: string): number => Number(d.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }));
export const greetingFor = (hour: number): string => (hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер');

/** Колода «Утренняя сводка»: приветствие → тревоги → цифры бизнеса → клуб (Telegram-бот) → почта → чаты → итог. */
export function buildBriefingDeck(b: BriefingData, alerts: AlertDto[]): DeckDto {
  const now = new Date(b.at);
  const slides: SlideDto[] = [];
  const hello = `${greetingFor(hourOf(now, b.tz))}${b.userName ? ', ' + b.userName : ''}`;
  slides.push({ kind: 'title', title: hello, subtitle: `${dayName(now, b.tz)} · сводка бизнеса` });
  if (alerts.length) {
    slides.push({ kind: 'alerts', title: 'Требует внимания', subtitle: `${alerts.length} ${alerts.length === 1 ? 'сигнал' : alerts.length < 5 ? 'сигнала' : 'сигналов'}`, items: alerts.slice(0, 8).map((a) => ({ level: a.level, title: a.title, detail: a.detail })) });
  } else {
    slides.push({ kind: 'alerts', title: 'Тревог нет', subtitle: 'всё спокойно', items: [{ level: 'info', title: 'Критичных сигналов нет', detail: 'Просрочек, зависших сделок и неотвеченных сообщений не найдено' }] });
  }
  if (b.dash) slides.push(...buildStatsDeck(b.dash).slides.filter((s) => s.kind !== 'title' && !(s.kind === 'text' && s.title.startsWith('Главное'))));
  if (b.club) {
    const c = b.club;
    slides.push({ kind: 'kpis', title: 'Telegram-бот: клуб', items: [{ label: 'Всего зашло', value: c.total }, { label: 'Платящих', value: c.paying, tone: 'good' }, { label: 'С доступом сейчас', value: c.withAccess, tone: 'good' }, { label: 'Оплачено', value: c.paidRub, unit: ' ₽', tone: 'good' }] });
    const steps = c.byStep.filter((x) => x.count > 0);
    if (steps.length) slides.push({ kind: 'funnel', title: 'Воронка бота: кто на каком этапе', subtitle: '⚠ — застрявшие дольше 3 дней, красным — этапы, где они есть', stages: steps.map((x) => ({ label: `${x.step}${x.stuck ? ` (⚠ ${x.stuck})` : ''}`, value: x.count, tone: x.stuck > 0 ? ('bad' as Tone) : undefined })) });
  }
  if (b.mail) {
    const imp = b.mail.items.filter((m) => m.important);
    slides.push(imp.length
      ? { kind: 'table', title: 'Важная почта', subtitle: `${imp.length} из ${b.mail.items.length} новых писем · ящиков: ${b.mail.accounts}`, columns: ['Ящик', 'От кого', 'Тема', 'Почему'], rows: imp.slice(0, 10).map((m) => [m.account, m.from, m.subject, m.reasons.join(', ')]) }
      : { kind: 'kpis', title: 'Почта', items: [{ label: 'Новых писем', value: b.mail.items.length }, { label: 'Важных', value: 0, tone: 'good' }, { label: 'Ящиков', value: b.mail.accounts }] });
  }
  if (b.chats) {
    const un = b.chats.items.filter((m) => m.unanswered);
    slides.push(un.length
      ? { kind: 'table', title: 'Рабочие чаты: без ответа', subtitle: `${un.length} сообщений (Telegram и Max из CRM)`, columns: ['Канал', 'От кого', 'Сообщение', 'Когда'], rows: un.slice(0, 10).map((m) => [m.channel, m.from, m.text, new Date(m.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone: b.tz })]) }
      : { kind: 'kpis', title: 'Рабочие чаты', items: [{ label: 'Сообщений за сутки', value: b.chats.items.length }, { label: 'Без ответа', value: 0, tone: 'good' }] });
  }
  const bullets = [...(b.dash ? statsFacts(b.dash) : []), ...(b.club ? [`Клуб: зашло ${b.club.total}, платящих ${b.club.paying}, оплачено ${Math.round(b.club.paidRub).toLocaleString('ru-RU')} ₽.`] : []), ...(b.mail ? [`Важных писем: ${b.mail.items.filter((m) => m.important).length}.`] : []), ...(b.chats ? [`Сообщений без ответа в чатах: ${b.chats.items.filter((m) => m.unanswered).length}.`] : [])];
  if (b.missing.length) bullets.push(`Не удалось получить: ${b.missing.join('; ')}.`);
  slides.push({ kind: 'text', title: 'Главное — коротко', bullets });
  return sanitizeDeck({ title: 'Утренняя сводка', source: 'Живые данные · CRM «Аквамастер», почта, чаты', autoplaySec: 8, slides });
}

/** Короткий текст для голоса — без нейросети, шаблоном. */
export function briefingSpeech(b: BriefingData, alerts: AlertDto[]): string {
  const hello = `${greetingFor(hourOf(new Date(b.at), b.tz))}${b.userName ? ', ' + b.userName : ''}.`;
  const parts: string[] = [hello];
  if (b.dash) {
    const o = b.dash.overview;
    parts.push(`В работе ${o.pipelines.reduce((a, p) => a + p.open, 0)} сделок, новых за сутки ${o.newLast24h}.`);
  }
  if (alerts.length) parts.push(`Тревог: ${alerts.length}. ${alerts.slice(0, 3).map((a) => a.title).join('. ')}.`);
  else parts.push('Тревог нет.');
  if (b.club) parts.push(`В боте клуба ${b.club.total} человек, платящих ${b.club.paying}.`);
  if (b.mail) parts.push(`Важных писем ${b.mail.items.filter((m) => m.important).length}.`);
  if (b.chats) parts.push(`Сообщений без ответа ${b.chats.items.filter((m) => m.unanswered).length}.`);
  return parts.join(' ');
}

export interface BriefingConfigDto {
  enabled: boolean;
  /** «ЧЧ:ММ» по часовому поясу tz. */
  time: string;
  tz: string;
  speak: boolean;
  alerts: boolean;
  vip: string[];
}
export interface MailAccountDto {
  id: string;
  provider: 'gmail' | 'yandex';
  email: string;
  hasPassword: boolean;
}
export interface BriefingPayloadDto {
  deck: DeckDto;
  speech: string;
  alerts: AlertDto[];
  manual: boolean;
  /** Озвучить приветствие (настройка на момент показа). */
  speak: boolean;
}
export interface BriefingStateDto {
  config: BriefingConfigDto;
  mail: MailAccountDto[];
  lastDate: string;
  crm: boolean;
}
