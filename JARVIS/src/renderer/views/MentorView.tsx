import { useEffect, useState } from 'react';
import type { CourseDto, EmployeeRowDto, KbDocDto, LessonDto } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

const CATS: Record<string, string> = { crm_guide: 'Руководство по CRM', regulation: 'Регламент', sales_script: 'Скрипт продаж', material: 'Учебный материал', faq: 'Частые вопросы' };

type Tab = 'learn' | 'cabinet' | 'kb';

export function MentorView(props: { onAsk: (text: string) => void }) {
  const [tab, setTab] = useState<Tab>('learn');
  return (
    <section className="page" style={{ maxWidth: 1100 }}>
      <h1>Наставник</h1>
      <p className="muted">ИИ-наставник обучает сотрудников работе с CRM: уроки с проверкой, практика в тестовой CRM, база знаний компании и кабинет руководителя. Ошибки — повод для обучения, а не для наказания.</p>
      <div className="row" role="tablist">
        {([['learn', 'Обучение'], ['cabinet', 'Кабинет руководителя'], ['kb', 'База знаний']] as const).map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>
            {l}
          </button>
        ))}
        <button className="btn" onClick={() => props.onAsk('Объясни, как мне работать с новой заявкой в CRM, по шагам. Ответь по базе знаний и укажи источник.')}>
          Спросить наставника голосом
        </button>
      </div>
      {tab === 'learn' && <Learn />}
      {tab === 'cabinet' && <Cabinet />}
      {tab === 'kb' && <Kb />}
    </section>
  );
}

// ---------------- Обучение ----------------

