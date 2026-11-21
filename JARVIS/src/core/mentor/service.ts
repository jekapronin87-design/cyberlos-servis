import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import type { ToolRegistry } from '../tools/registry';
import { qualityIssues, trainingNeeds, type IssueKind } from '../crm/analytics';
import type { CrmService } from '../crm/service';
import type { BrowserController } from '../computer/browser';
import { COURSES, ISSUE_LESSON, type Course, type Lesson, type Step } from './courses';
import { KB_CATEGORIES, KbRepo } from './kb';

export interface StepDto {
  kind: Step['kind'];
  text?: string;
  question?: string;
  options?: string[];
  kb?: { title: string; version: number } | null;
  verify?: 'self' | 'crm_training_deal';
  canShow?: boolean;
  /** Выполнен ли шаг этим сотрудником. */
  done: boolean;
}

export interface LessonDto {
  courseId: string;
  id: string;
  title: string;
  goal: string;
  steps: StepDto[];
  progress: LessonProgress;
}

export interface LessonProgress {
  total: number;
  done: number;
  completed: boolean;
  /** Доля правильных ответов с первой попытки, % (null — тестов не было). */
  score: number | null;
}

export interface Recommendation {
  courseId: string;
  lessonId: string;
  title: string;
  reason: string;
  count: number;
}

export interface EmployeeRow {
  email: string;
  name: string;
  role: string;
  assignments: { courseId: string; title: string; dueAt: string | null; done: number; total: number; score: number | null }[];
  lastActivity: string | null;
  recommendations: Recommendation[];
  issues: number;
}

const checkable = (s: Step): boolean => s.kind === 'quiz' || s.kind === 'task';

export class MentorService {
  readonly kb: KbRepo;

  constructor(
    private db: Db,
    private crm: CrmService,
    private audit: AuditLog,
    private browser: BrowserController,
  ) {
    this.kb = new KbRepo(db);
  }

  // ---------- каталог и уроки ----------
  courses(): { id: string; title: string; description: string; roles: string[]; lessons: { id: string; title: string; goal: string }[] }[] {
    return COURSES.map((c) => ({ id: c.id, title: c.title, description: c.description, roles: c.roles, lessons: c.lessons.map((l) => ({ id: l.id, title: l.title, goal: l.goal })) }));
  }

  private find(courseId: string, lessonId: string): { course: Course; lesson: Lesson } {
    const course = COURSES.find((c) => c.id === courseId);
    const lesson = course?.lessons.find((l) => l.id === lessonId);
    if (!course || !lesson) throw new Error('Урок не найден');
    return { course, lesson };
  }

  private attempts(email: string, courseId: string, lessonId: string): { step_idx: number; correct: number; created_at: string }[] {
    return this.db
      .prepare('SELECT step_idx, correct, created_at FROM mentor_attempts WHERE email = ? AND course_id = ? AND lesson_id = ? ORDER BY id')
      .all(email.toLowerCase(), courseId, lessonId) as { step_idx: number; correct: number; created_at: string }[];
  }

  lessonProgress(email: string, courseId: string, lessonId: string): LessonProgress {
    const { lesson } = this.find(courseId, lessonId);
    const at = this.attempts(email, courseId, lessonId);
    let done = 0;
    let total = 0;
    let firstTry = 0;
    let quizzes = 0;
    lesson.steps.forEach((s, i) => {
      if (!checkable(s)) return;
      total++;
      const mine = at.filter((a) => a.step_idx === i);
      if (mine.some((a) => a.correct === 1)) done++;
      if (s.kind === 'quiz' && mine.length) {
        quizzes++;
        if (mine[0]!.correct === 1) firstTry++;
      }
    });
    return { total, done, completed: total > 0 && done === total, score: quizzes ? Math.round((firstTry / quizzes) * 100) : null };
  }

  /** Урок для проигрывателя: правильные ответы и пояснения НЕ передаются, пока сотрудник не ответил. */
  lesson(email: string, courseId: string, lessonId: string): LessonDto {
    const { lesson } = this.find(courseId, lessonId);
    const at = this.attempts(email, courseId, lessonId);
    const steps: StepDto[] = lesson.steps.map((s, i) => {
      const done = at.some((a) => a.step_idx === i && a.correct === 1);
      if (s.kind === 'explain') {
        const doc = s.kb ? this.kb.list().find((d) => d.title === s.kb && d.status === 'approved') : undefined;
        return { kind: 'explain', text: s.text, kb: doc ? { title: doc.title, version: doc.version } : null, done: true };
      }
      if (s.kind === 'quiz') return { kind: 'quiz', question: s.question, options: s.options, done };
      return { kind: 'task', text: s.text.replace('{имя}', this.markerName(email)), verify: s.verify, canShow: !!s.show, done };
    });
    return { courseId, id: lessonId, title: lesson.title, goal: lesson.goal, steps, progress: this.lessonProgress(email, courseId, lessonId) };
  }

