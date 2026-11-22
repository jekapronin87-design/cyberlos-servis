import { useCallback, useEffect, useState } from 'react';
import type { Settings, YoutubeStatusDto } from '../../shared/types';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function YoutubeCard({ settings, onUpdate }: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [st, setSt] = useState<YoutubeStatusDto | null>(null);
  const [key, setKey] = useState('');
  const [limit, setLimit] = useState(settings.youtubeDailyUnits);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await window.jarvis.youtube.status());
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="youtube-card">
      <h2>YouTube</h2>
      <p className="muted small">
        Ассистент и агенты смогут искать видео и каналы, смотреть статистику (просмотры, лайки, подписчики) и читать комментарии — <strong>только чтение</strong>, по вашему бесплатному ключу Google. Публиковать видео, менять канал и отвечать на комментарии он не умеет.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      {!st?.hasKey && (
        <ol className="muted small">
          <li>Откройте <code>console.cloud.google.com</code>, войдите в Google и создайте проект (кнопка вверху → «Новый проект»).</li>
          <li>Меню → «API и сервисы» → «Библиотека» → найдите <strong>YouTube Data API v3</strong> → «Включить».</li>
          <li>«API и сервисы» → «Учётные данные» → «Создать учётные данные» → <strong>Ключ API</strong>. Скопируйте его сюда.</li>
        </ol>
      )}
      <div className="row">
        <input id="yt-key" type="password" autoComplete="off" style={{ flex: 1 }} placeholder={st?.hasKey ? 'Ключ сохранён — вставьте новый, чтобы заменить' : 'Ключ API YouTube'} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn btn-primary" id="yt-save" disabled={busy || !key.trim()} onClick={() => void run(async () => { await window.jarvis.youtube.setKey(key); setKey(''); }, 'Ключ сохранён (хранится зашифрованным)')}>Сохранить ключ</button>
        {st?.hasKey && <button className="btn" disabled={busy} onClick={() => void run(async () => setMsg({ ok: true, text: await window.jarvis.youtube.test() }), 'Работает: ключ подошёл')}>Проверить</button>}
        {st?.hasKey && <button className="btn btn-danger" onClick={() => void run(() => window.jarvis.youtube.clearKey(), 'Ключ удалён')}>Удалить ключ</button>}
      </div>
      {st?.hasKey && (
        <>
          <p className="small" style={{ marginTop: 10 }}>
            Сегодня потрачено: <strong>{st.usedToday}</strong> из вашего лимита <strong>{st.limit}</strong> единиц (у Google бесплатно 10 000 в сутки; один поиск стоит ~100, остальное — по 1).
          </p>
          <label className="field">
            <span>Мой суточный лимит (единиц)</span>
            <div className="row">
              <input type="number" min={100} max={9500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ maxWidth: 160 }} />
              <button className="btn" disabled={limit === settings.youtubeDailyUnits} onClick={() => void run(() => onUpdate({ youtubeDailyUnits: limit }), 'Лимит сохранён')}>Сохранить</button>
            </div>
          </label>
        </>
      )}
    </div>
  );
}
