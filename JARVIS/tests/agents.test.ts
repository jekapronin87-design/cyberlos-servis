import { describe, expect, it } from 'vitest';
import { toolsForAgent } from '../src/core/agents/groups';
import { AGENT_TEMPLATES, validateAgent } from '../src/core/agents/service';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';
import type { AgentInputDto } from '../src/shared/types';
import { makeCore } from './helpers';

const base: AgentInputDto = {
  name: 'Аналитик',
  description: 'тест',
  instructions: 'Смотри на CRM и делай краткие выводы по заявкам.',
  groups: ['crm'],
  mode: 'read',
  schedule: { kind: 'none', atTime: null, intervalMin: null },
  enabled: false,
};

const scripted = (fn: (req: ProviderRequest, n: number) => ProviderEvent[]): ChatProvider & { reqs: ProviderRequest[] } => {
  let n = 0;
  const reqs: ProviderRequest[] = [];
  return { id: 's', name: 's', reqs, async *stream(r) { reqs.push(r); for (const e of fn(r, ++n)) yield e; } };
};
const say = (t: string): ProviderEvent[] => [{ type: 'text', text: t }];

function setup(provider?: ChatProvider, now?: { d: Date }) {
  const events: unknown[] = [];
  const h = makeCore({ ...(provider ? { liveProvider: provider } : {}), ...(now ? { schedulerNow: () => now.d } : {}), onAgent: (e) => events.push(e) });
  if (provider) h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
  return { h, events };
}

describe('агенты: проверка ввода и права', () => {
  it('имя, инструкция, группы и расписание проверяются', () => {
    expect(() => validateAgent({ ...base, name: 'А' })).toThrow(/Имя/);
    expect(() => validateAgent({ ...base, instructions: 'коротко' })).toThrow(/Инструкция/);
    expect(() => validateAgent({ ...base, groups: ['root' as never] })).toThrow(/группа/);
    expect(() => validateAgent({ ...base, schedule: { kind: 'daily', atTime: '25:00', intervalMin: null } })).toThrow(/ЧЧ:ММ/);
    expect(() => validateAgent({ ...base, schedule: { kind: 'interval', atTime: null, intervalMin: 1 } })).toThrow(/Интервал/);
    expect(validateAgent({ ...base, groups: ['crm', 'crm'] }).groups).toEqual(['crm']);
    for (const t of AGENT_TEMPLATES) expect(() => validateAgent(t.input), t.key).not.toThrow();
  });

  it('набор инструментов: только выбранные группы; «только чтение» не даёт изменяющих; рекурсии и изменения памяти нет никогда', () => {
    const h = makeCore();
    const names = (g: AgentInputDto['groups'], m: 'read' | 'act') => [...toolsForAgent(g, m, h.core.tools)];
    const crm = names(['crm'], 'read');
    expect(crm.every((n) => n.startsWith('crm_') || ['get_datetime', 'list_memory'].includes(n))).toBe(true);
    expect(crm).toContain('crm_overview');
    const all = names(['web', 'crm', 'knowledge', 'telegram', 'files', 'apps', 'dev', 'images', 'screen'], 'act');
    for (const bad of ['agent_run', 'agent_create', 'agent_delete', 'agent_list', 'delegate_task', 'schedule_create', 'schedule_delete', 'remember', 'forget_memory', 'profile_save']) expect(all).not.toContain(bad);
    expect(all).toContain('telegram_send');
    expect(all).toContain('browser_click');
    const readAll = names(['web', 'telegram', 'files', 'apps', 'images'], 'read');
    for (const bad of ['telegram_send', 'browser_click', 'browser_type', 'fs_write', 'fs_delete', 'image_generate', 'app_open']) expect(readAll, bad).not.toContain(bad);
    expect(readAll).toContain('telegram_read');
    expect(readAll).toContain('browser_read');
  });
});

