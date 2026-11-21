import { useEffect, useState } from 'react';
import type { JobDto, JobInputDto } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

const TEMPLATES: { label: string; input: JobInputDto }[] = [
  {
    label: 'Утренняя сводка по CRM (по будням, 09:00)',
    input: { title: 'Утренняя сводка по CRM', kind: 'weekdays', atTime: '09:00', prompt: 'Сделай утреннюю сводку по CRM (crm_report daily и crm_overview): что важно, где просрочки, кому нужно внимание, 3 конкретных предложения.' },
  },
  {
    label: 'Контроль новых заявок (каждые 30 минут)',
    input: { title: 'Контроль новых заявок', kind: 'interval', intervalMin: 30, prompt: 'Проверь CRM: есть ли новые заявки без ответственного или просроченные по SLA. Если ничего срочного — ответь «OK». Иначе перечисли, что требует внимания.' },
  },
  {
    label: 'Вечерний итог дня (по будням, 18:30)',
    input: { title: 'Вечерний итог дня', kind: 'weekdays', atTime: '18:30', prompt: 'Подведи итог дня по CRM: сколько заявок обработано, что осталось просроченным, как работали менеджеры, что сделать завтра в первую очередь.' },
  },
  {
    label: 'Контроль производства и склада (каждый день, 10:00)',
    input: { title: 'Производство и склад', kind: 'daily', atTime: '10:00', prompt: 'Проверь производство и склад в CRM (crm_production). Если просрочек, ожидающих предоплаты заказов и позиций на исходе нет — ответь «OK». Иначе кратко перечисли.' },
  },
];

const STATUS: Record<string, string> = { ok: 'выполнено', error: 'ошибка', stopped: 'остановлено', skipped: 'пропущено' };

function schedText(j: JobDto): string {
  if (j.kind === 'daily') return `каждый день в ${j.atTime}`;
  if (j.kind === 'weekdays') return `по будням в ${j.atTime}`;
  if (j.kind === 'interval') return `каждые ${j.intervalMin} мин`;
  return `один раз: ${j.runAt ? formatTime(j.runAt) : ''}`;
}

export function JobsView(props: { onOpenConversation: (id: number) => void }) {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState<JobInputDto>({ title: '', prompt: '', kind: 'weekdays', atTime: '09:00', intervalMin: 30 });
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async (): Promise<void> => setJobs(await window.jarvis.jobs.list());
  useEffect(() => {
    void load();
    return window.jarvis.jobs.onResult(() => void load());
  }, []);

  const create = async (input: JobInputDto): Promise<void> => {
    try {
      await window.jarvis.jobs.create(input);
      setMsg({ ok: true, text: 'Задача создана' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  return (
    <section className="page">
      <h1>Задачи по расписанию</h1>
      <p className="muted">
        Джарвис сам выполняет поручения по расписанию и присылает итог уведомлением. Работает, пока JARVIS запущен (включите автозапуск в настройках). <strong>В фоне он может только читать и анализировать:</strong> всё, что требует вашего подтверждения (изменить файл, открыть сайт…), он выполнить не сможет. Нужен ключ Claude.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      <div className="card">
        <h2>Быстрое создание</h2>
        <div className="row">
          {TEMPLATES.map((t) => (
            <button key={t.label} className="btn" onClick={() => void create(t.input)}>
              + {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Своя задача</h2>
        <label className="field">
          <span>Название</span>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={80} placeholder="Например: Проверка заявок" />
        </label>
        <label className="field">
          <span>Что сделать</span>
          <textarea rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} maxLength={2000} placeholder="Например: Проверь CRM, есть ли просроченные заявки. Если нет — ответь «OK»." />
          <small className="muted">Если ответ «OK» — уведомления не будет, чтобы не отвлекать. Иначе придёт короткий итог.</small>
        </label>
        <div className="row">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as JobInputDto['kind'] })}>
            <option value="weekdays">По будням</option>
            <option value="daily">Каждый день</option>
            <option value="interval">Каждые N минут</option>
          </select>
          {form.kind === 'interval' ? (
            <input type="number" min={5} max={1440} value={form.intervalMin ?? 30} onChange={(e) => setForm({ ...form, intervalMin: Number(e.target.value) })} style={{ maxWidth: 120 }} aria-label="Минут" />
          ) : (
            <input type="time" value={form.atTime ?? '09:00'} onChange={(e) => setForm({ ...form, atTime: e.target.value })} style={{ maxWidth: 140 }} aria-label="Время" />
          )}
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={form.speak === true} onChange={(e) => setForm({ ...form, speak: e.target.checked })} />
            <span>Озвучивать итог</span>
          </label>
          <button className="btn btn-primary" disabled={!form.title.trim() || !form.prompt.trim()} onClick={() => void create(form)}>
            Создать
          </button>
        </div>
      </div>

      <h2>Ваши задачи ({jobs.length})</h2>
      {jobs.length === 0 && <p className="muted">Пока нет задач.</p>}
      <ul className="list">
        {jobs.map((j) => (
          <li key={j.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <div>
              <strong>{j.title}</strong> <span className="tag">{schedText(j)}</span> {!j.enabled && <span className="tag">выключена</span>}
              <div className="muted small">{j.prompt.slice(0, 160)}{j.prompt.length > 160 ? '…' : ''}</div>
              <div className="muted small">
                Ближайший запуск: {j.nextRunAt ? formatTime(j.nextRunAt) : '—'} · Последний: {j.lastRunAt ? `${formatTime(j.lastRunAt)} — ${STATUS[j.lastStatus ?? ''] ?? ''}` : 'ещё не было'}
              </div>
              {j.lastSummary && <div className="small" style={{ marginTop: 4 }}>{j.lastSummary.slice(0, 300)}</div>}
            </div>
            <div className="row" style={{ flexShrink: 0 }}>
              <button
                className="btn btn-small"
                disabled={busyId !== null}
                onClick={async () => {
                  setBusyId(j.id);
                  setMsg({ ok: true, text: 'Выполняю…' });
                  try {
                    const r = await window.jarvis.jobs.runNow(j.id);
                    setMsg({ ok: r.status === 'ok', text: `${STATUS[r.status ?? ''] ?? ''}: ${r.summary.slice(0, 300)}` });
                  } catch (e) {
                    setMsg({ ok: false, text: clean(e) });
                  } finally {
                    setBusyId(null);
                    await load();
                  }
                }}
              >
                {busyId === j.id ? '…' : 'Выполнить сейчас'}
              </button>
              {j.conversationId && (
                <button className="btn btn-small" onClick={() => props.onOpenConversation(j.conversationId!)}>
                  Диалог
                </button>
              )}
              <button className="btn btn-small" onClick={async () => { await window.jarvis.jobs.setEnabled(j.id, !j.enabled); await load(); }}>
                {j.enabled ? 'Выключить' : 'Включить'}
              </button>
              <button
                className="btn btn-small"
                onClick={async () => {
                  if (!window.confirm(`Удалить задачу «${j.title}»?`)) return;
                  await window.jarvis.jobs.remove(j.id);
                  await load();
                }}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
