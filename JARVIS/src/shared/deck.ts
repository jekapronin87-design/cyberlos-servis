// «Показ»: презентация на экране в космическом дизайне. Модель или ядро собирают колоду слайдов (данные), интерфейс красиво анимирует их.
// Колода — только данные: любые строки выводятся как текст (без разметки), числа проверяются — поэтому данные из CRM/сайтов не могут ничего исполнить.
import type { CrmDashboardDto } from './types';

export type Tone = 'good' | 'bad' | 'warn' | 'neutral';

export type SlideDto = (
  | { kind: 'title'; title: string; subtitle?: string }
  | { kind: 'kpis'; title: string; subtitle?: string; items: { label: string; value: number; unit?: string; note?: string; tone?: Tone }[] }
  | { kind: 'bars'; title: string; subtitle?: string; unit?: string; items: { label: string; value: number; note?: string; tone?: Tone }[] }
  | { kind: 'funnel'; title: string; subtitle?: string; stages: { label: string; value: number; tone?: Tone }[] }
  | { kind: 'donut'; title: string; subtitle?: string; items: { label: string; value: number; tone?: Tone }[] }
  | { kind: 'table'; title: string; subtitle?: string; columns: string[]; rows: string[][] }
  | { kind: 'text'; title: string; bullets: string[]; subtitle?: string }
  /** Тревоги: красные/жёлтые карточки с пульсацией. */
  | { kind: 'alerts'; title: string; subtitle?: string; items: { level: 'hot' | 'warn' | 'info'; title: string; detail?: string }[] }
  /** Спидометры: стрелка показывает value из max. */
  | { kind: 'gauges'; title: string; subtitle?: string; items: { label: string; value: number; max: number; unit?: string; note?: string; tone?: Tone }[] }
  /** Линейный график по дням: до 3 рядов на общей оси. */
  | { kind: 'trend'; title: string; subtitle?: string; labels: string[]; series: { label: string; values: number[]; tone?: Tone }[] }
) & {
  /** Что сказать голосом на этом слайде (для озвученного показа). Готовый текст, без участия нейросети. */
  say?: string;
};

export interface DeckDto {
  title: string;
  /** Подпись источника: «Живые данные CRM «Аквамастер»», «ПРИМЕР» и т. п. */
  source?: string;
  slides: SlideDto[];
  /** Секунд на слайд при автопоказе (по умолчанию 9). */
  autoplaySec?: number;
  /** Озвучивать слайды по очереди (по полю say) и листать, когда реплика закончилась. */
  narrate?: boolean;
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
    const before = slides.length;
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
    else if (kind === 'gauges') slides.push({ kind, title, subtitle, items: arr(raw['items'], 4).map((i) => ({ label: s(i['label'], 40), value: Math.max(0, n(i['value'])), max: Math.max(1, n(i['max'])), unit: s(i['unit'], 12) || undefined, note: s(i['note'], 60) || undefined, tone: tone(i['tone']) })) });
    else if (kind === 'trend') {
      const labels = (Array.isArray(raw['labels']) ? (raw['labels'] as unknown[]) : []).slice(0, 14).map((l) => s(l, 12));
      slides.push({ kind, title, subtitle, labels, series: arr(raw['series'], 3).map((r) => ({ label: s(r['label'], 40), values: (Array.isArray(r['values']) ? (r['values'] as unknown[]) : []).slice(0, labels.length).map((v) => Math.max(0, n(v))), tone: tone(r['tone']) })) });
    } else if (kind === 'text') slides.push({ kind, title, subtitle, bullets: (Array.isArray(raw['bullets']) ? (raw['bullets'] as unknown[]) : []).slice(0, 8).map((b) => s(b, 200)).filter(Boolean) });
    const say = s(raw['say'], 700);
    if (say && slides.length > before) slides[slides.length - 1]!.say = say;
  }
  if (slides.length === 0) throw new Error('В колоде нет ни одного слайда (kind: title, kpis, bars, funnel, donut, table, text).');
  const sec = n(d['autoplaySec']);
  return { title: s(d['title'], 80) || 'Показ', source: s(d['source'], 80) || undefined, slides, autoplaySec: sec >= 3 && sec <= 40 ? sec : undefined, narrate: d['narrate'] === true && slides.some((x) => x.say) ? true : undefined };
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
  /** За последние 7 дней (есть только в ответе club/funnel). */
  last7Days?: { joined: number; paid: number };
  /** Сегодня (по часовому поясу пользователя): зашло, оплатили, на сумму, кто оплатил. */
  today?: { joined: number; paid: number; paidRub: number; payments?: { who: string; amountRub: number }[] };
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