describe('агенты: запуск', () => {
  it('без модели (демо) запуск невозможен с понятной причиной', () => {
    const { h } = setup();
    const a = h.core.saveAgent(base);
    expect(() => h.core.startAgent(a.id, '')).toThrow(/нужна настоящая модель/);
  });

  it('агент работает циклом «модель → инструменты», отчёт и шаги сохраняются, в журнале — от имени агента', async () => {
    const provider = scripted((_r, n) => (n === 1 ? [{ type: 'tool_use', id: 't', name: 'get_datetime', input: {} }] : say('Итог: всё в порядке.')));
    const { h } = setup(provider);
    const a = h.core.saveAgent({ ...base, groups: [] });
    const run = await h.core.agents.run(a.id, 'проверь', 'manual');
    expect(run).toMatchObject({ status: 'ok', report: 'Итог: всё в порядке.', trigger: 'manual', task: 'проверь' });
    expect(run.steps[0]).toContain('✓ get_datetime');
    expect(h.core.listAgents()[0]).toMatchObject({ lastStatus: 'ok', running: false });
    const audit = JSON.stringify(h.core.listAudit(100));
    expect(audit).toContain('agent:Аналитик');
    expect(audit).toContain('agent.run_finished');
    expect(provider.reqs[0]!.system).toContain('агент «Аналитик»');
    expect(provider.reqs[0]!.system).toContain('Смотри на CRM');
  });

  it('вне выбранных групп инструмент недоступен: модель его не видит, а вызов отклоняется', async () => {
    let ran = false;
    const provider = scripted((_r, n) => (n === 1 ? [{ type: 'tool_use', id: 't', name: 'danger_tool', input: {} }] : say('не вышло')));
    const { h } = setup(provider);
    h.core.tools.register({ name: 'danger_tool', description: 'x', risk: 'safe', mutates: false, domain: 'local', inputSchema: { type: 'object', properties: {} }, describe: () => 'x', execute: () => ((ran = true), 'ok') });
    const a = h.core.saveAgent(base);
    const run = await h.core.agents.run(a.id, '', 'manual');
    expect(ran).toBe(false);
    expect(provider.reqs[0]!.tools.map((t) => t.name)).not.toContain('danger_tool');
    expect(run.steps[0]).toMatch(/^[✗!]/);
  });

  it('действия: вручную — запрос подтверждения на экран; по расписанию и из чата — отклоняются без окна', async () => {
    let writes = 0;
    const mk = () => scripted((_r, n) => (n === 1 ? [{ type: 'tool_use', id: 't', name: 'crm_fake_write', input: {} }] : say('готово')));
    const reg = (h: ReturnType<typeof makeCore>) =>
      h.core.tools.register({ name: 'crm_fake_write', description: 'x', risk: 'medium', mutates: true, domain: 'local', inputSchema: { type: 'object', properties: {} }, describe: () => 'Записать в тестовую CRM', execute: () => ((writes += 1), 'записано') });
    // 1) вручную, пользователь разрешает
    const m = setup(mk());
    reg(m.h);
    const a = m.h.core.saveAgent({ ...base, mode: 'act' });
    await m.h.core.agents.run(a.id, '', 'manual');
    expect(m.h.confirms).toHaveLength(1);
    expect(m.h.confirms[0]!.description).toContain('агент: Аналитик');
    expect(writes).toBe(1);
    // 2) из чата/по расписанию — окна нет, действие не выполнено
    for (const trigger of ['schedule', 'assistant'] as const) {
      const s = setup(mk());
      reg(s.h);
      const b = s.h.core.saveAgent({ ...base, mode: 'act' });
      await s.h.core.agents.run(b.id, '', trigger);
      expect(s.h.confirms).toHaveLength(0);
    }
    expect(writes).toBe(1);
    // 3) режим «только чтение»: инструмента у агента нет вовсе
    const r = setup(mk());
    reg(r.h);
    const c = r.h.core.saveAgent(base);
    const run = await r.h.core.agents.run(c.id, '', 'manual');
    expect(r.h.confirms).toHaveLength(0);
    expect(run.steps[0]).toMatch(/^[✗!]/);
    expect(writes).toBe(1);
  });

  it('«ЗАПОМНИТЬ:» сохраняется в заметки агента и подаётся при следующем запуске как внешние данные', async () => {
    const provider = scripted((_r, n) => say(n === 1 ? 'Отчёт.\nЗАПОМНИТЬ: вчера было 7 заявок\nЗАПОМНИТЬ: Анна в отпуске' : 'Второй отчёт.'));
    const { h } = setup(provider);
    const a = h.core.saveAgent(base);
    const r1 = await h.core.agents.run(a.id, '', 'manual');
    expect(r1.report).toBe('Отчёт.');
    expect(h.core.listAgents()[0]!.notes).toContain('вчера было 7 заявок');
    await h.core.agents.run(a.id, '', 'manual');
    const sys = provider.reqs[1]!.system;
    expect(sys).toContain('вчера было 7 заявок');
    expect(sys).toContain('untrusted_data');
    h.core.clearAgentNotes(a.id);
    expect(h.core.listAgents()[0]!.notes).toBe('');
  });

  it('одновременно работает один агент; «Стоп» останавливает', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ChatProvider = { id: 's', name: 's', async *stream(_r, signal) { await Promise.race([gate, new Promise((res) => signal.addEventListener('abort', res))]); yield { type: 'text', text: 'ок' } as ProviderEvent; } };
    const { h } = setup(slow);
    const a = h.core.saveAgent(base);
    const b = h.core.saveAgent({ ...base, name: 'Второй' });
    h.core.startAgent(a.id, '');
    expect(h.core.listAgents().find((x) => x.id === a.id)!.running).toBe(true);
    expect(() => h.core.startAgent(b.id, '')).toThrow(/уже работает/);
    h.core.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.core.agentRuns(a.id)[0]!.status).toBe('stopped');
  });
});

