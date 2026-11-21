import { describe, expect, it } from 'vitest';
import { computeNext, validateJob } from '../src/core/scheduler/jobs';
import { CATCHUP_MS, type JobResultEvent } from '../src/core/scheduler/runner';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';
import { chat, makeCore } from './helpers';

const local = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('расписание: следующий запуск', () => {
  it('daily: сегодня, если время ещё не прошло, иначе завтра', () => {
    const job = { kind: 'daily' as const, atTime: '09:00', intervalMin: null, runAt: null };
    expect(computeNext(job, local(2026, 11, 21, 8, 0))).toEqual(local(2026, 11, 21, 9, 0));
    expect(computeNext(job, local(2026, 11, 21, 9, 0))).toEqual(local(2026, 11, 22, 9, 0)); // строго после
    expect(computeNext(job, local(2026, 11, 21, 23, 59))).toEqual(local(2026, 11, 22, 9, 0));
  });
  it('weekdays: пятница вечером → понедельник; суббота → понедельник', () => {
    const job = { kind: 'weekdays' as const, atTime: '09:00', intervalMin: null, runAt: null };
    expect(computeNext(job, local(2026, 11, 20, 18, 0))).toEqual(local(2026, 11, 23, 9, 0)); // 20.11.2026 — пятница
    expect(computeNext(job, local(2026, 11, 21, 10, 0))).toEqual(local(2026, 11, 23, 9, 0)); // суббота
    expect(computeNext(job, local(2026, 11, 23, 8, 0))).toEqual(local(2026, 11, 23, 9, 0));
  });
  it('interval и once', () => {
    const t = local(2026, 11, 21, 10, 0);
    expect(computeNext({ kind: 'interval', atTime: null, intervalMin: 30, runAt: null }, t)).toEqual(local(2026, 11, 21, 10, 30));
    expect(computeNext({ kind: 'once', atTime: null, intervalMin: null, runAt: local(2026, 11, 21, 12, 0).toISOString() }, t)).toEqual(local(2026, 11, 21, 12, 0));
    expect(computeNext({ kind: 'once', atTime: null, intervalMin: null, runAt: local(2026, 11, 21, 9, 0).toISOString() }, t)).toBeNull();
  });
  it('проверка ввода', () => {
    expect(() => validateJob({ title: '', prompt: 'x', kind: 'daily', atTime: '09:00' })).toThrow(/Название/);
    expect(() => validateJob({ title: 'a', prompt: '', kind: 'daily', atTime: '09:00' })).toThrow(/Текст/);
    expect(() => validateJob({ title: 'a', prompt: 'x', kind: 'daily', atTime: '25:00' })).toThrow(/ЧЧ:ММ/);
    expect(() => validateJob({ title: 'a', prompt: 'x', kind: 'interval', intervalMin: 1 })).toThrow(/Интервал/);
    expect(() => validateJob({ title: 'a', prompt: 'x', kind: 'interval', intervalMin: 5000 })).toThrow(/Интервал/);
    expect(() => validateJob({ title: 'a', prompt: 'x', kind: 'evil' as never })).toThrow(/тип/);
    expect(validateJob({ title: ' a ', prompt: 'x', kind: 'weekdays', atTime: '08:30' })).toMatchObject({ title: 'a', atTime: '08:30', notify: true, speak: false });
  });
});

const scripted = (fn: (req: ProviderRequest, n: number) => ProviderEvent[] | Promise<ProviderEvent[]>): ChatProvider => {
  let n = 0;
  return { id: 's', name: 's', async *stream(req) { for (const e of await fn(req, ++n)) yield e; } };
};

function setup(provider: ChatProvider, opts: { now?: Date; timeoutMs?: number } = {}) {
  const clock = { now: opts.now ?? local(2026, 11, 21, 8, 59) };
  const events: JobResultEvent[] = [];
  const h = makeCore({ liveProvider: provider, schedulerNow: () => clock.now, schedulerTimeoutMs: opts.timeoutMs, onJobResult: (e) => events.push(e) });
  h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
  return { h, clock, events };
}