function Learn() {
  const [email, setEmail] = useState(() => localStorage.getItem('jv-trainee') ?? '');
  const [courses, setCourses] = useState<CourseDto[]>([]);
  const [assigned, setAssigned] = useState<{ courseId: string; dueAt: string | null }[]>([]);
  const [open, setOpen] = useState<{ courseId: string; lessonId: string } | null>(null);

  useEffect(() => {
    void window.jarvis.mentor.courses().then(setCourses);
  }, []);
  useEffect(() => {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      localStorage.setItem('jv-trainee', email);
      void window.jarvis.mentor.assignments(email).then(setAssigned);
    } else setAssigned([]);
  }, [email, open]);

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (open && valid) return <Player email={email} {...open} onBack={() => setOpen(null)} />;
  return (
    <div className="card">
      <h2>Мои уроки</h2>
      <label className="field">
        <span>Ваш рабочий email (как в CRM)</span>
        <input value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="anna@ваш-домен.ru" spellCheck={false} />
        <small className="muted">По нему сохраняется ваш прогресс и проверяется практика в тестовой CRM.</small>
      </label>
      {!valid && <p className="muted">Введите email, чтобы начать.</p>}
      {valid &&
        courses.map((c) => {
          const a = assigned.find((x) => x.courseId === c.id);
          return (
            <div key={c.id} style={{ marginBottom: 14 }}>
              <strong>{c.title}</strong> {a && <span className="tag">назначен{a.dueAt ? ` до ${formatTime(a.dueAt).slice(0, 10)}` : ''}</span>}
              <div className="muted small">{c.description}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {c.lessons.map((l) => (
                  <button key={l.id} className="btn btn-small" onClick={() => setOpen({ courseId: c.id, lessonId: l.id })} title={l.goal}>
                    {l.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function Player(props: { email: string; courseId: string; lessonId: string; onBack: () => void }) {
  const [lesson, setLesson] = useState<LessonDto | null>(null);
  const [fb, setFb] = useState<Record<number, { ok: boolean; text: string }>>({});
  const [picked, setPicked] = useState<Record<number, number>>({});

  const load = async (): Promise<void> => setLesson(await window.jarvis.mentor.lesson(props.email, props.courseId, props.lessonId));
  useEffect(() => {
    void load();
  }, []);

  if (!lesson) return <p className="muted">Загрузка…</p>;
  const p = lesson.progress;
  return (
    <div className="card">
      <button className="btn btn-small" onClick={props.onBack}>
        ← Ко всем урокам
      </button>
      <h2 style={{ marginTop: 12 }}>{lesson.title}</h2>
      <p className="muted">
        Цель: {lesson.goal} · Пройдено шагов: <strong>{p.done}</strong> из {p.total}
        {p.score !== null && <> · Тесты с первой попытки: {p.score}%</>}
        {p.completed && <span className="ok"> · урок пройден ✓</span>}
      </p>
      {lesson.steps.map((s, i) => (
        <div key={i} className="card" style={{ background: 'var(--panel-2)' }}>
          {s.kind === 'explain' && (
            <>
              <p style={{ margin: 0 }}>{s.text}</p>
              {s.kb && <div className="muted small">Источник: [«{s.kb.title}», ред. {s.kb.version}]</div>}
            </>
          )}
          {s.kind === 'quiz' && (
            <>
              <strong>{s.question}</strong> {s.done && <span className="ok">✓</span>}
              {s.options?.map((o, idx) => (
                <label key={idx} className="check" style={{ margin: '6px 0' }}>
                  <input type="radio" name={`q${i}`} checked={picked[i] === idx} onChange={() => setPicked({ ...picked, [i]: idx })} />
                  <span>{o}</span>
                </label>
              ))}
              <button
                className="btn btn-small"
                disabled={picked[i] === undefined}
                onClick={async () => {
                  const r = await window.jarvis.mentor.answer(props.email, props.courseId, props.lessonId, i, picked[i]!);
                  setFb({ ...fb, [i]: { ok: r.correct, text: r.correct ? `Верно. ${r.explain}` : `Пока нет. ${r.explain}` } });
                  await load();
                }}
              >
                Ответить
              </button>
            </>
          )}
          {s.kind === 'task' && (
            <>
              <strong>Практика.</strong> {s.text} {s.done && <span className="ok">✓</span>}
              <div className="row" style={{ marginTop: 8 }}>
                {s.canShow && (
                  <button
                    className="btn btn-small"
                    onClick={async () => {
                      try {
                        setFb({ ...fb, [i]: { ok: true, text: await window.jarvis.mentor.show(props.courseId, props.lessonId, i) } });
                      } catch (e) {
                        setFb({ ...fb, [i]: { ok: false, text: clean(e) } });
                      }
                    }}
                  >
                    Показать в CRM
                  </button>
                )}
                <button
                  className="btn btn-small btn-primary"
                  onClick={async () => {
                    try {
                      const r = await window.jarvis.mentor.verify(props.email, props.courseId, props.lessonId, i, true);
                      setFb({ ...fb, [i]: { ok: r.ok, text: r.message } });
                      await load();
                    } catch (e) {
                      setFb({ ...fb, [i]: { ok: false, text: clean(e) } });
                    }
                  }}
                >
                  {s.verify === 'self' ? 'Готово' : 'Проверить в тестовой CRM'}
                </button>
              </div>
            </>
          )}
          {fb[i] && <div className={`banner ${fb[i]!.ok ? 'banner-ok' : 'banner-demo'}`} style={{ marginTop: 8 }}>{fb[i]!.text}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------------- Кабинет руководителя ----------------

function Cabinet() {
  const [data, setData] = useState<{ employees: EmployeeRowDto[]; crmConnected: boolean; note: string } | null>(null);
  const [courses, setCourses] = useState<CourseDto[]>([]);
  const [err, setErr] = useState('');
  const [add, setAdd] = useState({ email: '', name: '', courseId: 'start' });

  const load = async (): Promise<void> => {
    setErr('');
    try {
      setData(await window.jarvis.mentor.cabinet());
    } catch (e) {
      setErr(clean(e));
    }
  };
  useEffect(() => {
    void load();
    void window.jarvis.mentor.courses().then(setCourses);
  }, []);

  return (
    <>
      {err && <div className="banner banner-err">{err}</div>}
      {data?.note && <div className="banner banner-demo">{data.note}</div>}
      <div className="card">
        <h2>Сотрудники</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Роль</th>
                <th>Курсы и прогресс</th>
                <th>Замечаний в CRM</th>
                <th>Рекомендации</th>
                <th>Активность</th>
              </tr>
            </thead>
            <tbody>
              {data?.employees.map((e) => (
                <tr key={e.email}>
                  <td title={e.email}>{e.name}</td>
                  <td>{e.role}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {e.assignments.length === 0 && <span className="muted">не назначены</span>}
                    {e.assignments.map((a) => (
                      <div key={a.courseId}>
                        {a.title}: {a.done}/{a.total}
                        {a.score !== null ? `, тесты ${a.score}%` : ''}
                        <button className="link" onClick={async () => { await window.jarvis.mentor.unassign(e.email, a.courseId); await load(); }}>снять</button>
                      </div>
                    ))}
                  </td>
                  <td className={e.issues ? 'dec-denied' : ''}>{e.issues}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {e.recommendations.length === 0 && <span className="muted">—</span>}
                    {e.recommendations.map((r) => (
                      <div key={r.courseId + r.lessonId}>
                        «{r.title}» <span className="muted small">({r.reason}, {r.count})</span>
                        <button className="link" onClick={async () => { await window.jarvis.mentor.assign(e.email, e.name, r.courseId); await load(); }}>назначить курс</button>
                      </div>
                    ))}
                  </td>
                  <td>{e.lastActivity ? formatTime(e.lastActivity) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Рекомендации строятся по ошибкам в карточках CRM (не заполнены поля, нет следующего действия, просрочки…). Это повод предложить обучение, не оценка сотрудника. Назначаете курс вы.</p>
      </div>
      <div className="card">
        <h2>Назначить курс</h2>
        <div className="row">
          <input value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} placeholder="email сотрудника" spellCheck={false} />
          <input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="Имя" />
          <select value={add.courseId} onChange={(e) => setAdd({ ...add, courseId: e.target.value })}>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={!add.email}
            onClick={async () => {
              try {
                await window.jarvis.mentor.assign(add.email, add.name || add.email, add.courseId);
                setAdd({ ...add, email: '', name: '' });
                await load();
              } catch (e) {
                setErr(clean(e));
              }
            }}
          >
            Назначить
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------- База знаний ----------------

function Kb() {
  const [docs, setDocs] = useState<KbDocDto[]>([]);
  const [edit, setEdit] = useState<{ id?: number; title: string; category: string; body: string; source: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async (): Promise<void> => setDocs(await window.jarvis.kb.list());
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  return (
    <>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <div className="card">
        <h2>Документы</h2>
        <p className="muted small">
          Наставник отвечает только по <strong>утверждённым</strong> документам и называет источник. Любая правка возвращает документ в черновики — его нужно утвердить заново. Стартовые материалы составлены по исходному коду CRM, правила вашей компании добавляйте сами.
        </p>
        <div className="row">
          <button className="btn btn-primary" onClick={() => setEdit({ title: '', category: 'regulation', body: '', source: '' })}>
            + Новый документ
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                const f = await window.jarvis.kb.importFile();
                if (f) setEdit({ title: f.name, category: 'regulation', body: f.text, source: `Файл «${f.name}»` });
              } catch (e) {
                setMsg({ ok: false, text: clean(e) });
              }
            }}
          >
            📄 Импорт из файла…
          </button>
        </div>
        <ul className="list">
          {docs.map((d) => (
            <li key={d.id} className="list-item">
              <div>
                <strong>{d.title}</strong> <span className="tag">{CATS[d.category]}</span>{' '}
                <span className={`tag ${d.status === 'approved' ? '' : 'tag-bad'}`}>{d.status === 'approved' ? `утверждён · ред. ${d.version}` : `черновик · ред. ${d.version}`}</span>
                <div className="muted small">{d.source || 'источник не указан'}</div>
              </div>
              <div className="row" style={{ flexShrink: 0 }}>
                <button className="btn btn-small" onClick={() => setEdit({ id: d.id, title: d.title, category: d.category, body: d.body, source: d.source })}>
                  Открыть
                </button>
                <button className="btn btn-small" onClick={() => void act(() => window.jarvis.kb.approve(d.id, d.status !== 'approved'), d.status === 'approved' ? 'Снято с утверждения' : 'Утверждено')}>
                  {d.status === 'approved' ? 'Снять утверждение' : 'Утвердить'}
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    if (window.confirm(`Удалить документ «${d.title}»?`)) void act(() => window.jarvis.kb.remove(d.id), 'Удалено');
                  }}
                >
                  Удалить
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {edit && (
        <div className="card">
          <h2>{edit.id ? 'Правка документа' : 'Новый документ'}</h2>
          <label className="field">
            <span>Название</span>
            <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} maxLength={150} />
          </label>
          <div className="row">
            <select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
              {Object.entries(CATS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <input value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} placeholder="Источник (например: Приказ №12 от 01.09.2026)" />
          </div>
          <label className="field">
            <span>Текст</span>
            <textarea rows={12} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} style={{ width: '100%' }} />
          </label>
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={() =>
                void act(async () => {
                  await window.jarvis.kb.save(edit);
                  setEdit(null);
                }, 'Сохранено как черновик — нажмите «Утвердить», чтобы наставник начал им пользоваться')
              }
            >
              Сохранить
            </button>
            <button className="btn" onClick={() => setEdit(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </>
  );
}
