import { useCallback, useEffect, useState } from 'react';
import { AGENT_GROUPS, type AgentDto, type AgentInputDto, type AgentRunDto, type AgentTemplateDto } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

const EMPTY: AgentInputDto = {
  name: '',
  description: '',
  instructions: '',
  groups: [],
  mode: 'read',
  schedule: { kind: 'none', atTime: '09:00', intervalMin: 30 },
  enabled: false,
};

const STATUS: Record<string, string> = { ok: 'готово', error: 'ошибка', stopped: 'остановлен', running: 'работает' };
const TRIGGER: Record<string, string> = { manual: 'вручную', schedule: 'по расписанию', assistant: 'из чата' };

function schedText(a: AgentInputDto): string {
  const s = a.schedule;
  if (s.kind === 'none') return 'только по запросу';
  const w = s.kind === 'daily' ? `каждый день в ${s.atTime}` : s.kind === 'weekdays' ? `по будням в ${s.atTime}` : `каждые ${s.intervalMin} мин`;
  return a.enabled ? w : `${w} (выключено)`;
}

export function AgentsView() {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [templates, setTemplates] = useState<AgentTemplateDto[]>([]);
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<AgentInputDto>(EMPTY);
  const [runs, setRuns] = useState<AgentRunDto[]>([]);
  const [task, setTask] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await window.jarvis.agents.list());
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, []);

  useEffect(() => {
    void window.jarvis.agents.templates().then(setTemplates).catch(() => undefined);
    void load();
  }, [load]);

  const cur = typeof sel === 'number' ? agents.find((a) => a.id === sel) ?? null : null;
  const running = agents.some((a) => a.running);

  // пока агент работает — обновляем состояние и журнал
  useEffect(() => {
    if (!running && typeof sel !== 'number') return;
    const t = setInterval(() => {
      void load();
      if (typeof sel === 'number') void window.jarvis.agents.runs(sel).then(setRuns).catch(() => undefined);
    }, running ? 1500 : 5000);
    return () => clearInterval(t);
  }, [running, sel, load]);

  const open = (a: AgentDto): void => {
    setSel(a.id);
    setForm({ id: a.id, name: a.name, description: a.description, instructions: a.instructions, groups: a.groups, mode: a.mode, schedule: { ...a.schedule, atTime: a.schedule.atTime ?? '09:00', intervalMin: a.schedule.intervalMin ?? 30 }, enabled: a.enabled });
    setRuns([]);
    setTask('');
    void window.jarvis.agents.runs(a.id).then(setRuns);
  };

  const fromTemplate = (t: AgentTemplateDto): void => {
    setSel('new');
    setForm({ ...t.input, schedule: { ...t.input.schedule, atTime: t.input.schedule.atTime ?? '09:00', intervalMin: t.input.schedule.intervalMin ?? 30 } });
    setRuns([]);
    setMsg(null);
  };

  const save = async (): Promise<void> => {
    try {
      const a = await window.jarvis.agents.save(form);
      setMsg({ ok: true, text: 'Агент сохранён' });
      await load();
      open(a);
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  const run = async (): Promise<void> => {
    if (!cur) return;
    try {
      setMsg(null);
      await window.jarvis.agents.run(cur.id, task);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  const toggleGroup = (g: AgentInputDto['groups'][number]): void =>
    setForm({ ...form, groups: form.groups.includes(g) ? form.groups.filter((x) => x !== g) : [...form.groups, g] });

  return (
    <section className="page" style={{ maxWidth: 1180 }}>
      <h1>Агенты</h1>
      <p className="muted">
        Агент — это помощник с одной ролью: вы описываете, что он делает, выбираете, к чему у него есть доступ, и (по желанию) расписание. Каждый агент отчитывается и ведёт журнал запусков.
        Все его действия идут через ту же защиту, что и у основного ассистента: в режиме «только чтение» изменяющих инструментов у него просто нет, а в режиме «с действиями» каждое действие подтверждаете вы.
        Агенту нужна подключённая модель (Claude или бесплатная).
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      <div className="card" id="agent-templates">
        <h2>Быстрое создание</h2>
        <div className="row">
          {templates.map((t) => (
            <button key={t.key} className="btn" onClick={() => fromTemplate(t)} title={t.input.description}>+ {t.input.name}</button>
          ))}
          <button className="btn btn-primary" id="agent-new" onClick={() => { setSel('new'); setForm(EMPTY); setRuns([]); setMsg(null); }}>+ Свой агент</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14, alignItems: 'start' }}>
        <div className="card">
          <h2>Ваши агенты ({agents.length})</h2>
          {agents.length === 0 && <p className="muted small">Пока нет. Выберите заготовку выше или создайте своего.</p>}
          <ul className="list">
            {agents.map((a) => (
              <li key={a.id} className={`list-item ${sel === a.id ? 'active' : ''}`} style={{ cursor: 'pointer', display: 'block' }} onClick={() => open(a)} data-agent={a.name}>
                <strong>{a.name}</strong> {a.running && <span className="tag">работает…</span>}
                <div className="muted small">{schedText({ ...a })}</div>
                {a.lastStatus && <div className="small">{STATUS[a.lastStatus]} · {a.lastRunAt ? formatTime(a.lastRunAt) : ''}</div>}
              </li>
            ))}
          </ul>
        </div>

        <div className="card" id="agent-editor">
          {sel === null && <p className="muted">Выберите агента слева или создайте нового.</p>}
          {sel !== null && (
            <>
              <h2>{sel === 'new' ? 'Новый агент' : form.name}</h2>
              <label className="field"><span>Имя</span><input id="agent-name" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="field"><span>Кратко: чем занимается</span><input value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              <label className="field">
                <span>Инструкция — роль и что делать</span>
                <textarea id="agent-instructions" rows={6} maxLength={4000} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Например: Ты аналитик продаж. Каждый день смотри заявки в CRM, находи просроченные и пиши короткий итог с тремя предложениями, что исправить." />
              </label>

              <h3>К чему есть доступ</h3>
              <div className="grid-checks">
                {AGENT_GROUPS.map((g) => (
                  <label key={g.id} className="check">
                    <input type="checkbox" checked={form.groups.includes(g.id)} onChange={() => toggleGroup(g.id)} data-group={g.id} />
                    <span><strong>{g.title}</strong> {g.risky && <span className="tag">осторожно</span>} <span className="muted small">— {g.description}</span></span>
                  </label>
                ))}
              </div>
              <label className="field">
                <span>Режим</span>
                <select id="agent-mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'read' | 'act' })}>
                  <option value="read">Только чтение и анализ (изменяющих инструментов у агента нет)</option>
                  <option value="act">С действиями (каждое действие — с вашим подтверждением на экране)</option>
                </select>
              </label>

              <h3>Расписание</h3>
              <div className="row">
                <select value={form.schedule.kind} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, kind: e.target.value as AgentInputDto['schedule']['kind'] } })}>
                  <option value="none">Только по запросу</option>
                  <option value="weekdays">По будням</option>
                  <option value="daily">Каждый день</option>
                  <option value="interval">Каждые N минут</option>
                </select>
                {(form.schedule.kind === 'daily' || form.schedule.kind === 'weekdays') && (
                  <input type="time" value={form.schedule.atTime ?? '09:00'} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, atTime: e.target.value } })} style={{ maxWidth: 140 }} />
                )}
                {form.schedule.kind === 'interval' && (
                  <input type="number" min={5} max={1440} value={form.schedule.intervalMin ?? 30} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, intervalMin: Number(e.target.value) } })} style={{ maxWidth: 120 }} />
                )}
                {form.schedule.kind !== 'none' && (
                  <label className="check" style={{ margin: 0 }}>
                    <input type="checkbox" id="agent-enabled" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                    <span>включено</span>
                  </label>
                )}
              </div>
              {form.schedule.kind !== 'none' && (
                <p className="muted small">По расписанию агент работает без вас: только чтение и анализ, всё, что требует подтверждения, отклоняется. Если итог «OK» — уведомления нет. Работает, пока программа запущена.</p>
              )}

              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btn-primary" id="agent-save" onClick={() => void save()}>Сохранить</button>
                {cur && <button className="btn btn-danger" onClick={() => window.confirm(`Удалить агента «${cur.name}» вместе с журналом?`) && void window.jarvis.agents.remove(cur.id).then(() => { setSel(null); return load(); })}>Удалить</button>}
              </div>

              {cur && (
                <>
                  <h3>Запуск</h3>
                  <div className="row">
                    <input id="agent-task" style={{ flex: 1 }} value={task} placeholder="Поручение на этот запуск (необязательно)…" onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !cur.running && void run()} />
                    {!cur.running && <button className="btn btn-primary" id="agent-run" onClick={() => void run()}>Запустить</button>}
                    {cur.running && <button className="btn btn-danger" onClick={() => void window.jarvis.agents.stop(cur.id)}>Остановить</button>}
                  </div>
                  <p className="muted small">Запуск кнопкой — вы рядом: если у агента режим «с действиями», окно подтверждения появится на экране. Голосом: «Системно, запусти агента {cur.name}» — из чата агент работает только на чтение.</p>
                  {cur.notes && (
                    <details style={{ marginTop: 8 }}>
                      <summary>Заметки агента (он запоминает между запусками)</summary>
                      <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{cur.notes}</pre>
                      <button className="btn btn-small" onClick={() => void window.jarvis.agents.clearNotes(cur.id).then(load)}>Очистить заметки</button>
                    </details>
                  )}
                  <h3>Журнал запусков</h3>
                  {runs.length === 0 && <p className="muted small">Запусков ещё не было.</p>}
                  <ul className="list">
                    {runs.map((r) => (
                      <li key={r.id} className="list-item" style={{ display: 'block' }} data-run={r.id}>
                        <div><strong>{STATUS[r.status]}</strong> <span className="muted small">· {TRIGGER[r.trigger]} · {formatTime(r.startedAt)}</span></div>
                        {r.task && r.task !== 'Выполни свою задачу согласно инструкции.' && <div className="muted small">Поручение: {r.task}</div>}
                        {r.report && <div className="agent-report" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.report}</div>}
                        {r.steps.length > 0 && <details><summary className="muted small">Ход работы ({r.steps.length})</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.steps.join('\n')}</pre></details>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
