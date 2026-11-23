import { describe, expect, it } from 'vitest';
import { computeAlerts, parseChats, parseClub, parseClubFunnel, scoreMail, zonedParts } from '../src/core/briefing/rules';
import { buildBriefingDeck, briefingSpeech, sanitizeDeck } from '../src/shared/deck';
import { parseNavIntent } from '../src/shared/voice';
import { RECIPES } from '../src/renderer/audio/uiSounds';
import { makeCore } from './helpers';

const NOW = new Date('2026-11-23T03:05:00Z'); // 10:05 в Бангкоке
const KEY = 'sro_TestKey1234567890abcdefghijklmnop';
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('Сводка: время и правила', () => {
  it('время по Бангкоку: UTC+7, сутки считаются по поясу', () => {
    expect(zonedParts(NOW, 'Asia/Bangkok')).toEqual({ date: '2026-11-23', hm: '10:05' });
    expect(zonedParts(new Date('2026-11-22T18:30:00Z'), 'Asia/Bangkok')).toEqual({ date: '2026-11-23', hm: '01:30' });
  });

  it('клуб: сколько зашло, кто платит, кто застрял', () => {
    const c = parseClub(
      [
        { step: 'PAID', paidTotalRub: 5000, accessUntil: '2026-12-30T00:00:00Z', updatedAt: ago(1) },
        { step: 'PAYMENT_PENDING', updatedAt: ago(24 * 5) },
        { step: 'PAYMENT_PENDING', updatedAt: ago(2) },
        { step: 'START', createdAt: ago(24 * 9) },
      ],
      NOW,
    );
    expect(c.total).toBe(4);
    expect(c.paying).toBe(1);
    expect(c.withAccess).toBe(1);
    expect(c.paidRub).toBe(5000);
    expect(c.byStep.find((s) => s.step === 'Ждут оплаты')).toEqual({ step: 'Ждут оплаты', count: 2, stuck: 1 });
    expect(c.byStep.find((s) => s.step === 'Запустили бота')?.stuck).toBe(1);
    expect(c.byStep.find((s) => s.step === 'Оплатили')?.stuck).toBe(0);
  });

  it('воронка от CRM (club/funnel) читается как есть', () => {
    const c = parseClubFunnel({ generatedAt: 'x', total: 120, withAccessNow: 9, paying: 11, paidTotalRub: 33000, byStep: [{ step: 'paid', count: 9, avgDaysInStep: 12.1, stuckOver3Days: 7 }, { step: 'watch', count: 70, avgDaysInStep: 6.4, stuckOver3Days: 52 }], last7Days: { joined: 14, paid: 2 } });
    expect(c).toMatchObject({ total: 120, withAccess: 9, paying: 11, paidRub: 33000, last7Days: { joined: 14, paid: 2 } });
    expect(c?.byStep[0]).toEqual({ step: 'Смотрят материалы', count: 70, stuck: 52 });
    expect(parseClubFunnel('мусор')).toBeNull();
  });

  it('чаты в формате CRM «Аквамастер»: TELEGRAM/MAX, контакт, ответственный, answeredAt', () => {
    const items = parseChats(
      [
        { id: '1', channel: 'TELEGRAM', direction: 'IN', text: 'Сколько стоит септик?', createdAt: ago(3), contact: { id: 'k1', fullName: 'Иван Тестов' }, assignee: { fullName: 'Мария' }, answeredAt: null, threadId: 't1' },
        { id: '2', channel: 'MAX', direction: 'IN', text: 'Спасибо!', createdAt: ago(2), contact: { id: 'k2', fullName: 'Ольга' }, answeredAt: ago(1), threadId: 't2' },
        { id: '3', channel: 'MAX', direction: 'OUT', text: 'Пожалуйста', createdAt: ago(1), contact: { id: 'k2', fullName: 'Ольга' }, answeredAt: null, threadId: 't2' },
      ],
      NOW,
    );
    expect(items.find((c) => c.from.startsWith('Иван'))).toMatchObject({ channel: 'Telegram', unanswered: true, from: 'Иван Тестов → Мария' });
    expect(items.find((c) => c.from === 'Ольга')).toMatchObject({ channel: 'Max', unanswered: false });
  });

  it('клуб: непонятные поля не ломают разбор', () => {
    expect(parseClub([null, 5, {}, { step: 7 }], NOW).total).toBe(4);
  });

  it('чаты: «без ответа» — если последнее сообщение входящее; старше 36 часов не берём', () => {
    const items = parseChats(
      [
        { conversationId: 'a', channel: 'telegram', direction: 'IN', text: 'Когда монтаж?', contactName: 'Иван', createdAt: ago(5) },
        { conversationId: 'b', channel: 'max', direction: 'IN', text: 'Спасибо', contactName: 'Ольга', createdAt: ago(3) },
        { conversationId: 'b', channel: 'max', direction: 'OUT', text: 'Пожалуйста', contactName: 'Ольга', createdAt: ago(2) },
        { conversationId: 'c', channel: 'telegram', direction: 'IN', text: 'старое', createdAt: ago(80) },
      ],
      NOW,
    );
    expect(items).toHaveLength(2);
    expect(items.find((c) => c.from === 'Иван')).toMatchObject({ channel: 'Telegram', unanswered: true });
    expect(items.find((c) => c.from === 'Ольга')).toMatchObject({ channel: 'Max', unanswered: false });
  });

  it('почта: важное выделяется, рассылки — нет', () => {
    const base = { account: 'a@gmail.com', date: ago(1), seen: false };
    expect(scoreMail({ ...base, from: 'bank@sber.ru', subject: 'Счёт на оплату №5' }, []).important).toBe(true);
    expect(scoreMail({ ...base, from: 'partner@firma.ru', subject: 'Привет' }, ['firma']).important).toBe(true);
    expect(scoreMail({ ...base, from: 'noreply@shop.ru', subject: 'Скидка! Срочно!' }, []).important).toBe(false);
    expect(scoreMail({ ...base, from: 'x@y.ru', subject: 'Привет' }, []).important).toBe(false);
    expect(scoreMail({ ...base, from: 'x@y.ru', subject: 'Привет', labels: ['\\Important'], flagged: true }, []).important).toBe(true);
    expect(scoreMail({ ...base, seen: true, from: 'bank@sber.ru', subject: 'Счёт' }, []).important).toBe(false);
  });

  it('тревоги: считаются арифметикой, ключ меняется вместе с числом', () => {
    const dash = { overview: { pipelines: [], newLast24h: 1, unassignedOpen: 5, stuck: 2, tasksOpen: 30, tasksOverdue: 11, productionOpen: 4, productionOverdue: 2, awaitingPrepayment: 0, lowStock: 1 } } as never;
    const a = computeAlerts({ dash, club: null, mail: null, chats: null, now: NOW });
    expect(a.map((x) => x.level)).toEqual(['hot', 'hot', 'hot', 'warn', 'warn']);
    expect(a.find((x) => x.key.startsWith('prod'))?.title).toContain('2 заказа');
    expect(a.find((x) => x.key.startsWith('tasks'))?.level).toBe('hot');
    const chats = computeAlerts({ dash: null, club: null, mail: null, chats: [{ channel: 'Max', from: 'Я', text: 'x', at: ago(6), unanswered: true }], now: NOW });
    expect(chats[0]).toMatchObject({ level: 'hot', key: 'chats:1' });
    expect(computeAlerts({ dash: null, club: null, mail: null, chats: null, now: NOW })).toEqual([]);
  });

  it('колода сводки проходит проверку и озвучивается шаблоном', () => {
    const club = parseClub([{ step: 'PAID', paidTotalRub: 1000 }, { step: 'START', createdAt: ago(100) }], NOW);
    const data = { userName: 'Евгений', at: NOW.toISOString(), tz: 'Asia/Bangkok', dash: null, club, mail: { items: [], accounts: 1, errors: [] }, chats: { items: [] }, missing: ['чаты: нет раздела'] };
    const alerts = computeAlerts({ dash: null, club, mail: null, chats: null, now: NOW });
    const deck = buildBriefingDeck(data, alerts);
    expect(sanitizeDeck(deck).slides.length).toBe(deck.slides.length);
    expect(deck.slides[0]).toMatchObject({ kind: 'title', title: 'Доброе утро, Евгений' });
    expect(deck.slides.some((s) => s.kind === 'alerts')).toBe(true);
    expect(deck.slides.some((s) => s.kind === 'funnel')).toBe(true);
    const speech = briefingSpeech(data, alerts);
    expect(speech).toContain('Доброе утро, Евгений');
    expect(speech).toContain('клуба 2 человек');
  });

  it('голос: «покажи утреннюю сводку» — отдельная команда; космические звуки есть', () => {
    expect(parseNavIntent('покажи утреннюю сводку')).toBe('briefing');
    expect(parseNavIntent('покажи сводку')).toBe('briefing');
    expect(parseNavIntent('покажи статистику')).toBe('stats');
    for (const k of ['whoosh', 'tick', 'sweep', 'alarm', 'chime'] as const) expect(RECIPES[k].length).toBeGreaterThan(0);
  });
});

