import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings, TelegramChatDto, TelegramMessageDto, TelegramStatusDto } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function TelegramView(props: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [st, setSt] = useState<TelegramStatusDto | null>(null);
  const [chats, setChats] = useState<TelegramChatDto[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<TelegramMessageDto[]>([]);
  const [token, setToken] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [text, setText] = useState('');
  const [instr, setInstr] = useState(props.settings.telegramReplyInstructions);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await window.jarvis.telegram.status();
      setSt(s);
      if (s.connected) {
        setChats(await window.jarvis.telegram.chats());
        if (open !== null) setMsgs(await window.jarvis.telegram.messages(open));
      }
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, [open]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs.length]);

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };

  const current = chats.find((c) => c.chatId === open) ?? null;

  return (
    <section className="page" style={{ maxWidth: 1100 }}>
      <h1>Telegram</h1>
      <p className="muted">
        Работает через вашего собственного бота (официальный способ Telegram): бот может писать только тем, кто сам ему написал. Личный аккаунт Telegram программа не использует — это запрещено правилами Telegram и опасно для аккаунта.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      {st?.error && <div className="banner banner-err">{st.error}</div>}

      {!st?.connected && (
        <div className="card" id="tg-connect">
          <h2>Подключение бота</h2>
          <ol className="muted">
            <li>В Telegram найдите <strong>@BotFather</strong> и отправьте ему <code>/newbot</code>.</li>
            <li>Придумайте имя и логин бота (логин оканчивается на <code>bot</code>).</li>
            <li>BotFather пришлёт <strong>токен</strong> — длинная строка вида <code>123456789:AAH…</code>. Вставьте её сюда.</li>
          </ol>
          <div className="row">
            <input id="tg-token" type="password" autoComplete="off" placeholder="Токен бота" value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1 }} />
            <button id="tg-connect-btn" className="btn btn-primary" disabled={busy || !token.trim()} onClick={() => void run(async () => { await window.jarvis.telegram.connect(token); setToken(''); }, 'Бот подключён')}>
              Подключить
            </button>
          </div>
          <p className="muted small">Токен хранится зашифрованным (средствами Windows) и никуда, кроме Telegram, не отправляется.</p>
        </div>
      )}

      {st?.connected && (
        <>
          <div className="card" id="tg-status">
            <h2>Бот @{st.botUsername || '…'}</h2>
            <p>
              {st.running ? <span className="ok">● опрос идёт</span> : <span className="muted">● остановлен</span>} ·{' '}
              {st.ownerLinked ? <>ваш Telegram привязан: <strong>{st.ownerName}</strong></> : 'ваш Telegram не привязан'}
            </p>
            <div className="row">
              {!st.ownerLinked && (
                <button className="btn" id="tg-code-btn" onClick={() => void run(async () => setCode(await window.jarvis.telegram.pairCode()))}>Привязать мой Telegram</button>
              )}
              {st.ownerLinked && <button className="btn" onClick={() => void run(() => window.jarvis.telegram.unlink())}>Отвязать мой Telegram</button>}
              <button className="btn btn-danger" onClick={() => window.confirm('Отключить бота и удалить токен?') && void run(() => window.jarvis.telegram.disconnect(), 'Бот отключён')}>Отключить бота</button>
            </div>
            {code && !st.ownerLinked && (
              <p>
                Откройте бота в Telegram и отправьте ему: <strong id="tg-code" style={{ fontSize: 22 }}>/start {code.code}</strong> <span className="muted small">(код действует 5 минут)</span>
              </p>
            )}
            {st.ownerLinked && (
              <p className="muted small">
                Теперь можно писать боту поручения прямо из Telegram. Как и с телефона: вопросы и анализ — сразу; действия — только если включено «Разрешить телефону просить действия» в настройках, и подтверждение появится на компьютере; опасные действия запрещены всегда. <code>/stop</code> — остановить.
              </p>
            )}
          </div>

          <div className="card" id="tg-auto">
            <h2>Автоответчик</h2>
            <p className="muted small">
              ИИ отвечает людям, написавшим боту. <strong>Только текстом</strong>, по вашим инструкциям ниже — о базе знаний, CRM и ваших данных он не знает. Представляется ИИ в первом ответе, не больше 6 ответов в час на человека, «позовите человека» передаёт вопрос вам. Нужна подключённая модель.
            </p>
            <label className="check">
              <input type="checkbox" id="tg-auto-toggle" checked={props.settings.telegramAutoReply} onChange={(e) => void run(() => props.onUpdate({ telegramAutoReply: e.target.checked }))} />
              <span><strong>Включить автоответчик</strong></span>
            </label>
            <label className="field">
              <span>Что можно рассказывать людям (цены, график, адрес, частые вопросы)</span>
              <textarea rows={5} maxLength={3000} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="Например: Мы продаём пластиковые окна. Замер бесплатный. Работаем пн–пт с 9 до 18. Телефон: …" />
            </label>
            <button className="btn" disabled={instr === props.settings.telegramReplyInstructions} onClick={() => void run(() => props.onUpdate({ telegramReplyInstructions: instr }), 'Сохранено')}>Сохранить инструкции</button>
          </div>

          <div className="card" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }}>
            <div>
              <h2>Чаты</h2>
              {chats.length === 0 && <p className="muted small">Пока никто не писал боту.</p>}
              <ul className="list">
                {chats.map((c) => (
                  <li key={c.chatId} className={`list-item ${open === c.chatId ? 'active' : ''}`} style={{ cursor: 'pointer', display: 'block' }} onClick={() => { setOpen(c.chatId); void window.jarvis.telegram.messages(c.chatId).then(setMsgs); }}>
                    <strong>{c.name}</strong> {c.isOwner && <span className="tag">вы</span>} {c.unread > 0 && <span className="tag">{c.unread} нов.</span>} {c.needsHuman && <span className="tag">ждёт человека</span>}
                    <div className="muted small">{c.lastText}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              {!current && <p className="muted">Выберите чат слева.</p>}
              {current && (
                <>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0 }}>{current.name}</h2>
                    <span className="row">
                      {current.needsHuman && <button className="btn" onClick={() => void run(async () => setChats(await window.jarvis.telegram.resolveHuman(current.chatId)))}>Отметить решённым</button>}
                      {!current.isOwner && (
                        <label className="check" style={{ margin: 0 }}>
                          <input type="checkbox" checked={current.autoReply} onChange={(e) => void run(async () => setChats(await window.jarvis.telegram.setAutoReply(current.chatId, e.target.checked)))} />
                          <span>автоответ</span>
                        </label>
                      )}
                    </span>
                  </div>
                  <div ref={logRef} style={{ maxHeight: 320, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, margin: '10px 0' }}>
                    {msgs.map((m) => (
                      <div key={m.id} className={`call-line ${m.dir === 'in' ? 'call-employee' : 'call-jarvis'}`}>
                        <span className="muted small">{m.dir === 'in' ? current.name : m.auto ? 'ИИ (авто)' : 'Вы'} · {formatTime(m.at)}</span>
                        <div>{m.text}</div>
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <input style={{ flex: 1 }} value={text} placeholder="Написать от имени бота…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void run(async () => { setMsgs(await window.jarvis.telegram.send(current.chatId, text)); setText(''); })} />
                    <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void run(async () => { setMsgs(await window.jarvis.telegram.send(current.chatId, text)); setText(''); })}>Отправить</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
