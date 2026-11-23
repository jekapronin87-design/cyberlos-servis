import { useEffect, useState } from 'react';
import type { BriefingConfigDto, BriefingStateDto } from '../../shared/deck';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function BriefingCard() {
  const [st, setSt] = useState<BriefingStateDto | null>(null);
  const [cfg, setCfg] = useState<BriefingConfigDto | null>(null);
  const [vip, setVip] = useState('');
  const [prov, setProv] = useState<'gmail' | 'yandex'>('gmail');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.jarvis.briefing.get().then((s) => {
      setSt(s);
      setCfg(s.config);
      setVip(s.config.vip.join(', '));
    });
  }, []);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };
  if (!cfg || !st) return null;
  const patch = (p: Partial<BriefingConfigDto>): void => setCfg({ ...cfg, ...p });
  const save = (): Promise<void> =>
    run(async () => {
      const s = await window.jarvis.briefing.save({ ...cfg, vip: vip.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) });
      setSt(s);
      setCfg(s.config);
      setMsg({ ok: true, text: `Сохранено. Сводка будет каждый день в ${s.config.time} (${s.config.tz}).` });
    });

  return (
    <div className="card" id="briefing-card">
      <h2>Утренняя сводка и тревоги</h2>
      <p className="muted small">
        Каждый день в назначенное время Системно сам открывает красивую «космическую» сводку: цифры бизнеса, Telegram-бот клуба (сколько зашло, кто оплатил, кто на каком этапе), важная почта и рабочие чаты. Если что-то горит — покажет тревогу и пришлёт уведомление. Всё считается обычными правилами, <strong>без нейросети и без расходов</strong>. Приложение должно быть запущено (включите «запуск при входе в Windows»). Сказать голосом: «покажи утреннюю сводку».
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <div className="row">
        <label className="check"><input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /><span>Показывать сводку каждый день</span></label>
        <label className="field">
          <span>Время</span>
          <input id="briefing-time" type="time" value={cfg.time} onChange={(e) => patch({ time: e.target.value })} />
        </label>
        <label className="field grow">
          <span>Часовой пояс</span>
          <input value={cfg.tz} onChange={(e) => patch({ tz: e.target.value })} spellCheck={false} placeholder="Asia/Bangkok" />
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={cfg.speak} onChange={(e) => patch({ speak: e.target.checked })} /><span>Озвучивать приветствие голосом</span></label>
      <label className="check"><input type="checkbox" checked={cfg.alerts} onChange={(e) => patch({ alerts: e.target.checked })} /><span>Тревоги: проверять каждые 15 минут и присылать уведомление, если появилась новая проблема</span></label>

      <h3 style={{ marginTop: 16 }}>Почта (Gmail и Яндекс)</h3>
      <p className="muted small">
        Программа только <strong>смотрит заголовки</strong> непрочитанных писем (кто, тема, когда) — письма не открываются, не помечаются прочитанными, ничего не отправляется и не удаляется. Входить нужно не обычным паролем, а «паролем приложения»:
        <br />• <strong>Gmail</strong>: аккаунт Google → Безопасность → включить двухэтапную проверку → «Пароли приложений» → создать пароль для «Почта».
        <br />• <strong>Яндекс</strong>: Почта → Настройки → «Почтовые программы» → включить IMAP → Безопасность → «Пароли приложений» → создать.
      </p>
      {st.mail.map((a) => (
        <div key={a.id} className="row" style={{ alignItems: 'center' }}>
          <span className="grow">{a.provider === 'gmail' ? 'Gmail' : 'Яндекс'} · {a.email} {a.hasPassword && <em className="ok">· пароль задан</em>}</span>
          <button className="btn" disabled={busy} onClick={() => void run(async () => setMsg({ ok: true, text: await window.jarvis.briefing.mailTest(a.id) }))}>Проверить</button>
          <button className="btn" disabled={busy} onClick={() => void run(async () => setSt({ ...st, mail: await window.jarvis.briefing.mailRemove(a.id) }))}>Убрать</button>
        </div>
      ))}
      <div className="row">
        <label className="field">
          <span>Почта</span>
          <select value={prov} onChange={(e) => setProv(e.target.value as 'gmail' | 'yandex')}>
            <option value="gmail">Gmail</option>
            <option value="yandex">Яндекс</option>
          </select>
        </label>
        <label className="field grow">
          <span>Адрес</span>
          <input id="mail-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@gmail.com" autoComplete="off" spellCheck={false} />
        </label>
        <label className="field grow">
          <span>Пароль приложения</span>
          <input id="mail-pass" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" placeholder="xxxx xxxx xxxx xxxx" />
        </label>
        <button
          className="btn btn-primary"
          disabled={busy || !email || !pw}
          onClick={() =>
            void run(async () => {
              const mail = await window.jarvis.briefing.mailAdd(prov, email, pw);
              setSt({ ...st, mail });
              setEmail('');
              setPw('');
              setMsg({ ok: true, text: 'Ящик добавлен. Нажмите «Проверить» рядом с ним.' });
            })
          }
        >
          Добавить
        </button>
      </div>
      <label className="field">
        <span>Важные отправители (через запятую: части адреса или имени — письма от них будут помечаться как важные и вызывать тревогу)</span>
        <input id="briefing-vip" value={vip} onChange={(e) => setVip(e.target.value)} placeholder="bank, nalog, партнёр@компания.ру" spellCheck={false} />
      </label>
      <small className="muted">Важными также считаются письма со словами «счёт, оплата, договор, срочно, претензия, налог…», письма с флажком и с пометкой Gmail «важное». Рассылки отсеиваются.</small>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" id="briefing-save" disabled={busy} onClick={() => void save()}>Сохранить</button>
        <button className="btn" id="briefing-run" disabled={busy} onClick={() => void run(async () => void (await window.jarvis.briefing.run()))}>Показать сводку сейчас</button>
      </div>
      {!st.crm && <small className="muted">CRM «Аквамастер» не подключена — в сводке будут только почта и то, что доступно.</small>}
    </div>
  );
}
