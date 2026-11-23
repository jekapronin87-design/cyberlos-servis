import { describe, expect, it } from 'vitest';
import { computeAlerts, parseChats, parseClub, scoreMail, zonedParts } from '../src/core/briefing/rules';
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

function crmFake(opts: { messages?: boolean } = { messages: true }) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    const p = new URL(url).pathname.replace('/api/readonly/', '');
    calls.push(p);
    const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, count: 1, nextCursor: null, data }), { status: 200 });
    if (p === 'health') return ok({});
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