describe('агенты: расписание', () => {
  const at = (hh: number, mm = 0) => new Date(2026, 10, 23, hh, mm, 0, 0); // понедельник

  it('запускается по расписанию; «OK» — тихо, иначе — уведомление; выключенный и давно пропущенный не запускаются', async () => {
    const clock = { d: at(8, 59) };
    let n = 0;
    const provider = scripted(() => say(++n === 1 ? 'OK.' : 'Просрочено 3 заявки.'));
    const { h, events } = setup(provider, clock);
    const a = h.core.saveAgent({ ...base, schedule: { kind: 'weekdays', atTime: '09:00', intervalMin: null }, enabled: true });
    const off = h.core.saveAgent({ ...base, name: 'Выключенный', schedule: { kind: 'weekdays', atTime: '09:00', intervalMin: null }, enabled: false });
    expect(a.nextRunAt).not.toBeNull();
    expect(off.nextRunAt).toBeNull();
    await h.core.agents.tick(clock.d);
    expect(provider.reqs).toHaveLength(0); // ещё рано
    clock.d = at(9, 1);
    await h.core.agents.tick(clock.d);
    expect(events).toHaveLength(1);
    expect((events[0] as { quiet: boolean }).quiet).toBe(true);
    expect(provider.reqs).toHaveLength(1);
    // следующий запуск — завтра
    expect(new Date(h.core.listAgents().find((x) => x.id === a.id)!.nextRunAt!).getDate()).toBe(24);
    clock.d = at(9, 0);
    clock.d = new Date(2026, 10, 24, 9, 2);
    await h.core.agents.tick(clock.d);
    expect((events[1] as { quiet: boolean; run: { report: string } }).quiet).toBe(false);
    expect((events[1] as { run: { report: string } }).run.report).toContain('Просрочено');
    // компьютер был выключен дольше 12 часов — запуск «задним числом» не выполняется
    const stale = h.core.listAgents().find((x) => x.id === a.id)!;
    clock.d = new Date(new Date(stale.nextRunAt!).getTime() + 13 * 3_600_000);
    const before = provider.reqs.length;
    await h.core.agents.tick(clock.d);
    expect(provider.reqs.length).toBe(before);
  });

  it('модуль «Агенты» можно отключить', async () => {
    const { h } = setup(scripted(() => say('ok')));
    h.core.saveAgent(base);
    h.core.updateSettings({ disabledModules: ['agents'] });
    expect(() => h.core.listAgents()).toThrow(/отключён/);
  });
});

describe('агенты: управление из чата', () => {
  const ctx = (h: ReturnType<typeof makeCore>) => ({ runId: 'r', conversationId: h.core.createConversation().id, signal: new AbortController().signal, actor: 'assistant' });
  const exec = (h: ReturnType<typeof makeCore>, name: string, input: Record<string, unknown>) => h.core.executor.execute({ type: 'tool_use', id: 'x', name, input }, ctx(h));

  it('agent_create требует подтверждения, всегда создаёт агента «только чтение»; отказ — не создаёт', async () => {
    const { h } = setup(scripted(() => say('ok')));
    const input = { name: 'Утренний обзор', instructions: 'Каждое утро смотри CRM и пиши краткий итог по заявкам.', groups: ['crm'], schedule_kind: 'weekdays', time: '09:00' };
    h.autoAnswer.value = false;
    expect((await exec(h, 'agent_create', input)).denied).toBe(true);
    expect(h.core.listAgents()).toHaveLength(0);
    h.autoAnswer.value = true;
    const ok = await exec(h, 'agent_create', { ...input, mode: 'act' });
    expect(ok.isError).toBeFalsy();
    expect(h.core.listAgents()[0]).toMatchObject({ name: 'Утренний обзор', mode: 'read', enabled: true });
    expect(h.confirms[0]!.description).toContain('только чтение');
    expect((await exec(h, 'agent_list', {})).content).toContain('Утренний обзор');
  });

  it('agent_run из чата: отчёт возвращается ассистенту как внешние данные; агент не может запускать других агентов', async () => {
    const provider = scripted((r, n) => {
      if (r.system.includes('агент «Аналитик»')) return n === 1 ? [{ type: 'tool_use', id: 'a', name: 'agent_run', input: { name: 'Другой' } }] : say('Отчёт аналитика.');
      return say('x');
    });
    const { h } = setup(provider);
    const a = h.core.saveAgent({ ...base, groups: [] });
    h.core.saveAgent({ ...base, name: 'Другой' });
    const r = await exec(h, 'agent_run', { name: 'Аналит', task: 'сводка' });
    expect(r.content).toContain('Отчёт аналитика.');
    const run = h.core.agentRuns(a.id)[0]!;
    expect(run.trigger).toBe('assistant');
    expect(run.steps[0]).toMatch(/^[✗!]/); // попытка запустить другого агента отклонена
    expect(h.core.agentRuns(h.core.listAgents().find((x) => x.name === 'Другой')!.id)).toHaveLength(0);
    expect((await exec(h, 'agent_run', { name: 'Нет такого' })).isError).toBe(true);
  });
});