  private markerName(email: string): string {
    return email.split('@')[0] ?? email;
  }

  answer(email: string, courseId: string, lessonId: string, stepIdx: number, choice: number): { correct: boolean; explain: string; correctIndex: number; progress: LessonProgress } {
    const { lesson } = this.find(courseId, lessonId);
    const s = lesson.steps[stepIdx];
    if (!s || s.kind !== 'quiz') throw new Error('Это не тестовый вопрос');
    if (!Number.isInteger(choice) || choice < 0 || choice >= s.options.length) throw new Error('Некорректный вариант ответа');
    const correct = choice === s.correct;
    this.record(email, courseId, lessonId, stepIdx, 'quiz', correct, `выбран вариант ${choice}`);
    return { correct, explain: s.explain, correctIndex: s.correct, progress: this.lessonProgress(email, courseId, lessonId) };
  }

  private record(email: string, courseId: string, lessonId: string, stepIdx: number, kind: string, correct: boolean, detail: string): void {
    this.db
      .prepare('INSERT INTO mentor_attempts (email, course_id, lesson_id, step_idx, kind, correct, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(email.toLowerCase(), courseId, lessonId, stepIdx, kind, correct ? 1 : 0, detail.slice(0, 300), nowIso());
  }

  /** Проверка практического задания. Проверка по CRM — только в тестовой CRM (учебные и рабочие данные не смешиваются). */
  async verifyTask(email: string, courseId: string, lessonId: string, stepIdx: number, selfConfirmed = false): Promise<{ ok: boolean; message: string; progress: LessonProgress }> {
    const { lesson } = this.find(courseId, lessonId);
    const s = lesson.steps[stepIdx];
    if (!s || s.kind !== 'task') throw new Error('Это не практическое задание');
    const result = async (): Promise<{ ok: boolean; message: string }> => {
      if (s.verify === 'self') return selfConfirmed ? { ok: true, message: 'Отмечено как выполненное.' } : { ok: false, message: 'Подтвердите выполнение кнопкой «Готово».' };
      if (!this.crm.client.configured()) return { ok: false, message: 'CRM не подключена: проверка недоступна. Подключите тестовую CRM в «Настройки → CRM» или отметьте задание вручную.' };
      if (this.crm.status().environment !== 'test') return { ok: false, message: 'Практические задания проверяются только в ТЕСТОВОЙ CRM, чтобы учебные данные не попадали в рабочую. Переключите окружение на «Тестовое».' };
      const snap = await this.crm.snapshot(true);
      const marker = `тренировка ${this.markerName(email)}`.toLowerCase();
      const deal = snap.deals.find((d) => d.title.toLowerCase().includes(marker));
      if (!deal) return { ok: false, message: `Не нашла сделку «Тренировка ${this.markerName(email)}». Создайте её в тестовой CRM и нажмите «Проверить» снова.` };
      const mine = (deal.assignees ?? []).some((a) => a.user.email.toLowerCase() === email.toLowerCase());
      if (!mine) return { ok: false, message: 'Сделка есть, но вы не назначены ответственным. Назначьте себя в карточке.' };
      const hasTask = snap.tasks.some((t) => t.dealId === deal.id && (t.status === 'open' || t.status === 'in_progress'));
      if (!hasTask) return { ok: false, message: 'Сделка есть и назначена на вас, но по ней нет открытой задачи. Поставьте следующее действие со сроком.' };
      return { ok: true, message: 'Отлично: сделка создана, вы ответственный, следующее действие поставлено.' };
    };
    const r = await result();
    this.record(email, courseId, lessonId, stepIdx, 'task', r.ok, r.message);
    return { ...r, progress: this.lessonProgress(email, courseId, lessonId) };
  }

