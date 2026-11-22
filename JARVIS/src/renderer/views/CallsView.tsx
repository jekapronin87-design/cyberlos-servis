import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings, CallDto, CallStateDto, ConsentDto, CourseDto } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

const STATUS: Record<string, string> = {
  running: 'идёт',
  completed: 'урок пройден',
  declined: 'отказался',
  opted_out: 'просил не звонить',
  no_answer: 'не ответил',
  stopped: 'остановил',
  hung_up: 'завершён',
  error: 'ошибка',
};

export function CallsView() {
  const [info, setInfo] = useState<{ provider: string; real: boolean; note: string } | null>(null);
  const [consents, setConsents] = useState<ConsentDto[]>([]);
  const [calls, setCalls] = useState<CallDto[]>([]);
  const [courses, setCourses] = useState<CourseDto[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ phone: '', name: '', email: '', recording: false, confirmed: false, source: '' });
  const [pick, setPick] = useState({ phone: '', lesson: '' });
  const [active, setActive] = useState<CallStateDto | null>(null);
  const [reply, setReply] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const [lim, setLim] = useState<Pick<Settings, 'callWindowFrom' | 'callWindowTo' | 'callMaxPerDay' | 'callMaxPerNumberPerDay'> | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await window.jarvis.telephony.status());
      setConsents(await window.jarvis.telephony.consents());
      setCalls(await window.jarvis.telephony.calls());
      setCourses(await window.jarvis.mentor.courses());
      setLim(await window.jarvis.settings.get());
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока идёт звонок в симуляторе — обновляем разговор.
  useEffect(() => {
    if (!active || active.finished) return;
    const t = setInterval(() => {
      void window.jarvis.telephony
        .state(active.id)
        .then((s) => {
          setActive(s);
          if (s.finished) void load();
        })
        .catch(() => undefined);
    }, 500);
    return () => clearInterval(t);
  }, [active, load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [active?.lines.length]);

  const grant = async (): Promise<void> => {
    try {
      setConsents(await window.jarvis.telephony.grant(form));
      setForm({ phone: '', name: '', email: '', recording: false, confirmed: false, source: '' });
      setMsg({ ok: true, text: 'Согласие внесено в реестр' });
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  const start = async (): Promise<void> => {
    const [courseId, lessonId] = pick.lesson.split('/');
    try {
      const { callId } = await window.jarvis.telephony.start({ phone: pick.phone, courseId: courseId ?? '', lessonId: lessonId ?? '' });
      setMsg(null);
      setActive(await window.jarvis.telephony.state(callId));
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  const send = async (): Promise<void> => {
    if (!active || !reply.trim()) return;
    const t = reply;
    setReply('');
    await window.jarvis.telephony.reply(active.id, t).catch((e) => setMsg({ ok: false, text: clean(e) }));
  };

  const live = consents.filter((c) => !c.revokedAt);

  return (
    <section className="page">
      <h1>Звонки наставника</h1>
      {info && <div className={`banner ${info.real ? 'banner-ok' : 'banner-demo'}`}>{info.note}</div>}
      <p className="muted">
        Правила: звонок возможен только сотруднику, чьё согласие внесено в реестр; только в разрешённое время и в пределах лимитов; в начале разговора ИИ представляется; разговор не записывается, если нет отдельного согласия на запись; «стоп» завершает звонок в любой момент. В CRM звонки ничего не меняют.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      {lim && (
        <div className="card" id="limits-card">
          <h2>Время и лимиты</h2>
          <div className="row">
            <label className="field"><span>Звонить с</span><input type="time" value={lim.callWindowFrom} onChange={(e) => setLim({ ...lim, callWindowFrom: e.target.value })} /></label>
            <label className="field"><span>до</span><input type="time" value={lim.callWindowTo} onChange={(e) => setLim({ ...lim, callWindowTo: e.target.value })} /></label>
            <label className="field"><span>Всего звонков в день</span><input type="number" min={1} max={200} value={lim.callMaxPerDay} onChange={(e) => setLim({ ...lim, callMaxPerDay: Number(e.target.value) })} /></label>
            <label className="field"><span>На один номер в день</span><input type="number" min={1} max={10} value={lim.callMaxPerNumberPerDay} onChange={(e) => setLim({ ...lim, callMaxPerNumberPerDay: Number(e.target.value) })} /></label>
            <button className="btn" onClick={() => void window.jarvis.settings.update(lim).then(() => setMsg({ ok: true, text: 'Сохранено' })).catch((e) => setMsg({ ok: false, text: clean(e) }))}>Сохранить</button>
          </div>
        </div>
      )}

      <div className="card" id="consent-card">
        <h2>Согласия сотрудников</h2>
        <div className="row">
          <input placeholder="Телефон, например +7 916 123-45-67" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input placeholder="Имя сотрудника" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Почта в CRM (для учёта обучения)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <label className="check">
          <input type="checkbox" checked={form.recording} onChange={(e) => setForm({ ...form, recording: e.target.checked })} />
          <span>Отдельно: согласен на запись текста разговора (по умолчанию разговор не сохраняется)</span>
        </label>
        <label className="check">
          <input id="consent-confirm" type="checkbox" checked={form.confirmed} onChange={(e) => setForm({ ...form, confirmed: e.target.checked })} />
          <span>
            <strong>Сотрудник сам дал согласие</strong> на учебные звонки ИИ-наставника (устно или письменно) и знает, что звонит программа
          </span>
        </label>
        <button className="btn btn-primary" id="consent-add" disabled={!form.confirmed || !form.phone || !form.name} onClick={() => void grant()}>
          Внести согласие
        </button>
        <ul className="list" style={{ marginTop: 12 }}>
          {consents.length === 0 && <li className="muted small">Реестр пуст.</li>}
          {consents.map((c) => (
            <li key={c.id} className="list-item">
              <span>
                <strong>{c.name}</strong> <span className="muted small">{c.phone}{c.email ? ` · ${c.email}` : ''}</span>{' '}
                {c.recording && <span className="tag">запись разрешена</span>} {c.revokedAt && <span className="tag">отозвано</span>}
              </span>
              {!c.revokedAt && (
                <button className="btn btn-danger" onClick={() => window.confirm(`Отозвать согласие «${c.name}»? Звонки на этот номер прекратятся.`) && void window.jarvis.telephony.revoke(c.phone).then(setConsents)}>
                  Отозвать
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card" id="call-card">
        <h2>{info?.real ? 'Учебный звонок' : 'Тренажёр звонка (симулятор)'}</h2>
        {!active ? (
          <>
            <p className="muted small">Вы играете роль сотрудника: Системно «звонит», представляется и проводит урок. Так можно проверить сценарий до подключения настоящей связи.</p>
            <div className="row">
              <select id="call-phone" value={pick.phone} onChange={(e) => setPick({ ...pick, phone: e.target.value })}>
                <option value="">— кому звонить —</option>
                {live.map((c) => (
                  <option key={c.id} value={c.phone}>{c.name} ({c.phone})</option>
                ))}
              </select>
              <select id="call-lesson" value={pick.lesson} onChange={(e) => setPick({ ...pick, lesson: e.target.value })}>
                <option value="">— какой урок —</option>
                {courses.flatMap((c) => c.lessons.map((l) => <option key={`${c.id}/${l.id}`} value={`${c.id}/${l.id}`}>{c.title}: {l.title}</option>))}
              </select>
              <button className="btn btn-primary" id="call-start" disabled={!pick.phone || !pick.lesson} onClick={() => void start()}>Позвонить</button>
            </div>
          </>
        ) : (
          <>
            <div ref={logRef} id="call-log" style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
              {active.lines.map((l, i) => (
                <div key={i} className={`call-line call-${l.who}`}><strong>{l.who === 'jarvis' ? 'Системно (ИИ)' : l.who === 'employee' ? 'Сотрудник' : '—'}:</strong> {l.text}</div>
              ))}
            </div>
            {active.finished ? (
              <div className="row">
                <span className="banner banner-ok" id="call-result">Звонок завершён: {STATUS[active.status] ?? active.status}</span>
                <button className="btn" onClick={() => setActive(null)}>Закрыть</button>
              </div>
            ) : (
              <div className="row">
                <input id="call-reply" style={{ flex: 1 }} value={reply} placeholder="Ответ сотрудника…" onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
                <button className="btn btn-primary" id="call-send" onClick={() => void send()} disabled={!active.awaitingReply}>Ответить</button>
                <button className="btn btn-danger" onClick={() => void window.jarvis.telephony.hangup(active.id)}>Положить трубку</button>
              </div>
            )}
          </>
        )}
      </div>

      <h2>Журнал звонков</h2>
      <ul className="list">
        {calls.length === 0 && <li className="muted small">Звонков пока не было.</li>}
        {calls.map((c) => (
          <li key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
            <div>
              <strong>{c.name}</strong> <span className="muted small">{c.phone} · {formatTime(c.startedAt)}</span>
              <div className="small">{c.summary ?? STATUS[c.status] ?? c.status}{c.recorded ? ' · есть запись текста' : ''}</div>
            </div>
            {c.recorded && (
              <span className="row">
                <button className="btn" onClick={() => void window.jarvis.telephony.transcript(c.id).then((t) => window.alert(t ?? 'Записи нет'))}>Текст</button>
                <button className="btn btn-danger" onClick={() => window.confirm('Удалить запись разговора?') && void window.jarvis.telephony.deleteTranscript(c.id).then(load)}>Удалить запись</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
