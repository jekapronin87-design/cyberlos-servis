import { useEffect, useState } from 'react';
import type { UpdateProgress, UpdateStatus } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function UpdateCard({ branch, onBranch }: { branch: string; onBranch: (b: string) => Promise<void> }) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<UpdateProgress[]>([]);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [br, setBr] = useState(branch);

  useEffect(() => window.jarvis.update.onProgress((p) => setLog((l) => [...l, p])), []);

  const check = async (): Promise<void> => {
    setErr('');
    setBusy(true);
    try {
      setSt(await window.jarvis.update.check());
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!window.confirm('Скачать и установить обновление Системно?\n\nФайлы приложения будут заменены новыми (ваши данные, ключи и история не затрагиваются). После установки нужно перезапустить программу.')) return;
    setErr('');
    setLog([]);
    setBusy(true);
    try {
      await window.jarvis.update.apply();
      setDone(true);
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="update-card">
      <h2>Обновление Системно</h2>
      <p className="muted">Новые возможности ставятся одной кнопкой — скачивать архивы и заменять папки больше не нужно.</p>
      {err && <div className="banner banner-err">{err}</div>}
      {st && !st.canUpdate && <div className="banner banner-demo">{st.reason}</div>}
      {st?.canUpdate && st.latest && (
        <dl className="kv">
          <dt>Установлено</dt>
          <dd>{st.installedSha ? st.installedSha.slice(0, 7) : 'неизвестно (до первого обновления кнопкой)'}</dd>
          <dt>Последняя</dt>
          <dd>
            {st.latest.sha.slice(0, 7)} · {st.latest.message} · {st.latest.date ? formatTime(st.latest.date) : ''}
          </dd>
          <dt>Состояние</dt>
          <dd className={st.upToDate ? 'ok' : ''}>{st.upToDate === true ? 'у вас последняя версия' : st.upToDate === false ? 'есть обновление' : 'можно обновить'}</dd>
        </dl>
      )}
      <div className="row">
        <button className="btn" onClick={() => void check()} disabled={busy}>
          Проверить обновления
        </button>
        {st?.canUpdate && st.upToDate !== true && !done && (
          <button className="btn btn-primary" onClick={() => void apply()} disabled={busy}>
            Обновить сейчас
          </button>
        )}
        {done && (
          <button className="btn btn-primary" onClick={() => void window.jarvis.update.restart()}>
            Перезапустить Системно
          </button>
        )}
      </div>
      {log.length > 0 && (
        <ul className="muted small">
          {log.map((p, i) => (
            <li key={i} className={p.step === 'error' ? 'err' : p.step === 'done' ? 'ok' : ''}>
              {p.message}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary className="muted small">Дополнительно</summary>
        <label className="field">
          <span>Ветка GitHub с обновлениями</span>
          <div className="row">
            <input value={br} onChange={(e) => setBr(e.target.value)} spellCheck={false} />
            <button className="btn" disabled={br === branch} onClick={() => void onBranch(br)}>
              Сохранить
            </button>
          </div>
        </label>
      </details>
    </div>
  );
}