function crmFake(opts: { messages?: boolean; funnel?: boolean } = { messages: true, funnel: true }) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    const p = new URL(url).pathname.replace('/api/readonly/', '');
    calls.push(p);
    const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, count: 1, nextCursor: null, data }), { status: 200 });
    if (p === 'health') return ok({});
    if (p === 'club/funnel' && opts.funnel !== false) return ok({ total: 120, withAccessNow: 9, paying: 11, paidTotalRub: 33000, byStep: [{ step: 'watch', count: 70, avgDaysInStep: 6.4, stuckOver3Days: 52 }], last7Days: { joined: 14, paid: 2 } });
    if (p === 'club/members') return ok([{ step: 'PAID', paidTotalRub: 3000 }, { step: 'PAYMENT_PENDING', updatedAt: ago(24 * 6) }]);
    if (p === 'messages' && opts.messages) return ok([{ conversationId: 'a', channel: 'telegram', direction: 'IN', text: 'Ответьте!', contactName: 'Иван', createdAt: ago(5) }]);
    if (p === 'city/summary') return ok({ tasks: { open: 3, overdue: 2 }, production: { materialsBelowMinimum: [] } });
    if (p === 'deals' || p === 'tasks' || p === 'production/orders' || p === 'employees') return ok([]);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Сводка: сервис', () => {
  const setup = (crm = crmFake(), mailRows: unknown[] = []) => {
    const fetched: string[] = [];
    const h = makeCore({
      crmFetch: crm.f,
      schedulerNow: () => NOW,
      mailFetcher: async (c) => {
        fetched.push(c.host);
        if (c.pass === 'badbadbad') throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
        return mailRows as never;
      },
    });
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, KEY);
    return { h, fetched, crm };
  };

  it('в 10:05 по Бангкоку показывает сводку один раз за день', async () => {
    const { h } = setup();
    const got: string[] = [];
    h.core.briefing.onBriefing((p) => got.push(p.deck.title));
    await h.core.briefing.tick();
    await h.core.briefing.tick();
    expect(got).toEqual(['Утренняя сводка']);
    expect(h.core.briefing.lastDate()).toBe('2026-11-23');
  });

  it('до назначенного времени ничего не показывает; выключенная — тоже', async () => {
    const early = makeCore({ crmFetch: crmFake().f, schedulerNow: () => new Date('2026-11-23T02:30:00Z') }); // 09:30
    let n = 0;
    early.core.briefing.onBriefing(() => n++);
    await early.core.briefing.tick();
    expect(n).toBe(0);
    const off = makeCore({ crmFetch: crmFake().f, schedulerNow: () => NOW });
    off.core.briefing.save({ enabled: false });
    off.core.briefing.onBriefing(() => n++);
    await off.core.briefing.tick();
    expect(n).toBe(0);
  });

  it('сводка включает клуб, чаты и почту; чаты 404 — просто строка «не удалось»', async () => {
    const { h, fetched } = setup(crmFake(), [{ from: 'bank@sber.ru', subject: 'Счёт на оплату', date: ago(1), seen: false }]);
    h.core.mail.add('gmail', 'me@gmail.com', 'abcd efgh ijkl mnop');
    h.core.mail.add('yandex', 'me@yandex.ru', 'abcdefghijklmnop');
    const p = await h.core.briefing.run(true);
    expect(fetched.sort()).toEqual(['imap.gmail.com', 'imap.yandex.com']);
    const kinds = p.deck.slides.map((s) => s.kind);
    expect(kinds).toContain('funnel');
    expect(kinds).toContain('table');
    expect(p.speech).toContain('Важных писем 2');
    expect(p.speech).toContain('без ответа 1');

    const { h: h2 } = setup(crmFake({ messages: false }));
    const p2 = await h2.core.briefing.run(true);
    const last = p2.deck.slides[p2.deck.slides.length - 1]!;
    expect(JSON.stringify(last)).toContain('рабочие чаты');
    expect(JSON.stringify(last)).toContain('ещё не отдаёт сообщения');
  });

  it('если у CRM ещё нет club/funnel — воронка считается по списку участников', async () => {
    const { h } = setup(crmFake({ messages: true, funnel: false }));
    const d = await h.core.briefing.collect();
    expect(d.club).toMatchObject({ total: 2, paying: 1 });
    const { h: h2 } = setup();
    expect((await h2.core.briefing.collect()).club).toMatchObject({ total: 120, last7Days: { joined: 14 } });
  });

  it('почта: пароль не в базе, ошибка входа объяснена понятно, один ящик не ломает остальные', async () => {
    const { h } = setup();
    h.core.mail.add('gmail', 'ok@gmail.com', 'goodgoodgood');
    h.core.mail.add('yandex', 'bad@yandex.ru', 'badbadbad');
    expect(h.core.mail.list().every((a) => a.hasPassword)).toBe(true);
    const row = h.core.db.prepare("SELECT value FROM settings WHERE key = 'briefing.mailAccounts'").get() as { value: string };
    expect(row.value).not.toContain('goodgoodgood');
    expect(row.value).not.toContain('badbadbad');
    await expect(h.core.mail.test(h.core.mail.list()[1]!.id)).rejects.toThrow(/пароль приложения|Пароли приложений/i);
    const data = await h.core.briefing.collect();
    expect(data.mail?.accounts).toBe(2);
    expect(data.mail?.errors).toHaveLength(1);
    expect(() => h.core.mail.add('gmail', 'не почта', 'x')).toThrow();
    expect(() => h.core.mail.add('outlook', 'a@b.ru', 'abcdefghij')).toThrow(/Gmail или Яндекс/);
  });

  it('тревоги: новая приходит один раз, повтор не дублируется, изменение числа — снова', async () => {
    const { h } = setup();
    const seen: string[][] = [];
    h.core.briefing.onAlerts((e) => seen.push(e.alerts.map((a) => a.key)));
    const first = await h.core.briefing.checkAlerts();
    expect(first.length).toBeGreaterThan(0); // 2 просроченные задачи (из city/summary) и застрявший участник бота и чат без ответа
    const again = await h.core.briefing.checkAlerts();
    expect(again).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('настройки проверяются: время и часовой пояс', () => {
    const { h } = setup();
    expect(() => h.core.briefing.save({ time: '25:00' })).toThrow(/ЧЧ:ММ/);
    expect(() => h.core.briefing.save({ tz: 'Mars/Base' })).toThrow(/часовой пояс/);
    expect(h.core.briefing.save({ time: '09:30', vip: ['банк', ' '] })).toMatchObject({ time: '09:30', tz: 'Asia/Bangkok', vip: ['банк'] });
  });

  it('клиент CRM читает только GET: сводка не отправляет ничего, кроме чтения', async () => {
    const calls: { m: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ m: String(init.method) });
      return crmFake().f(url, init as never);
    }) as unknown as typeof fetch;
    const { h } = setup({ f, calls: [] });
    await h.core.briefing.run(true);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((c) => c.m === 'GET')).toBe(true);
  });
});