describe('планировщик', () => {
  it('выполняет подошедшую задачу, сохраняет итог, уведомляет и планирует следующий запуск', async () => {
    const { h, clock, events } = setup(scripted(() => [{ type: 'text', text: 'Новых заявок 3, две просрочены. Стоит позвонить Анне.' }]));
    const job = h.core.createJob({ title: 'Утренняя сводка', prompt: 'Сводка по CRM', kind: 'daily', atTime: '09:00' });
    expect(job.nextRunAt).toBe(local(2026, 11, 21, 9, 0).toISOString());
    await h.core.scheduler.tick(clock.now);
    expect(events).toHaveLength(0); // ещё рано
    clock.now = local(2026, 11, 21, 9, 0, );
    await h.core.scheduler.tick(clock.now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'ok', quiet: false });
    expect(events[0]!.summary).toContain('две просрочены');
    const after = h.core.listJobs()[0]!;
    expect(after).toMatchObject({ lastStatus: 'ok', nextRunAt: local(2026, 11, 22, 9, 0).toISOString() });
    expect(h.core.jobRuns(job.id)).toHaveLength(1);
    // диалог задачи создан и содержит поручение
    const msgs = h.core.messages(after.conversationId!);
    expect(JSON.stringify(msgs[0]!.content)).toContain('Фоновая задача по расписанию');
    // повторный проход в ту же минуту ничего не запускает
    await h.core.scheduler.tick(clock.now);
    expect(events).toHaveLength(1);
  });

  it('ответ «OK» — тихо: итог записан, уведомления нет', async () => {
    const { h, clock, events } = setup(scripted(() => [{ type: 'text', text: 'OK.' }]));
    h.core.createJob({ title: 'Контроль', prompt: 'Проверь', kind: 'interval', intervalMin: 30 });
    clock.now = local(2026, 11, 21, 9, 31);
    await h.core.scheduler.tick(clock.now);
    expect(events).toHaveLength(0);
    expect(h.core.listJobs()[0]).toMatchObject({ lastStatus: 'ok', lastSummary: 'OK.' });
  });

  it('в фоне действия с подтверждением отклоняются, данные не меняются', async () => {
    const provider = scripted((req, n) => (n === 1 ? [{ type: 'tool_use', id: 'f', name: 'forget_memory', input: { id: 1 } }] : [{ type: 'text', text: 'Не смог удалить: нужно подтверждение.' }]));
    const { h, clock, events } = setup(provider);
    h.core.addMemory('fact', 'важное');
    h.core.createJob({ title: 'Уборка', prompt: 'Удали память', kind: 'daily', atTime: '09:00' });
    clock.now = local(2026, 11, 21, 9, 1);
    await h.core.scheduler.tick(clock.now);
    expect(h.core.listMemory()).toHaveLength(1);
    expect(h.confirms).toHaveLength(0); // окно подтверждения не открывалось — пользователя нет рядом
    const denied = h.core.listAudit().find((a) => a.target === 'forget_memory');
    expect(denied).toMatchObject({ decision: 'denied' });
    expect(JSON.stringify(denied!.details)).toContain('background');
    expect(events[0]!.summary).toContain('подтверждение');
  });

  it('в фоне нельзя создавать другие задачи', async () => {
    const provider = scripted((req, n) => (n === 1 ? [{ type: 'tool_use', id: 'c', name: 'schedule_create', input: { title: 'x', prompt: 'y', kind: 'daily', time: '10:00' } }] : [{ type: 'text', text: 'ок' }]));
    const { h, clock } = setup(provider);
    h.core.createJob({ title: 'Хитрая', prompt: 'создай задачу', kind: 'daily', atTime: '09:00' });
    clock.now = local(2026, 11, 21, 9, 1);
    await h.core.scheduler.tick(clock.now);
    expect(h.core.listJobs()).toHaveLength(1);
  });

  it('пропущенные дольше 12 часов запуски не выполняются «задним числом»', async () => {
    let calls = 0;
    const { h, clock, events } = setup(scripted(() => (calls++, [{ type: 'text', text: 'итог' }])));
    h.core.createJob({ title: 'Сводка', prompt: 'x', kind: 'daily', atTime: '09:00' });
    clock.now = new Date(local(2026, 11, 21, 9, 0).getTime() + CATCHUP_MS + 60_000);
    await h.core.scheduler.tick(clock.now);
    expect(calls).toBe(0);
    expect(events).toHaveLength(0);
    expect(h.core.listJobs()[0]!.nextRunAt).toBe(local(2026, 11, 22, 9, 0).toISOString());
    expect(h.core.listAudit().some((a) => a.action === 'job.skipped_missed')).toBe(true);
  });

  it('без ключа Claude задача сообщает об этом, а не падает', async () => {
    const events: JobResultEvent[] = [];
    const h = makeCore({ onJobResult: (e) => events.push(e) });
    const j = h.core.createJob({ title: 'Сводка', prompt: 'x', kind: 'interval', intervalMin: 5 });
    const res = await h.core.runJobNow(j.id);
    expect(res.status).toBe('error');
    expect(res.summary).toMatch(/нужна модель Claude/);
  });

  it('«Стоп» и таймаут прерывают зависшую задачу; параллельно не запускается вторая', async () => {
    const hang = scripted(async function* () {} as never);
    const forever: ChatProvider = {
      id: 'h',
      name: 'h',
      async *stream(_req, signal) {
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        void hang;
        yield { type: 'text', text: '' };
      },
    };
    const { h } = setup(forever, { timeoutMs: 10_000 });
    const j = h.core.createJob({ title: 'Зависшая', prompt: 'x', kind: 'interval', intervalMin: 5 });
    const running = h.core.runJobNow(j.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.core.scheduler.busy).toBe(true);
    await expect(h.core.runJobNow(j.id)).rejects.toThrow(/Уже выполняется/);
    h.core.stopAll();
    const res = await running;
    expect(res.status).toBe('stopped');
    expect(h.core.scheduler.busy).toBe(false);

    const t = setup(forever, { timeoutMs: 40 });
    const j2 = t.h.core.createJob({ title: 'Таймаут', prompt: 'x', kind: 'interval', intervalMin: 5 });
    expect((await t.h.core.runJobNow(j2.id)).status).toBe('stopped');
  });
});

