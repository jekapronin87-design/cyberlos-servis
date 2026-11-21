import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COURSES, ISSUE_LESSON } from '../src/core/mentor/courses';
import { ISSUE_TITLE } from '../src/core/crm/analytics';
import { tokens } from '../src/core/mentor/kb';
import { buildSystemPrompt } from '../src/core/chat/prompt';
import { deals, NOW, startCrmFixture, tasks, type Fixture } from './crmFixture';
import { makeCore } from './helpers';

let fx: Fixture;
beforeAll(async () => {
  fx = await startCrmFixture();
});
afterAll(async () => {
  await fx.close();
});

const tool = async (h: ReturnType<typeof makeCore>, name: string, input: Record<string, unknown> = {}): Promise<string> => {
  const out = await h.core.tools.get(name)!.execute(input as never, { conversationId: 1, runId: 'r', signal: new AbortController().signal });
  return typeof out === 'string' ? out : out.text;
};

describe('база знаний', () => {
  it('стартовая база утверждена и находит ответы с источником', () => {
    const h = makeCore();
    const all = h.core.mentor.kb.list();
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.every((d) => d.status === 'approved' && d.builtin)).toBe(true);
    const a = h.core.mentor.kb.search('можно ли начать сборку заказа без предоплаты дилера');
    expect(a[0]!.title).toBe('Производство: предоплата и запуск сборки');
    expect(a[0]!.text).toContain('Нельзя начать сборку');
    const b = h.core.mentor.kb.search('за сколько часов надо обработать новую заявку с сайта');
    expect(b[0]!.title).toMatch(/Как устроена CRM|Заявка/);
    expect(b.map((x) => x.text).join(' ')).toMatch(/2 час|2 ч/);
    expect(h.core.mentor.kb.search('рецепт борща без свёклы')).toEqual([]);
    expect(h.core.mentor.kb.search('')).toEqual([]);
  });

  it('черновики в ответах не участвуют; правка сбрасывает утверждение и поднимает версию', () => {
    const h = makeCore();
    const kb = h.core.mentor.kb;
    const doc = kb.save({ title: 'Регламент скидок', category: 'regulation', body: 'Скидка дилеру до 7% согласуется с РОП. Скидка свыше 7% — только директор.', source: 'Приказ №12' });
    expect(doc).toMatchObject({ status: 'draft', version: 1, builtin: false });
    expect(kb.search('скидка')).toEqual([]); // не утверждён — не используется
    kb.setApproved(doc.id, true);
    expect(kb.search('какая скидка')[0]).toMatchObject({ title: 'Регламент скидок', version: 1, source: 'Приказ №12' });
    const edited = kb.save({ id: doc.id, title: 'Регламент скидок', category: 'regulation', body: 'Скидка дилеру до 5% согласуется с РОП.', source: 'Приказ №12' });
    expect(edited).toMatchObject({ status: 'draft', version: 2, approvedAt: null });
    expect(kb.search('какая скидка')).toEqual([]);
    // без изменений — версия не растёт
    kb.setApproved(doc.id, true);
    expect(kb.save({ id: doc.id, title: 'Регламент скидок', category: 'regulation', body: 'Скидка дилеру до 5% согласуется с РОП.', source: 'Приказ №12' })).toMatchObject({ status: 'approved', version: 2 });
    kb.remove(doc.id);
    expect(kb.get(doc.id)).toBeNull();
  });

  it('проверка ввода и стемминг', () => {
    const h = makeCore();
    const kb = h.core.mentor.kb;
    expect(() => kb.save({ title: '', category: 'faq', body: 'x' })).toThrow(/Название/);
    expect(() => kb.save({ title: 'a', category: 'faq', body: '' })).toThrow(/пуст/);
    expect(() => kb.save({ title: 'a', category: 'bogus', body: 'x' })).toThrow(/категория/);
    expect(() => kb.save({ title: 'a', category: 'faq', body: 'x'.repeat(60_001) })).toThrow(/длиннее/);
    expect(tokens('Заявку заявки заявка')).toEqual(['заявк', 'заявк', 'заявк']);
  });

  it('инструмент kb_search: цитаты с названием и редакцией; честное «не найдено»; ассистент получает правило использовать базу', async () => {
    const h = makeCore();
    const found = await tool(h, 'kb_search', { query: 'роли и права в CRM, кто что видит' });
    expect(found).toMatch(/\[«Роли и права в CRM», ред\. 1/);
    expect(await tool(h, 'kb_search', { query: 'курс доллара на завтра' })).toContain('ответа не найдено');
    expect(await tool(h, 'kb_list')).toContain('утверждён');
    expect(h.core.tools.get('kb_search')).toMatchObject({ risk: 'safe', external: true });
    const p = buildSystemPrompt({ settings: { customInstructions: '', memoryEnabled: true }, memory: [] });
    expect(p).toMatch(/kb_search/);
    expect(p).toMatch(/не выдумывай/);
    expect(p).toMatch(/не для упрёков или наказания/);
  });
});

