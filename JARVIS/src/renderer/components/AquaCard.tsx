import { useEffect, useState } from 'react';
import type { AquaStatusDto } from '../../shared/types';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function AquaCard() {
  const [st, setSt] = useState<AquaStatusDto | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [mask, setMask] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.jarvis.aqua.get().then((s) => {
      setSt(s);
      setUrl(s.baseUrl);
      setMask(s.maskPii);
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

  const save = (): Promise<void> =>
    run(async () => {
      const s = await window.jarvis.aqua.save({ baseUrl: url, maskPii: mask }, key || undefined);
      setSt(s);
      setUrl(s.baseUrl);
      setKey('');
      setMsg({ ok: true, text: 'Сохранено (ключ хранится зашифрованным). Нажмите «Проверить подключение».' });
    });

  return (
    <div className="card" id="aqua-card">
      <h2>CRM «Аквамастер» — по API-ключу</h2>
      <p className="muted small">
        Системно читает вашу CRM <strong>только на чтение</strong>: заявки, воронки, замеры, производство, сотрудников, задачи, «город» — всё, что вы откроете ключу. Записать, изменить или удалить что-то он не может: программа умеет только запросы на чтение, а CRM по этому ключу ничего другого и не разрешает.
      </p>
      {!st?.hasKey && (
        <ol className="muted small">
          <li>Откройте CRM → «Безопасность» → «API-ключи» → «Создать ключ» (назовите, например, «Системно»).</li>
          <li>Скопируйте ключ сразу — CRM показывает его один раз. Он начинается с <code>sro_</code>.</li>
          <li>Вставьте его ниже и нажмите «Сохранить», затем «Проверить подключение».</li>
        </ol>
      )}
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <label className="field">
        <span>Адрес CRM</span>
        <input id="aqua-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://crm.aquamaster-septiki.ru" spellCheck={false} />
        <small className="muted">Тот, по которому вы входите в CRM. Ключ отправляется только на этот адрес.</small>
      </label>
      <label className="field">
        <span>API-ключ {st?.hasKey && <em className="ok">· сохранён</em>}</span>
        <input id="aqua-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={st?.hasKey ? '•••••••• (вставьте новый, чтобы заменить)' : 'sro_…'} spellCheck={false} />
      </label>
      <label className="check">
        <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} />
        <span>Скрывать телефоны и почту клиентов в том, что получает ИИ — <strong>рекомендуется</strong></span>
      </label>
      <div className="row">
        <button className="btn btn-primary" id="aqua-save" disabled={busy || (!key.trim() && !st?.hasKey)} onClick={() => void save()}>
          Сохранить
        </button>
        <button
          className="btn"
          id="aqua-test"
          disabled={busy || !st?.hasKey}
          onClick={() => void run(async () => setMsg({ ok: true, text: await window.jarvis.aqua.test() }))}
        >
          Проверить подключение
        </button>
        <button
          className="btn btn-danger"
          disabled={busy || !st?.hasKey}
          onClick={() =>
            void run(async () => {
              if (!window.confirm('Удалить сохранённый ключ? Системно перестанет видеть CRM. (Сам ключ можно отозвать в CRM.)')) return;
              setSt(await window.jarvis.aqua.disconnect());
              setMsg({ ok: true, text: 'Ключ удалён.' });
            })
          }
        >
          Удалить ключ
        </button>
      </div>
    </div>
  );
}