  /** Подсветить нужное место в CRM (в браузере ассистента). Сотрудник сам входит в CRM — пароли JARVIS не вводит. */
  async show(courseId: string, lessonId: string, stepIdx: number): Promise<string> {
    const { lesson } = this.find(courseId, lessonId);
    const s = lesson.steps[stepIdx];
    if (!s || s.kind !== 'task' || !s.show) throw new Error('Для этого шага подсказки в CRM нет');
    const front = this.crm.status().frontendUrl;
    if (!front) throw new Error('Укажите адрес сайта CRM в «Настройки → CRM», чтобы показывать подсказки.');
    await this.browser.open(front + (s.show.path ?? ''));
    if (s.show.text || s.show.selector) {
      const ok = await this.browser.highlight({ text: s.show.text, selector: s.show.selector }, s.show.hint);
      return ok ? 'Подсвечено в окне браузера ассистента.' : 'CRM открыта, но элемент не найден. Войдите в CRM под своей учётной записью в этом окне и нажмите «Показать в CRM» снова.';
    }
    return `CRM открыта. ${s.show.hint}`;
  }

  // ---------- назначения и прогресс ----------
  assign(email: string, name: string, courseId: string, dueAt?: string | null): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Некорректный email сотрудника');
    if (!COURSES.some((c) => c.id === courseId)) throw new Error('Курс не найден');
    const due = dueAt ? new Date(dueAt) : null;
    if (due && Number.isNaN(due.getTime())) throw new Error('Некорректный срок');
    this.db
      .prepare(`INSERT INTO mentor_assignments (email, name, course_id, due_at, assigned_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email, course_id) DO UPDATE SET due_at = excluded.due_at, name = excluded.name`)
      .run(email.toLowerCase(), name.slice(0, 80), courseId, due ? due.toISOString() : null, nowIso());
    this.audit.record({ actor: 'user', action: 'mentor.assign', target: courseId, decision: 'info', details: { employee: email } });
  }

  unassign(email: string, courseId: string): void {
    this.db.prepare('DELETE FROM mentor_assignments WHERE email = ? AND course_id = ?').run(email.toLowerCase(), courseId);
  }

  assignmentsFor(email: string): { courseId: string; dueAt: string | null }[] {
    return (this.db.prepare('SELECT course_id, due_at FROM mentor_assignments WHERE email = ? ORDER BY id').all(email.toLowerCase()) as { course_id: string; due_at: string | null }[]).map((r) => ({ courseId: r.course_id, dueAt: r.due_at }));
  }

  courseProgress(email: string, courseId: string): { done: number; total: number; score: number | null } {
    const c = COURSES.find((x) => x.id === courseId)!;
    let done = 0;
    let total = 0;
    const scores: number[] = [];
    for (const l of c.lessons) {
      const p = this.lessonProgress(email, courseId, l.id);
      done += p.done;
      total += p.total;
      if (p.score !== null) scores.push(p.score);
    }
    return { done, total, score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null };
  }

  /** Кабинет руководителя: сотрудники, назначенные курсы, прогресс, типичные ошибки и рекомендации. */
  async cabinet(): Promise<{ employees: EmployeeRow[]; crmConnected: boolean; note: string }> {
    const people = new Map<string, { name: string; role: string }>();
    let crmConnected = false;
    let needs: ReturnType<typeof trainingNeeds> = [];
    let issuesByName = new Map<string, number>();
    let note = '';
    if (this.crm.client.configured()) {
      try {
        const snap = await this.crm.snapshot();
        crmConnected = true;
        for (const m of snap.team) if (m.isActive && !m.terminatedAt) people.set(m.email.toLowerCase(), { name: m.profile?.fullName || m.email, role: m.role?.name ?? '' });
        const issues = qualityIssues(snap);
        needs = trainingNeeds(issues);
        issuesByName = new Map(needs.map((n) => [n.employee, n.total]));
        if (snap.missing.includes('команда')) note = 'Нет доступа к списку сотрудников CRM — показаны только те, кому назначены курсы.';
      } catch (e) {
        note = e instanceof Error ? e.message : 'CRM недоступна';
      }
    } else {
      note = 'CRM не подключена: рекомендации по ошибкам недоступны. Назначайте курсы вручную.';
    }
    for (const r of this.db.prepare('SELECT DISTINCT email, name FROM mentor_assignments').all() as { email: string; name: string | null }[]) {
      if (!people.has(r.email)) people.set(r.email, { name: r.name || r.email, role: '' });
    }
    const employees: EmployeeRow[] = [];
    for (const [email, p] of people) {
      const asg = this.assignmentsFor(email);
      const last = this.db.prepare('SELECT MAX(created_at) AS t FROM mentor_attempts WHERE email = ?').get(email) as { t: string | null };
      const need = needs.find((n) => n.employee === p.name);
      const recs: Recommendation[] = [];
      for (const t of need?.topics ?? []) {
        const map = ISSUE_LESSON[t.kind];
        if (!map) continue;
        const lesson = COURSES.find((c) => c.id === map.course)?.lessons.find((l) => l.id === map.lesson);
        if (!lesson || recs.some((r) => r.courseId === map.course && r.lessonId === map.lesson)) continue;
        recs.push({ courseId: map.course, lessonId: map.lesson, title: lesson.title, reason: t.topic, count: t.count });
      }
      employees.push({
        email,
        name: p.name,
        role: p.role,
        assignments: asg.map((a) => {
          const cp = this.courseProgress(email, a.courseId);
          return { courseId: a.courseId, title: COURSES.find((c) => c.id === a.courseId)?.title ?? a.courseId, dueAt: a.dueAt, ...cp };
        }),
        lastActivity: last.t,
        recommendations: recs,
        issues: issuesByName.get(p.name) ?? 0,
      });
    }
    employees.sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));
    return { employees, crmConnected, note };
  }

  /** Тип ошибки → рекомендуемый урок (для внешнего использования и тестов). */
  lessonForIssue(kind: IssueKind): { courseId: string; lessonId: string } | null {
    const m = ISSUE_LESSON[kind];
    return m ? { courseId: m.course, lessonId: m.lesson } : null;
  }
}

