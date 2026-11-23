import { describe, expect, it } from 'vitest';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';
import { chat, makeCore } from './helpers';

const scripted = (fn: (req: ProviderRequest, n: number) => ProviderEvent[]): ChatProvider & { reqs: ProviderRequest[] } => {
  let n = 0;
  const reqs: ProviderRequest[] = [];
  return { id: 'anthropic', name: 's', reqs, async *stream(r) { reqs.push(r); for (const e of fn(r, ++n)) yield e; } };
};

function setup(p: ChatProvider) {
  const h = makeCore({ liveProvider: p });
  h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
  return h;
}

describe('Чат: экономия и дневной лимит', () => {
  it('на «привет» модели уходит малая часть инструментов, на деловую просьбу — нужные группы; расход записывается', async () => {
    const p = scripted(() => [{ type: 'text', text: 'Готово.' }, { type: 'usage', model: 'claude-haiku-5-5', input: 1200, output: 40, cacheRead: 0, cacheWrite: 800 }]);
    const h = setup(p);
    await chat(h, 'Привет!');
    await chat(h, 'Покажи просроченные задачи в CRM');
    expect(p.reqs[0]!.tools.length).toBeLessThan(15);
    expect(p.reqs[1]!.tools.length).toBeGreaterThan(p.reqs[0]!.tools.length);
    expect(p.reqs[1]!.tools.some((t) => t.name === 'crm_live_get')).toBe(true);
    expect(p.reqs[0]!.tools.some((t) => t.name === 'crm_live_get')).toBe(false);
    const u = h.core.usageSummary();
    expect(u.today.calls).toBe(2);
    expect(u.rows[0]).toMatchObject({ model: 'claude-haiku-5-5', input: 2400, cacheWrite: 1600 });
  });

  it('выключили экономию — уходят все инструменты', async () => {
    const p = scripted(() => [{ type: 'text', text: 'ok' }]);
    const h = setup(p);
    h.core.updateSettings({ smartTools: false });
    await chat(h, 'Привет!');
    expect(p.reqs[0]!.tools.length).toBeGreaterThan(60);
  });

  it('tools_more: модель просит тему — на следующем шаге инструменты появляются', async () => {
    const p = scripted((_r, n) => (n === 1 ? [{ type: 'tool_use', id: 't1', name: 'tools_more', input: { topic: 'video' } }] : [{ type: 'text', text: 'Теперь вижу.' }]));
    const h = setup(p);
    await chat(h, 'Сделай что-нибудь полезное');
    expect(p.reqs[0]!.tools.some((t) => t.name === 'video_montage')).toBe(false);
    expect(p.reqs[1]!.tools.some((t) => t.name === 'video_montage')).toBe(true);
  });

  it('дневной лимит: после превышения запросы к Claude не уходят, объяснение понятное; лимит 0 — без ограничений', async () => {
    const p = scripted(() => [{ type: 'text', text: 'ответ' }, { type: 'usage', model: 'claude-sonnet-5-5', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }]);
    const h = setup(p);
    h.core.updateSettings({ dailyBudgetUsd: 2 });
    const first = await chat(h, 'Привет');
    expect(first.events.some((e) => e.type === 'run_finished' && e.status === 'done')).toBe(true); // $3 потрачено этим запросом
    const second = await chat(h, 'Ещё раз');
    const fin = second.events.find((e) => e.type === 'run_finished') as { status: string; error?: string };
    expect(fin.status).toBe('error');
    expect(fin.error).toMatch(/дневной лимит расходов на Claude/);
    expect(p.reqs).toHaveLength(1);
    h.core.updateSettings({ dailyBudgetUsd: 0 });
    const third = await chat(h, 'Снова');
    expect((third.events.find((e) => e.type === 'run_finished') as { status: string }).status).toBe('done');
  });
});