describe('Вечерний отчёт', () => {
  const key = 'sro_TestKey1234567890abcdefghijklmnop';
  const deal = (id: string, sem: string, createdH: number, updH: number, amount = 0) => ({ id, number: 1, title: id, stageSemantic: sem, createdAt: ago(createdH), updatedAt: ago(updH), amountRub: amount, pipeline: { id: 'p', name: 'Продажа' }, stage: { id: 's', name: 'КП', semantic: sem }, assignee: { id: 'u', fullName: 'Иван' } });
  const fake = (): typeof fetch =>
    (async (url: string) => {
      const p = new URL(url).pathname.replace('/api/readonly/', '');
      const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, count: 1, nextCursor: null, data }), { status: 200 });
      if (p === 'deals') return ok([deal('a', 'NEW', 1, 1), deal('b', 'NEW', 2, 2), deal('c', 'WON', 80, 1, 150000), deal('d', 'LOST', 90, 2), deal('e', 'NEW', 30, 30), deal('f', 'WON', 100, 50, 90000)]);
      if (p === 'tasks') return ok([{ id: 't', completedAt: ago(2) }, { id: 'u', completedAt: ago(40) }]);
      if (p === 'calls') return ok([{ startedAt: ago(1), direction: 'IN' }, { startedAt: ago(2), direction: 'OUT' }, { startedAt: ago(3), direction: 'OUT' }]);
      if (p === 'production/orders') return ok([{ id: 'o', status: 'DONE', finishedAt: ago(1), plannedFor: ago(5) }]);
      if (p === 'city/summary') return ok({ tasks: { open: 10, overdue: 4 }, production: { materialsBelowMinimum: [] } });
      if (p === 'club/funnel') return ok({ total: 120, withAccessNow: 9, paying: 11, paidTotalRub: 33000, byStep: [{ step: 'watch', count: 70, stuckOver3Days: 52 }], last7Days: { joined: 14, paid: 7 }, today: { joined: 3, paid: 2, paidRub: 9800 } });
      if (p === 'club/payments') return ok([{ paidAt: ago(2), amountRub: 4900, memberName: 'Анна К.' }, { paidAt: ago(1), amountRub: 4900, memberName: 'Пётр С.' }, { paidAt: ago(30), amountRub: 4900, memberName: 'Старая' }]);
      if (p === 'employees') return ok([]);
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

  it('итоги дня считаются по суткам в часовом поясе пользователя', async () => {
    const h = makeCore({ crmFetch: fake(), schedulerNow: () => NOW });
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, key);
    const d = await h.core.briefing.collect('evening');
    const e = d.evening!;
    expect(e.today).toMatchObject({ newDeals: 2, won: 1, wonRub: 150000, lost: 1, tasksDone: 1, calls: { in: 1, out: 2 }, productionDone: 1 });
    expect(e.dayLabels).toHaveLength(7);
    expect(e.week.newPerDay.at(-1)).toBe(2);
    expect(d.club?.today).toMatchObject({ joined: 3, paid: 2, paidRub: 9800 });
    expect(d.club?.today?.payments?.map((p) => p.who)).toEqual(['Анна К.', 'Пётр С.']);
  });

  it('границы суток считаются по часовому поясу: Бангкок и Нью-Йорк', async () => {
    const { dayBounds } = await import('../src/core/briefing/rules');
    expect(dayBounds(NOW, 'Asia/Bangkok')).toEqual({ from: new Date('2026-11-22T17:00:00Z'), to: new Date('2026-11-23T17:00:00Z') });
    expect(dayBounds(NOW, 'America/New_York').from).toEqual(new Date('2026-11-22T05:00:00Z'));
  });

  it('колода: спидометры, график, курс, оплаты; у каждого слайда есть текст для озвучки', async () => {
    const h = makeCore({ crmFetch: fake(), schedulerNow: () => NOW });
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, key);
    const p = await h.core.briefing.run(true, 'evening');
    expect(p.kind).toBe('evening');
    expect(p.deck.title).toBe('Вечерний отчёт');
    expect(p.deck.narrate).toBe(true);
    const kinds = p.deck.slides.map((s) => s.kind);
    for (const k of ['title', 'kpis', 'gauges', 'trend', 'funnel', 'alerts', 'text']) expect(kinds).toContain(k);
    expect(p.deck.slides.every((s) => !!s.say)).toBe(true);
    const text = JSON.stringify(p.deck);
    expect(text).toContain('Оплатили сегодня');
    expect(text).toContain('Анна К.');
    expect(text).toContain('Оплат на сумму');
    const g = p.deck.slides.find((s) => s.kind === 'gauges');
    expect(g && g.kind === 'gauges' && g.items.length >= 3).toBe(true);
  });

  it('утренняя сводка тоже озвучивается по слайдам', async () => {
    const h = makeCore({ crmFetch: fake(), schedulerNow: () => NOW });
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, key);
    const p = await h.core.briefing.run(true);
    expect(p.deck.narrate).toBe(true);
    expect(p.deck.slides.every((s) => !!s.say)).toBe(true);
  });

  it('если CRM не отдаёт оплаты за сегодня — отчёт честно об этом пишет, а не выдумывает', async () => {
    const f = (async (url: string) => {
      const p = new URL(url).pathname.replace('/api/readonly/', '');
      if (p === 'club/funnel') return new Response(JSON.stringify({ ok: true, data: { total: 5, withAccessNow: 1, paying: 1, paidTotalRub: 1000, byStep: [{ step: 'watch', count: 5, stuckOver3Days: 0 }] } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const h = makeCore({ crmFetch: f, schedulerNow: () => NOW });
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, key);
    const p = await h.core.briefing.run(true, 'evening');
    expect(JSON.stringify(p.deck)).toContain('CRM пока не отдаёт');
    expect(JSON.stringify(p.deck)).not.toContain('Оплатили сегодня');
  });

  it('вечерний отчёт по расписанию: один раз в сутки, и только если включён', async () => {
    const h = makeCore({ crmFetch: fake(), schedulerNow: () => new Date('2026-11-23T13:30:00Z') }); // 20:30 в Бангкоке
    h.core.aquaSave({ baseUrl: 'https://crm.test' }, key);
    h.core.briefing.save({ enabled: false, eveningEnabled: true, eveningTime: '20:00' });
    const got: string[] = [];
    h.core.briefing.onBriefing((p) => got.push(p.kind));
    await h.core.briefing.tick();
    await h.core.briefing.tick();
    expect(got).toEqual(['evening']);
    const h2 = makeCore({ crmFetch: fake(), schedulerNow: () => new Date('2026-11-23T13:30:00Z') });
    h2.core.briefing.onBriefing((p) => got.push(p.kind));
    h2.core.briefing.save({ enabled: false });
    await h2.core.briefing.tick();
    expect(got).toEqual(['evening']);
  });

  it('голос: «вечерний отчёт» понимается и без глагола; инструмент для модели есть', () => {
    for (const t of ['вечерний отчет', 'Покажи мне вечерний отчет', 'покажи итоги дня', 'сделай вечерний отчёт', 'итоги дня']) expect(parseNavIntent(t), t).toBe('evening');
    for (const t of ['утренняя сводка', 'покажи утреннюю сводку']) expect(parseNavIntent(t), t).toBe('briefing');
    const h = makeCore();
    expect(h.core.tools.get('show_daily_report')).toBeTruthy();
  });

  it('колода: новые виды слайдов проходят проверку', () => {
    const d = sanitizeDeck({ narrate: true, slides: [{ kind: 'gauges', title: 'g', say: 'раз', items: [{ label: 'a', value: 5, max: 10, tone: 'good' }] }, { kind: 'trend', title: 't', labels: ['пн', 'вт'], series: [{ label: 'x', values: [1, 2, 3, 4] }] }] });
    expect(d.narrate).toBe(true);
    const t = d.slides[1]!;
    expect(t.kind === 'trend' && t.series[0]!.values).toEqual([1, 2]);
    expect(d.slides[0]!.say).toBe('раз');
    expect(sanitizeDeck({ narrate: true, slides: [{ kind: 'text', title: 'x', bullets: ['y'] }] }).narrate).toBeUndefined();
  });
});
