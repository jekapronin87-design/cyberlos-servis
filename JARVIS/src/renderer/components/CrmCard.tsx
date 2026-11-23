import { useEffect, useState } from 'react';
import type { CrmStatusDto, CrmTestDto } from '../../shared/types';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function CrmCard() {
  const [st, setSt] = useState<CrmStatusDto | null>(null);
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState<'test' | 'production'>('test');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [mask, setMask] = useState(true);
  const [front, setFront] = useState('');
  const [test, setTest] = useState<CrmTestDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.jarvis.crm.get().then((s) => {
      setSt(s);
      setUrl(s.baseUrl);
      setEnv(s.environment);
      setEmail(s.email);
      setMask(s.maskPii);
      setFront(s.frontendUrl);
    });
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const s = await window.jarvis.crm.save({ baseUrl: url, environment: env, email, maskPii: mask, frontendUrl: front }, pw || undefined);
      setSt(s);
      setPw('');
      setMsg({ ok: true, text: `Сохранено${s.baseUrl && s.baseUrl !== url.trim().replace(/\/+$/, '') ? ` (адрес приведён к ${s.baseUrl}: ссылки-приглашения и страницы входа не нужны)` : ''}. Нажмите «Проверить подключение».` });
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="crm-card">
      <h2>CRM «Сайберлос»</h2>
      <p className="muted">
        Системно подключается к CRM <strong>только для чтения</strong>: он видит заявки, воронки, задачи, производство и склад, анализирует их и готовит отчёты, но изменить в CRM ничего не может — физически (программа умеет только входить и читать).
        Рекомендуется отдельная учётная запись с ролью «Джарвис (чтение)» — см. инструкцию в <code>docs/CRM.md</code>.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <label className="field">
        <span>Адрес CRM (тот, по которому вы заходите в неё в браузере)</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.ваш-домен.ru" spellCheck={false} />
        <small className="muted">Только адрес сайта, без ссылок из писем и страниц входа — например <code>https://crm.ваш-домен.ru</code>. Если сервер лежит отдельно (Railway и т. п.) — адрес сервера. Приписку «/api» и поддомен api. программа подберёт сама. Для проверки на своём компьютере: http://localhost:4000</small>
      </label>
      <label className="field">
        <span>Адрес сайта CRM (необязательно — для подсказок в уроках)</span>
        <input value={front} onChange={(e) => setFront(e.target.value)} placeholder="https://crm.ваш-домен.ru" spellCheck={false} />
        <small className="muted">Куда открывать браузер, чтобы подсветить кнопки в учебных заданиях. Если это адрес вашего компьютера или локальной сети, добавьте его ниже в «Внутренние адреса для браузера».</small>
      </label>
      <label className="field">
        <span>Окружение</span>
        <select value={env} onChange={(e) => setEnv(e.target.value as 'test' | 'production')}>
          <option value="test">Тестовое (учебные данные) — рекомендуется для начала</option>
          <option value="production">Рабочее (реальные данные, только чтение)</option>
        </select>
      </label>
      <div className="row">
        <label className="field grow">
          <span>Логин (email) учётной записи</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jarvis@ваш-домен.ru" spellCheck={false} autoComplete="off" />
        </label>
        <label className="field grow">
          <span>Пароль {st?.hasPassword && <em className="ok">· задан</em>}</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={st?.hasPassword ? '•••••••• (введите, чтобы заменить)' : ''} autoComplete="off" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} />
        <span>Маскировать персональные данные клиентов (телефоны, почта, фамилии) в том, что получает ИИ — <strong>рекомендуется</strong></span>
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !url || !email} onClick={() => void save()}>
          Сохранить
        </button>
        <button
          className="btn"
          disabled={busy || !st?.configured}
          onClick={async () => {
            setBusy(true);
            setTest(await window.jarvis.crm.test());
            setBusy(false);
          }}
        >
          Проверить подключение
        </button>
        <button
          className="btn"
          disabled={busy || !st?.configured}
          onClick={async () => {
            if (!window.confirm('Отключить CRM и удалить сохранённый пароль?')) return;
            setSt(await window.jarvis.crm.disconnect());
            setUrl('');
            setEmail('');
            setTest(null);
          }}
        >
          Отключить
        </button>
      </div>
      {test && (
        <div className={`banner ${test.ok && test.readOnlySafe ? 'banner-ok' : test.ok ? 'banner-demo' : 'banner-err'}`} style={{ marginTop: 12 }}>
          {!test.ok && <>Не удалось подключиться: {test.error}</>}
          {test.ok && (
            <>
              <strong>Подключено.</strong> Вошли как {test.user?.email} ({test.user?.roleName ?? test.user?.role}).
              {test.readOnlySafe ? ' Учётная запись подходит для режима «только чтение».' : ''}
              {test.writeLike.length > 0 && (
                <div>
                  ⚠ У этой учётной записи есть права на изменение данных в CRM: <code>{test.writeLike.join(', ')}</code>. Системно всё равно только читает, но безопаснее создать отдельную роль «Джарвис (чтение)» без этих прав (docs/CRM.md).
                </div>
              )}
              {test.missingRead.length > 0 && (
                <div>
                  Не хватает прав на чтение: <code>{test.missingRead.join(', ')}</code> — эти разделы будут недоступны в анализе.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