export interface EveningData {
  /** Подписи последних 7 дней (последний — сегодня). */
  dayLabels: string[];
  today: {
    newDeals: number;
    won: number;
    wonRub: number;
    lost: number;
    /** null — CRM этих данных не отдала. */
    tasksDone: number | null;
    calls: { in: number; out: number } | null;
    productionDone: number | null;
  };
  week: { newPerDay: number[]; wonPerDay: number[] };
  /** Обычный день: среднее за предыдущие 6 дней. */
  avg: { newPerDay: number; wonPerDay: number };
}

export interface BriefingData {
  kind?: 'morning' | 'evening';
  evening?: EveningData | null;
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
  slides.push({ kind: 'title', title: hello, subtitle: `${dayName(now, b.tz)} · сводка бизнеса`, say: `${hello}. Сегодня ${dayName(now, b.tz)}. Вот сводка по бизнесу.` });
  if (alerts.length) {
    slides.push({ kind: 'alerts', title: 'Требует внимания', subtitle: `${alerts.length} ${alerts.length === 1 ? 'сигнал' : alerts.length < 5 ? 'сигнала' : 'сигналов'}`, items: alerts.slice(0, 8).map((a) => ({ level: a.level, title: a.title, detail: a.detail })) });
  } else {
    slides.push({ kind: 'alerts', title: 'Тревог нет', subtitle: 'всё спокойно', items: [{ level: 'info', title: 'Критичных сигналов нет', detail: 'Просрочек, зависших сделок и неотвеченных сообщений не найдено' }] });
  }
  if (b.dash) slides.push(...buildStatsDeck(b.dash).slides.filter((s) => s.kind !== 'title' && !(s.kind === 'text' && s.title.startsWith('Главное'))));
  if (b.club) {
    const c = b.club;
    slides.push({
      kind: 'kpis',
      title: 'Telegram-бот: клуб',
      items: [
        { label: 'Всего зашло', value: c.total },
        ...(c.last7Days ? [{ label: 'Зашли за 7 дней', value: c.last7Days.joined }, { label: 'Оплатили за 7 дней', value: c.last7Days.paid, tone: 'good' as Tone }] : []),
        { label: 'Платящих', value: c.paying, tone: 'good' },
        { label: 'С доступом сейчас', value: c.withAccess, tone: 'good' },
        { label: 'Оплачено', value: c.paidRub, unit: ' ₽', tone: 'good' },
      ],
    });
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
  return sanitizeDeck({ title: 'Утренняя сводка', source: 'Живые данные · CRM «Аквамастер», почта, чаты', autoplaySec: 8, narrate: true, slides: withSay(slides) });
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
  /** Вечерний отчёт сам по расписанию (по просьбе он открывается всегда). */
  eveningEnabled: boolean;
  eveningTime: string;
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
  kind: 'morning' | 'evening';
}
export interface BriefingStateDto {
  config: BriefingConfigDto;
  mail: MailAccountDto[];
  lastDate: string;
  crm: boolean;
}

// ---------- Вечерний отчёт ----------

/** Склонение: plural(5, 'заявка', 'заявки', 'заявок') → «5 заявок». */
export const plural = (n: number, a: string, b: string, c: string): string => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`;
};
const rub = (v: number): string => `${Math.round(v).toLocaleString('ru-RU')} ${plural(Math.round(v), 'рубль', 'рубля', 'рублей').split(' ').slice(1).join(' ')}`;
const k1 = (v: number): string => (Math.round(v * 10) / 10).toString().replace('.', ',');

/** Колода «Вечерний отчёт»: итоги дня по CRM (септики), клубу, почте и чатам — с графиками, спидометрами и текстом для озвучки каждого слайда. */
export function buildEveningDeck(b: BriefingData, alerts: AlertDto[]): DeckDto {
  const now = new Date(b.at);
  const e = b.evening ?? null;
  const slides: SlideDto[] = [];
  const hello = `${greetingFor(hourOf(now, b.tz))}${b.userName ? ', ' + b.userName : ''}`;
  const date = dayName(now, b.tz);
  slides.push({ kind: 'title', title: 'Вечерний отчёт', subtitle: date, say: `${hello}. Это вечерний отчёт за ${date}. Пройдусь по всем разделам: заявки и продажи, производство, клуб, почта, чаты и что оставить на завтра.` });

  if (e) {
    const t = e.today;
    const items: Extract<SlideDto, { kind: 'kpis' }>['items'] = [
      { label: 'Новых заявок', value: t.newDeals, tone: 'good' },
      { label: 'Выиграно сделок', value: t.won, tone: t.won ? 'good' : 'neutral' },
      { label: 'Сумма выигранных', value: t.wonRub, unit: ' ₽', tone: t.wonRub ? 'good' : 'neutral' },
      { label: 'Проиграно', value: t.lost, tone: t.lost ? 'warn' : 'good' },
    ];
    if (t.tasksDone !== null) items.push({ label: 'Закрыто задач', value: t.tasksDone, tone: 'good' });
    if (t.calls) items.push({ label: 'Звонков', value: t.calls.in + t.calls.out, note: `входящих ${t.calls.in} · исходящих ${t.calls.out}` });
    const parts = [`Новых заявок ${plural(t.newDeals, 'штука', 'штуки', 'штук').split(' ').join(' ')}`, `выиграно ${plural(t.won, 'сделка', 'сделки', 'сделок')}${t.wonRub ? ` на сумму ${rub(t.wonRub)}` : ''}`, `проиграно ${t.lost}`];
    if (t.tasksDone !== null) parts.push(`закрыто задач ${t.tasksDone}`);
    if (t.calls) parts.push(`звонков ${t.calls.in + t.calls.out}`);
    slides.push({ kind: 'kpis', title: 'Сегодня в CRM', subtitle: 'септики: заявки, продажи, задачи', items, say: `Сегодня в CRM. ${parts.join(', ')}.` });

    const gauges: Extract<SlideDto, { kind: 'gauges' }>['items'] = [
      { label: 'Заявки', value: t.newDeals, max: Math.max(1, Math.ceil(Math.max(e.avg.newPerDay * 2, t.newDeals))), note: `обычно ~${k1(e.avg.newPerDay)} в день`, tone: t.newDeals >= e.avg.newPerDay ? 'good' : 'warn' },
      { label: 'Выиграно', value: t.won, max: Math.max(1, Math.ceil(Math.max(e.avg.wonPerDay * 2, t.won))), note: `обычно ~${k1(e.avg.wonPerDay)} в день`, tone: t.won >= e.avg.wonPerDay ? 'good' : 'warn' },
    ];
    if (b.club?.today && b.club.last7Days) {
      const avgPaid = b.club.last7Days.paid / 7;
      gauges.push({ label: 'Оплаты клуба', value: b.club.today.paid, max: Math.max(1, Math.ceil(Math.max(avgPaid * 2, b.club.today.paid))), note: `обычно ~${k1(avgPaid)} в день`, tone: b.club.today.paid >= avgPaid ? 'good' : 'warn' });
    }
    const o = b.dash?.overview;
    if (o && o.tasksOpen > 0) gauges.push({ label: 'Просрочка задач', value: Math.round((o.tasksOverdue / o.tasksOpen) * 100), max: 100, unit: '%', note: `${o.tasksOverdue} из ${o.tasksOpen}`, tone: o.tasksOverdue / o.tasksOpen > 0.3 ? 'bad' : o.tasksOverdue ? 'warn' : 'good' });
    slides.push({
      kind: 'gauges',
      title: 'Темп дня',
      subtitle: 'стрелка — сегодня, шкала — до двойной нормы',
      items: gauges,
      say: `Спидометры показывают, как прошёл день на фоне обычного. ${gauges.map((g) => `${g.label}: ${g.value}${g.unit ?? ''}, ${g.note}`).join('. ')}.`,
    });

    const sumW = e.week.newPerDay.reduce((a, v) => a + v, 0);
    const bestIdx = e.week.newPerDay.indexOf(Math.max(...e.week.newPerDay));
    slides.push({
      kind: 'trend',
      title: 'Заявки и победы за 7 дней',
      subtitle: 'по дням, последний — сегодня',
      labels: e.dayLabels,
      series: [{ label: 'Новые заявки', values: e.week.newPerDay, tone: 'neutral' }, { label: 'Выиграно', values: e.week.wonPerDay, tone: 'good' }],
      say: `График за неделю. Всего заявок за семь дней ${sumW}, больше всего было в ${e.dayLabels[bestIdx] ?? 'один из дней'}: ${e.week.newPerDay[bestIdx] ?? 0}. Выиграно за неделю ${e.week.wonPerDay.reduce((a, v) => a + v, 0)}.`,
    });
  }

  if (b.dash) {
    const o = b.dash.overview;
    const open = o.pipelines.reduce((a, p) => a + p.open, 0);
    if (o.pipelines.length > 1) {
      const top = [...o.pipelines].sort((a, c) => c.open - a.open);
      slides.push({ kind: 'bars', title: 'В работе по направлениям', unit: 'шт', items: top.map((p) => ({ label: p.name, value: p.open, note: `выиграно ${p.won} · проиграно ${p.lost}` })), say: `Сейчас в работе ${plural(open, 'сделка', 'сделки', 'сделок')}. Больше всего в направлении «${top[0]!.name}»: ${top[0]!.open}.` });
    }
    slides.push({
      kind: 'kpis',
      title: 'Производство и склад',
      items: [
        { label: 'Заказов в работе', value: o.productionOpen },
        ...(e?.today.productionDone != null ? [{ label: 'Завершено сегодня', value: e.today.productionDone, tone: 'good' as Tone }] : []),
        { label: 'Просрочено', value: o.productionOverdue, tone: o.productionOverdue ? 'bad' : 'good' },
        { label: 'Материалов ниже минимума', value: o.lowStock, tone: o.lowStock ? 'warn' : 'good' },
      ],
      say: `Производство. В работе ${plural(o.productionOpen, 'заказ', 'заказа', 'заказов')}${e?.today.productionDone != null ? `, завершено сегодня ${e.today.productionDone}` : ''}. Просрочено ${o.productionOverdue}. Материалов ниже минимума: ${o.lowStock}.`,
    });
  }

  if (b.club) {
    const c = b.club;
    const td = c.today;
    slides.push({
      kind: 'kpis',
      title: 'Курс «Системно»: Telegram-бот',
      subtitle: td ? 'сегодня и в целом' : 'сегодняшние оплаты CRM пока не отдаёт — показан общий итог',
      items: [
        ...(td ? [{ label: 'Зашло сегодня', value: td.joined, tone: 'good' as Tone }, { label: 'Оплатили сегодня', value: td.paid, tone: 'good' as Tone }, { label: 'Оплат на сумму', value: td.paidRub, unit: ' ₽', tone: 'good' as Tone }] : []),
        { label: 'Всего зашло', value: c.total },
        { label: 'Платящих', value: c.paying, tone: 'good' },
        ...(!td ? [{ label: 'Оплачено всего', value: c.paidRub, unit: ' ₽', tone: 'good' as Tone }] : []),
      ],
      say: td
        ? `Курс Системно. За сегодня в бота зашло ${td.joined}, оплатили ${td.paid}${td.paidRub ? ` на сумму ${rub(td.paidRub)}` : ''}. Всего в боте ${c.total} человек, платящих ${c.paying}.`
        : `Курс Системно. Всего в боте ${c.total} человек, платящих ${c.paying}, оплачено ${rub(c.paidRub)}. Данных именно за сегодня CRM пока не отдаёт.`,
    });
    if (td?.payments?.length) {
      slides.push({ kind: 'table', title: 'Кто оплатил сегодня', columns: ['Кто', 'Сумма'], rows: td.payments.slice(0, 12).map((p) => [p.who, `${Math.round(p.amountRub).toLocaleString('ru-RU')} ₽`]), say: `Оплатили сегодня: ${td.payments.slice(0, 5).map((p) => p.who).join(', ')}${td.payments.length > 5 ? ' и другие' : ''}.` });
    }
    const steps = c.byStep.filter((x) => x.count > 0);
    if (steps.length) {
      const stuck = steps.reduce((a, x) => a + x.stuck, 0);
      slides.push({ kind: 'funnel', title: 'Воронка бота: кто на каком этапе', subtitle: '⚠ — застрявшие дольше 3 дней', stages: steps.map((x) => ({ label: `${x.step}${x.stuck ? ` (⚠ ${x.stuck})` : ''}`, value: x.count, tone: x.stuck > 0 ? ('bad' as Tone) : undefined })), say: `Воронка бота по этапам. Самый большой этап — «${steps[0]!.step}»: ${steps[0]!.count}. Застряло больше трёх дней: ${stuck}.` });
    }
  }

  slides.push(alerts.length
    ? { kind: 'alerts', title: 'Что оставить на завтра', subtitle: plural(alerts.length, 'сигнал', 'сигнала', 'сигналов'), items: alerts.slice(0, 8).map((a) => ({ level: a.level, title: a.title, detail: a.detail })), say: `На завтра. ${alerts.slice(0, 4).map((a) => a.title).join('. ')}.` }
    : { kind: 'alerts', title: 'Тревог нет', subtitle: 'всё спокойно', items: [{ level: 'info', title: 'Критичных сигналов нет' }], say: 'Тревог нет, всё спокойно.' });

  if (b.mail) {
    const imp = b.mail.items.filter((m) => m.important);
    slides.push(imp.length
      ? { kind: 'table', title: 'Важная почта', columns: ['Ящик', 'От кого', 'Тема', 'Почему'], rows: imp.slice(0, 10).map((m) => [m.account, m.from, m.subject, m.reasons.join(', ')]), say: `Важных непрочитанных писем ${imp.length}. Первое: от ${imp[0]!.from}, тема «${imp[0]!.subject}».` }
      : { kind: 'kpis', title: 'Почта', items: [{ label: 'Непрочитанных', value: b.mail.items.length }, { label: 'Важных', value: 0, tone: 'good' }], say: 'Важных непрочитанных писем нет.' });
  }
  if (b.chats) {
    const un = b.chats.items.filter((m) => m.unanswered);
    slides.push(un.length
      ? { kind: 'table', title: 'Рабочие чаты: без ответа', columns: ['Канал', 'От кого', 'Сообщение', 'Когда'], rows: un.slice(0, 10).map((m) => [m.channel, m.from, m.text, new Date(m.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone: b.tz })]), say: `В рабочих чатах без ответа ${un.length}. Первое сообщение от ${un[0]!.from} в ${un[0]!.channel}.` }
      : { kind: 'kpis', title: 'Рабочие чаты', items: [{ label: 'Сообщений за сутки', value: b.chats.items.length }, { label: 'Без ответа', value: 0, tone: 'good' }], say: 'Все сообщения в рабочих чатах отвечены.' });
  }

  const bullets: string[] = [];
  if (e) bullets.push(`Заявок ${e.today.newDeals}, выиграно ${e.today.won}${e.today.wonRub ? ` на ${Math.round(e.today.wonRub).toLocaleString('ru-RU')} ₽` : ''}, проиграно ${e.today.lost}.`);
  if (b.club?.today) bullets.push(`Клуб: зашло ${b.club.today.joined}, оплатили ${b.club.today.paid} на ${Math.round(b.club.today.paidRub).toLocaleString('ru-RU')} ₽.`);
  else if (b.club) bullets.push(`Клуб: всего ${b.club.total}, платящих ${b.club.paying}.`);
  bullets.push(alerts.length ? `Требует внимания: ${alerts.length}.` : 'Тревог нет.');
  if (b.missing.length) bullets.push(`Не удалось получить: ${b.missing.join('; ')}.`);
  slides.push({ kind: 'text', title: 'Итоги дня', bullets, say: `Это всё на сегодня. ${bullets.slice(0, 3).join(' ')} Хорошего вечера.` });
  return sanitizeDeck({ title: 'Вечерний отчёт', source: 'Живые данные · CRM «Аквамастер», курс, почта, чаты', autoplaySec: 9, narrate: true, slides: withSay(slides) });
}

/** Для вечернего отчёта голос уже встроен в слайды (say), отдельный текст не нужен — только короткое «открываю». */
export const eveningSpeech = (b: BriefingData): string => `${greetingFor(hourOf(new Date(b.at), b.tz))}${b.userName ? ', ' + b.userName : ''}. Открываю вечерний отчёт.`;

/** Текст для озвучки слайда, если готового нет: название и главные числа (без нейросети). */
export function autoSay(sl: SlideDto): string {
  const f = (v: number, u?: string): string => `${Math.round(v).toLocaleString('ru-RU')}${u ? u.replace(' ₽', ' рублей').replace('%', ' процентов') : ''}`;
  switch (sl.kind) {
    case 'title': return `${sl.title}. ${sl.subtitle ?? ''}`.trim();
    case 'kpis': return `${sl.title}. ${sl.items.slice(0, 6).map((i) => `${i.label}: ${f(i.value, i.unit)}`).join('. ')}.`;
    case 'bars': return `${sl.title}. ${sl.items.slice(0, 3).map((i) => `${i.label}: ${f(i.value)}`).join('. ')}.`;
    case 'funnel': return `${sl.title}. ${sl.stages.slice(0, 4).map((i) => `${i.label}: ${f(i.value)}`).join('. ')}.`;
    case 'donut': return `${sl.title}. ${sl.items.slice(0, 4).map((i) => `${i.label}: ${f(i.value)}`).join('. ')}.`;
    case 'table': return `${sl.title}. Строк: ${sl.rows.length}.`;
    case 'gauges': return `${sl.title}. ${sl.items.map((i) => `${i.label}: ${f(i.value, i.unit)}`).join('. ')}.`;
    case 'trend': return sl.title;
    case 'alerts': return `${sl.title}. ${sl.items.slice(0, 4).map((i) => i.title).join('. ')}.`;
    case 'text': return `${sl.title}. ${sl.bullets.slice(0, 3).join(' ')}`;
  }
}
const withSay = (slides: SlideDto[]): SlideDto[] => slides.map((x) => (x.say ? x : { ...x, say: autoSay(x) }));