describe('курсы и уроки', () => {
  const E = 'anna@aquamaster.ru';
  it('в урок для проигрывателя не попадают правильные ответы и пояснения', () => {
    const h = makeCore();
    const l = h.core.mentor.lesson(E, 'sales', 'take');
    const json = JSON.stringify(l);
    expect(l.steps.map((s) => s.kind)).toEqual(['explain', 'quiz', 'quiz', 'task']);
    expect(json).not.toContain('"correct"');
    expect(json).not.toContain('explain":"Итог звонка');
    expect(l.steps[3]!.text).toContain('Тренировка anna'); // подстановка имени
    expect(l.steps[0]!.kb).toMatchObject({ title: 'Заявка: как взять в работу и что делать дальше', version: 1 });
  });

  it('ответы: неверный — объяснение и верный вариант; прогресс и оценка «с первой попытки»', () => {
    const h = makeCore();
    const m = h.core.mentor;
    const wrong = m.answer(E, 'start', 'structure', 1, 2);
    expect(wrong).toMatchObject({ correct: false, correctIndex: 0 });
    expect(wrong.explain).toMatch(/SLA/);
    expect(m.answer(E, 'start', 'structure', 1, 0).correct).toBe(true);
    expect(m.answer(E, 'start', 'structure', 2, 1).correct).toBe(true);
    const last = m.answer(E, 'start', 'structure', 3, 1);
    expect(last.progress).toMatchObject({ total: 3, done: 3, completed: true, score: 67 }); // 2 из 3 с первой попытки
    expect(() => m.answer(E, 'start', 'structure', 0, 0)).toThrow(/не тестовый/);
    expect(() => m.answer(E, 'start', 'structure', 1, 9)).toThrow(/вариант/);
    expect(() => m.answer(E, 'нет', 'нет', 0, 0)).toThrow(/не найден/);
  });

  it('все ответы в курсах корректны по структуре, а каждая ошибка CRM имеет урок', () => {
    for (const c of COURSES) for (const l of c.lessons) for (const s of l.steps) if (s.kind === 'quiz') {
      expect(s.correct).toBeGreaterThanOrEqual(0);
      expect(s.correct).toBeLessThan(s.options.length);
      expect(s.options.length).toBeGreaterThanOrEqual(3);
    }
    for (const kind of Object.keys(ISSUE_TITLE)) {
      const m = ISSUE_LESSON[kind]!;
      expect(COURSES.find((c) => c.id === m.course)?.lessons.some((l) => l.id === m.lesson), kind).toBe(true);
    }
  });

  it('практическое задание «сам»: нужна отметка сотрудника', async () => {
    const h = makeCore();
    expect((await h.core.mentor.verifyTask(E, 'start', 'day', 2, false)).ok).toBe(false);
    expect((await h.core.mentor.verifyTask(E, 'start', 'day', 2, true)).ok).toBe(true);
  });
});

describe('проверка практики по тестовой CRM', () => {
  const E = 'anna@aquamaster.ru';
  const crmCore = (env: 'test' | 'production') => {
    const h = makeCore({ crmFetch: fetch, crmNow: () => NOW });
    h.core.crmSave({ baseUrl: fx.url, environment: env, email: 'jarvis@aquamaster.ru', maskPii: true }, 'ro-pass-123');
    return h;
  };
  const stage = deals[0]!.stage;

  it('без CRM и в рабочем окружении проверка отказывает с понятным объяснением', async () => {
    expect((await makeCore().core.mentor.verifyTask(E, 'sales', 'take', 3)).message).toMatch(/CRM не подключена/);
    expect((await crmCore('production').core.mentor.verifyTask(E, 'sales', 'take', 3)).message).toMatch(/только в ТЕСТОВОЙ/);
  });

  it('пошаговая обратная связь: нет сделки → не назначена → нет задачи → готово', async () => {
    const h = crmCore('test');
    expect((await h.core.mentor.verifyTask(E, 'sales', 'take', 3)).message).toMatch(/Не нашла сделку «Тренировка anna»/);
    const d = { id: 'tr1', pipelineId: 'pl-cold', stageId: 'c-new', stage, title: 'Тренировка anna', status: 'open', assignees: [], createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), customFields: null } as never;
    deals.push(d);
    try {
      expect((await h.core.mentor.verifyTask(E, 'sales', 'take', 3)).message).toMatch(/не назначены ответственным/);
      (d as { assignees: unknown[] }).assignees = [{ user: { id: 'u-anna', email: E, employeeProfile: { fullName: 'Анна Соколова' } } }];
      expect((await h.core.mentor.verifyTask(E, 'sales', 'take', 3)).message).toMatch(/нет открытой задачи/);
      tasks.push({ id: 'trt', title: 'Позвонить', dealId: 'tr1', status: 'open', dueAt: null, completedAt: null, createdAt: NOW.toISOString(), assignee: { id: 'u-anna', email: E, employeeProfile: { fullName: 'Анна' } }, deal: null } as never);
      const ok = await h.core.mentor.verifyTask(E, 'sales', 'take', 3);
      expect(ok.ok).toBe(true);
      expect(ok.progress.done).toBe(1);
    } finally {
      deals.pop();
      tasks.pop();
    }
  });

  it('подсказка в CRM требует адрес сайта', async () => {
    const h = crmCore('test');
    await expect(h.core.mentor.show('start', 'day', 2)).rejects.toThrow(/адрес сайта CRM/);
    await expect(h.core.mentor.show('start', 'structure', 1)).rejects.toThrow(/нет/);
  });
});