describe('задачи через ассистента', () => {
  it('schedule_create — только с подтверждением пользователя', async () => {
    const provider = scripted((req, n) => (n === 1 ? [{ type: 'tool_use', id: 'c', name: 'schedule_create', input: { title: 'Утренняя сводка', prompt: 'Сделай сводку по CRM', kind: 'weekdays', time: '09:00' } }] : [{ type: 'text', text: 'Готово.' }]));
    const { h } = setup(provider);
    h.autoAnswer.value = false;
    await chat(h, 'Каждое утро в 9 присылай сводку по CRM');
    expect(h.confirms[0]).toMatchObject({ toolName: 'schedule_create', risk: 'medium' });
    expect(h.confirms[0]!.description).toContain('по будням в 09:00');
    expect(h.core.listJobs()).toHaveLength(0);
    h.autoAnswer.value = true;
    const p2 = scripted((req, n) => (n === 1 ? [{ type: 'tool_use', id: 'c2', name: 'schedule_create', input: { title: 'Утренняя сводка', prompt: 'Сделай сводку по CRM', kind: 'weekdays', time: '09:00' } }] : [{ type: 'text', text: 'Готово.' }]));
    const h2 = setup(p2).h;
    await chat(h2, 'Каждое утро в 9 присылай сводку по CRM');
    expect(h2.core.listJobs()).toHaveLength(1);
    expect(h2.core.listJobs()[0]).toMatchObject({ kind: 'weekdays', atTime: '09:00' });
  });
  it('включение/выключение и удаление, лимит и журнал', () => {
    const h = makeCore();
    const j = h.core.createJob({ title: 'a', prompt: 'b', kind: 'daily', atTime: '07:00' });
    expect(h.core.setJobEnabled(j.id, false)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(h.core.setJobEnabled(j.id, true).nextRunAt).not.toBeNull();
    h.core.deleteJob(j.id);
    expect(h.core.listJobs()).toHaveLength(0);
    expect(h.core.listAudit().map((a) => a.action)).toEqual(expect.arrayContaining(['job.create', 'job.delete']));
    for (let i = 0; i < 30; i++) h.core.createJob({ title: 't' + i, prompt: 'p', kind: 'interval', intervalMin: 60 });
    expect(() => h.core.createJob({ title: 'лишняя', prompt: 'p', kind: 'interval', intervalMin: 60 })).toThrow(/Не больше/);
  });
});