// ---------- инструменты ассистента ----------

export function registerMentorTools(registry: ToolRegistry, mentor: MentorService): void {
  const base = { risk: 'safe' as const, mutates: false, domain: 'local' as const, external: true };

  registry.register<{ query: string }>({
    ...base,
    name: 'kb_search',
    description:
      'Поиск в УТВЕРЖДЁННОЙ базе знаний компании (регламенты, руководства по CRM, скрипты продаж, частые вопросы). Используй ВСЕГДА, когда спрашивают о правилах компании или о том, как работать в CRM. ' +
      'Отвечай только по найденному и называй источник в формате [«Название», ред. N]. Если ничего не найдено — скажи, что в базе знаний этого нет, и посоветуй обратиться к руководителю; правила не выдумывай.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Вопрос или ключевые слова' } }, required: ['query'] },
    describe: (i) => `Поиск в базе знаний: ${i.query}`,
    execute: (i) => {
      const hits = mentor.kb.search(String(i.query));
      if (!hits.length) return 'В утверждённой базе знаний ответа не найдено. Не выдумывай правило: скажи об этом и предложи обратиться к руководителю.';
      return hits.map((h, n) => `(${n + 1}) [«${h.title}», ред. ${h.version}${h.source ? `, ${h.source}` : ''}]\n${h.text}`).join('\n\n');
    },
  });

  registry.register({
    ...base,
    name: 'kb_list',
    description: 'Список документов базы знаний (название, категория, статус, версия).',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Список документов базы знаний',
    execute: () => mentor.kb.list().map((d) => `• «${d.title}» — ${KB_CATEGORIES[d.category]}; ${d.status === 'approved' ? 'утверждён' : 'ЧЕРНОВИК (не используется)'}; ред. ${d.version}`).join('\n'),
  });

  registry.register({
    ...base,
    name: 'mentor_courses',
    description: 'Курсы и уроки наставника (для каких ролей рекомендованы).',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Список курсов обучения',
    execute: () => mentor.courses().map((c) => `• ${c.title} (${c.id}) — ${c.description}\n${c.lessons.map((l) => `    – ${l.title} (${l.id}): ${l.goal}`).join('\n')}`).join('\n'),
  });

  registry.register<{ email?: string }>({
    ...base,
    name: 'mentor_progress',
    description: 'Прогресс обучения: у сотрудника по email или у всех, кому назначены курсы. Ошибки сотрудников — повод для обучения, не для наказания.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' } } },
    describe: () => 'Прогресс обучения сотрудников',
    execute: async (i) => {
      const c = await mentor.cabinet();
      const rows = i.email ? c.employees.filter((e) => e.email === String(i.email).toLowerCase()) : c.employees.filter((e) => e.assignments.length || e.recommendations.length);
      if (!rows.length) return 'Нет данных об обучении.';
      return rows
        .map(
          (e) =>
            `• ${e.name} (${e.role || e.email}): ` +
            (e.assignments.map((a) => `${a.title} — ${a.done}/${a.total}${a.score !== null ? `, тесты ${a.score}%` : ''}`).join('; ') || 'курсы не назначены') +
            (e.recommendations.length ? `\n    Рекомендуется: ${e.recommendations.map((r) => `«${r.title}» (из-за: ${r.reason}, ${r.count})`).join('; ')}` : ''),
        )
        .join('\n');
    },
  });
}
