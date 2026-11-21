import { useEffect, useState } from 'react';
import type { ComputerAccess } from '../../shared/types';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function ComputerAccessCard() {
  const [acc, setAcc] = useState<ComputerAccess | null>(null);
  const [host, setHost] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void window.jarvis.computer.get().then(setAcc);
  }, []);

  const act = async (fn: () => Promise<ComputerAccess | null>, ok: string): Promise<void> => {
    try {
      const r = await fn();
      if (r) {
        setAcc(r);
        setMsg({ ok: true, text: ok });
      }
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  return (
    <div className="card" id="computer-access">
      <h2>Доступ к компьютеру</h2>
      <p className="muted">
        По умолчанию ассистент не видит ни ваших файлов, ни программ. Всё, что вы здесь разрешите, он сможет использовать, но любое изменение файла,
        запуск программы и действие в браузере каждый раз требуют вашего подтверждения. Удаление — только в Корзину.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      <h3>Папки</h3>
      {acc?.folders.length ? (
        <ul className="list">
          {acc.folders.map((f) => (
            <li key={f} className="list-item">
              <code>{f}</code>
              <button className="btn btn-small" onClick={() => void act(() => window.jarvis.computer.removeFolder(f), 'Папка убрана')}>
                Убрать
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Папок нет — ассистент не может работать с файлами.</p>
      )}
      <button className="btn" onClick={() => void act(() => window.jarvis.computer.addFolder(), 'Папка добавлена')}>
        + Добавить папку…
      </button>
      <p className="muted small">
        Выбирайте отдельную рабочую папку (например, «Документы\Джарвис»). Системные папки, корень диска, вся папка пользователя и AppData запрещены. Файлы
        с паролями и ключами (.env, .ssh, *.pem…) ассистенту недоступны даже внутри разрешённой папки.
      </p>

      <h3>Программы</h3>
      <ul className="list">
        {acc?.apps.map((a) => (
          <li key={a.path} className="list-item">
            <span>
              {a.name} <span className="muted small">{a.builtin ? '(встроенная)' : a.path}</span>
            </span>
            {!a.builtin && (
              <button className="btn btn-small" onClick={() => void act(() => window.jarvis.computer.removeApp(a.name), 'Программа убрана')}>
                Убрать
              </button>
            )}
          </li>
        ))}
      </ul>
      <button className="btn" onClick={() => void act(() => window.jarvis.computer.addApp(), 'Программа добавлена')}>
        + Добавить программу…
      </button>

      <h3>Внутренние адреса для браузера</h3>
      <p className="muted small">
        Браузер ассистента открывает только публичные сайты. Адреса вашего компьютера и локальной сети (например, тестовая CRM <code>localhost:5173</code>)
        закрыты, пока вы не добавите их сюда.
      </p>
      {acc?.browserHosts.map((h) => (
        <div key={h} className="row">
          <code>{h}</code>
          <button className="btn btn-small" onClick={() => void act(() => window.jarvis.computer.removeBrowserHost(h), 'Адрес убран')}>
            Убрать
          </button>
        </div>
      ))}
      <div className="row">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost:5173" spellCheck={false} />
        <button
          className="btn"
          disabled={!host.trim()}
          onClick={() =>
            void act(async () => {
              const r = await window.jarvis.computer.addBrowserHost(host);
              setHost('');
              return r;
            }, 'Адрес добавлен')
          }
        >
          Добавить
        </button>
      </div>
    </div>
  );
}