describe('кабинет руководителя', () => {
  it('без CRM: только назначенные сотрудники и пояснение', async () => {
    const h = makeCore();
    h.core.mentor.assign('olga@x.ru', 'Ольга', 'start');
    expect(() => h.core.mentor.assign('не-почта', 'x', 'start')).toThrow(/email/);
    expect(() => h.core.mentor.assign('a@x.ru', 'x', 'нет')).toThrow(/Курс/);
    const c = await h.core.mentor.cabinet();
    expect(c.crmConnected).toBe(false);
    expect(c.note).toMatch(/CRM не подключена/);
    expect(c.employees.map((e) => e.email)).toEqual(['olga@x.ru']);
    expect(c.employees[0]!.assignments[0]).toMatchObject({ courseId: 'start', done: 0, total: 5 });
  });

  it('с CRM: сотрудники из команды, ошибки → рекомендованные уроки, прогресс; уволенные не показываются', async () => {
    const h = makeCore({ crmFetch: fetch, crmNow: () => NOW });
    h.core.crmSave({ baseUrl: fx.url, environment: 'test', email: 'jarvis@aquamaster.ru', maskPii: true }, 'ro-pass-123');
    h.core.mentor.assign('anna@aquamaster.ru', 'Анна Соколова', 'sales', '2026-12-01T00:00:00Z');
    h.core.mentor.answer('anna@aquamaster.ru', 'sales', 'fields', 1, 1);
    const c = await h.core.mentor.cabinet();
    expect(c.crmConnected).toBe(true);
    expect(c.employees.map((e) => e.name)).toEqual(expect.arrayContaining(['Анна Соколова', 'Борис Лебедев']));
    expect(c.employees.some((e) => e.name.includes('Клара'))).toBe(false);
    const anna = c.employees.find((e) => e.name === 'Анна Соколова')!;
    expect(anna.issues).toBeGreaterThan(0);
    expect(anna.recommendations.map((r) => r.lessonId)).toEqual(expect.arrayContaining(['fields']));
    expect(anna.assignments[0]).toMatchObject({ courseId: 'sales', dueAt: '2026-12-01T00:00:00.000Z' });
    expect(anna.assignments[0]!.done).toBe(1);
    expect(anna.lastActivity).not.toBeNull();
    expect(c.employees[0]!.issues).toBeGreaterThanOrEqual(c.employees.at(-1)!.issues); // больше замечаний — выше
    expect(await tool(h, 'mentor_progress', {})).toContain('Анна Соколова');
    h.core.mentor.unassign('anna@aquamaster.ru', 'sales');
    expect((await h.core.mentor.cabinet()).employees.find((e) => e.name === 'Анна Соколова')!.assignments).toEqual([]);
  });

  it('утверждение документов фиксируется в журнале', () => {
    const h = makeCore();
    const d = h.core.saveKbDoc({ title: 'Скрипт звонка', category: 'sales_script', body: 'Здравствуйте! Меня зовут…' });
    h.core.approveKbDoc(d.id, true);
    h.core.removeKbDoc(d.id);
    const acts = h.core.listAudit().map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['kb.save', 'kb.approve', 'kb.delete']));
    expect(h.core.listAudit().find((a) => a.action === 'kb.approve')).toMatchObject({ risk: 'medium' });
  });
});
