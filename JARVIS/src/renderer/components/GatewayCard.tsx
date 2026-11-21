import { useCallback, useEffect, useState } from 'react';
import type { GatewayDeviceDto, GatewayStatusDto, Settings } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function GatewayCard({ settings, onUpdate }: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [st, setSt] = useState<GatewayStatusDto | null>(null);
  const [devices, setDevices] = useState<GatewayDeviceDto[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSt(await window.jarvis.gateway.status());
      setDevices(await window.jarvis.gateway.devices());
    } catch (e) {
      setErr(clean(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, settings.gatewayMode]);

  // Телефон может подключиться, пока открыто окно: список обновляется сам.
  useEffect(() => {
    const t = setInterval(() => void window.jarvis.gateway.devices().then(setDevices).catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, []);

  // Изменение режима запускает/останавливает сервер асинхронно — перечитываем статус чуть позже.
  const setMode = async (mode: Settings['gatewayMode']): Promise<void> => {
    setErr('');
    setCode(null);
    try {
      await onUpdate({ gatewayMode: mode });
      setTimeout(() => void refresh(), 400);
    } catch (e) {
      setErr(clean(e));
    }
  };

  const showCode = async (): Promise<void> => {
    setErr('');
    try {
      setCode(await window.jarvis.gateway.pairCode());
    } catch (e) {
      setErr(clean(e));
    }
  };

  const active = devices.filter((d) => !d.revoked);

  return (
    <div className="card" id="gateway-card">
      <h2>Доступ с телефона</h2>
      <p className="muted small">
        Телефон открывает страницу JARVIS по адресу в вашей домашней сети Wi‑Fi и пишет ему как в обычном чате. Наружу (в интернет) ничего не открывается. Подключение — по одноразовому коду, который показывается только здесь.
      </p>
      {err && <div className="banner banner-err">{err}</div>}
      <label className="field">
        <span>Режим</span>
        <select id="gateway-mode" value={settings.gatewayMode} onChange={(e) => void setMode(e.target.value as Settings['gatewayMode'])}>
          <option value="off">выключено (рекомендуется, пока не нужно)</option>
          <option value="lan">по домашней сети Wi‑Fi</option>
          <option value="localhost">только на этом компьютере (проверка)</option>
        </select>
      </label>
      {st?.error && <div className="banner banner-err">{st.error}</div>}
      {st?.running && (
        <>
          <p>
            Адрес для телефона:{' '}
            {st.urls.length > 0 ? st.urls.map((u) => <code key={u} className="gw-url">{u}</code>) : <span className="muted">не найден адрес сети Wi‑Fi</span>}
          </p>
          <div className="row">
            <button id="gateway-code-btn" className="btn" onClick={() => void showCode()}>Показать код подключения</button>
            <button className="btn" onClick={() => void refresh()}>Обновить</button>
          </div>
          {code && (
            <p>
              Введите на телефоне код: <strong id="gateway-code" style={{ fontSize: 28, letterSpacing: '0.3em' }}>{code.code}</strong>
              <span className="muted small"> — действует 5 минут, один раз</span>
            </p>
          )}
          <label className="check">
            <input type="checkbox" checked={settings.gatewayAllowActions} onChange={(e) => void onUpdate({ gatewayAllowActions: e.target.checked })} />
            <span>
              <strong>Разрешить телефону просить действия</strong>{' '}
              <span className="muted small">
                — запрос подтверждения всё равно появится на компьютере, и действие выполнится только после вашего «Разрешить». Действия высокого риска с телефона запрещены всегда. Без этой галочки с телефона — только вопросы и анализ.
              </span>
            </span>
          </label>
        </>
      )}
      <h3>Подключённые телефоны</h3>
      {active.length === 0 ? (
        <p className="muted small">Пока нет.</p>
      ) : (
        <ul className="plain">
          {active.map((d) => (
            <li key={d.id} className="row">
              <span>
                <strong>{d.name}</strong> <span className="muted small">— подключён {formatTime(d.createdAt)}{d.lastSeenAt ? `, был ${formatTime(d.lastSeenAt)}` : ''}</span>
              </span>
              <button className="btn btn-danger" onClick={() => window.confirm(`Отключить «${d.name}»?`) && void window.jarvis.gateway.revoke(d.id).then(setDevices)}>
                Отключить
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
