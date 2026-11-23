import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/core/providers/anthropic';
import { selectTools, TOPICS } from '../src/core/tools/select';
import { costUsd, priceOf, UsageService } from '../src/core/usage/service';
import { makeCore } from './helpers';

const json = (v: unknown): number => JSON.stringify(v).length;

describe('Экономия: только нужные инструменты', () => {
  const h = makeCore();
  const all = h.core.tools.specs();
  const names = (t: string, extra?: Partial<Parameters<typeof selectTools>[1]>): string[] => selectTools(all, { text: t, ...extra }).tools.map((x) => x.name);

  it('простая болтовня — только ядро (в разы меньше токенов), деловые просьбы подключают свои группы', () => {
    const chat = selectTools(all, { text: 'Привет! Как дела?' }).tools;
    expect(chat.length).toBeLessThan(15);
    expect(json(chat)).toBeLessThan(json(all) / 3);
    expect(chat.some((t) => t.name === 'tools_more')).toBe(true);
    expect(names('Покажи просроченные задачи в CRM')).toEqual(expect.arrayContaining(['crm_live_get', 'crm_tasks', 'show_deck']));
    expect(names('смонтируй ролик с субтитрами')).toEqual(expect.arrayContaining(['video_montage', 'video_list']));
    expect(names('смонтируй ролик с субтитрами')).not.toContain('crm_overview');
    expect(names('найди в интернете погоду')).toEqual(expect.arrayContaining(['browser_search']));
    expect(names('создай файл заметки.txt')).toEqual(expect.arrayContaining(['fs_write']));
    expect(names('привет')).not.toContain('browser_search');
  });

  it('продолжение разговора и уже использованные инструменты остаются; tools_more добавляет тему', () => {
    expect(names('да, давай', { recentText: 'покажи сделки в CRM' })).toContain('crm_live_get');
    expect(names('а теперь так же', { recentTools: ['video_montage'] })).toContain('video_montage');
    expect(names('сделай это', { extra: new Set(['calls']) }).some((n) => n.startsWith('call_') || n.startsWith('telephony_'))).toBe(true);
    expect(TOPICS.length).toBeGreaterThan(10);
  });

  it('инструмент tools_more зарегистрирован и объясняет темы', async () => {
    const t = h.core.tools.get('tools_more')!;
    expect(String(await t.execute({ topic: 'video' }, { runId: 'r', conversationId: 0, signal: new AbortController().signal }))).toContain('подключены');
    expect(() => t.execute({ topic: 'нет' }, { runId: 'r', conversationId: 0, signal: new AbortController().signal })).toThrow(/Неизвестная тема/);
  });
});

describe('Расходы: учёт токенов и цена', () => {
  it('цена по семейству модели; кэш дешевле; сводка по дням и моделям', () => {
    expect(priceOf('claude-haiku-5-5').input).toBeLessThan(priceOf('claude-sonnet-5-5').input);
    const base = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costUsd('claude-sonnet-5-5', base)).toBeCloseTo(3, 5);
    expect(costUsd('claude-sonnet-5-5', { ...base, input: 0, cacheRead: 1_000_000 })).toBeCloseTo(0.3, 5);
    const h = makeCore();
    const u = new UsageService(h.core.db, () => new Date('2026-11-23T10:00:00Z'));
    u.record('claude-haiku-5-5', { input: 10_000, output: 1000 });
    u.record('claude-haiku-5-5', { input: 5000, output: 500, cacheRead: 20_000 });
    const s = u.summary(2);
    expect(s.today.calls).toBe(2);
    expect(s.today.usd).toBeGreaterThan(0);
    expect(s.rows[0]).toMatchObject({ model: 'claude-haiku-5-5', calls: 2, input: 15_000, cacheRead: 20_000 });
    expect(u.todayUsd()).toBeCloseTo(s.today.usd, 2);
  });

  it('настройки: дневной лимит проверяется, по умолчанию лимит включён, а модель — самая дешёвая', () => {
    const h = makeCore();
    expect(h.core.getSettings()).toMatchObject({ dailyBudgetUsd: 3, smartTools: true, model: 'claude-haiku-5-5' });
    expect(() => h.core.updateSettings({ dailyBudgetUsd: -1 })).toThrow(/лимит/);
    h.core.updateSettings({ dailyBudgetUsd: 0.5 });
    expect(h.core.usageSummary().budgetUsd).toBe(0.5);
  });
});

describe('Кэш подсказок Anthropic', () => {
  it('системная подсказка и инструменты кэшируются, время («Сейчас») вынесено из кэша, история кэшируется до последнего блока; расход токенов сообщается', async () => {
    const p = new AnthropicProvider('sk-ant-test');
    let params: Record<string, unknown> = {};
    const handlers: Record<string, (x?: unknown) => void> = {};
    const fake = {
      messages: {
        stream: (pr: Record<string, unknown>) => {
          params = pr;
          const s = {
            on: (e: string, cb: (x?: unknown) => void) => ((handlers[e] = cb), s),
            finalMessage: async () => ({ content: [], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } }),
          };
          return s;
        },
      },
    };
    (p as unknown as { client: unknown }).client = fake;
    const events: { type: string }[] = [];
    for await (const ev of p.stream({ system: 'Ты ассистент.\nСейчас: 23 ноября, 10:00.\nПравила.', messages: [{ role: 'user', content: [{ type: 'text', text: 'привет' }] }], tools: [{ name: 'a', description: 'a', inputSchema: { type: 'object', properties: {} } }, { name: 'b', description: 'b', inputSchema: { type: 'object', properties: {} } }], model: 'claude-haiku-5-5', maxTokens: 100 }, new AbortController().signal)) events.push(ev);
    const sys = params['system'] as { text: string; cache_control?: unknown }[];
    expect(sys[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[0]!.text).not.toContain('Сейчас:');
    expect(sys[1]).toEqual({ type: 'text', text: 'Сейчас: 23 ноября, 10:00.' });
    const tools = params['tools'] as { name: string; cache_control?: unknown }[];
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: 'ephemeral' });
    const msgs = params['messages'] as { content: { cache_control?: unknown }[] }[];
    expect(msgs.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(events).toContainEqual({ type: 'usage', model: 'claude-haiku-5-5', input: 100, output: 20, cacheRead: 5000, cacheWrite: 300 });
  });
});
