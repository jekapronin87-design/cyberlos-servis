import { useEffect, useState } from 'react';
import type { CrmDashboardDto } from '../../shared/types';
import { formatTime } from '../format';

const KIND: Record<string, string> = {
  missing_required_field: 'Не заполнены обязательные поля',
  no_next_action: 'Нет следующего действия',
  no_assignee: 'Нет ответственного',
  stuck: 'Простой дольше SLA',
  lost_without_reason: 'Отказ без причины',
  status_stage_mismatch: 'Статус не соответствует стадии',
  lead_without_contact: 'Нет контактов',
  production_unpaid_in_work: 'Производство без предоплаты',
  production_overdue: 'Просрочен срок производства',
};

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function CrmView(props: { onAsk: (text: string) => void; onOpenSettings: () => void }) {
  const [d, setD] = useState<CrmDashboardDto | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      setD(await window.jarvis.crm.dashboard());
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const o = d?.overview;
  const tile = (label: string, value: number | string, bad = false) => (
    <div className={`tile ${bad && Number(value) > 0 ? 'tile-bad' : ''}`} key={label}>
      <div className="tile-v">{value}</div>
      <div className="tile-l">{label}</div>
    </div>
  );

  return (
    <section className="page" style={{ maxWidth: 1100 }}>
      <h1>CRM «Сайберлос»</h1>
      <p className="muted">Срез данных в режиме «только чтение». {d && <>Обновлено {formatTime(d.at)}.</>}</p>
      <div className="row">
        <button className="btn" onClick={() => void load()} disabled={busy}>
          {busy ? 'Загружаю…' : 'Обновить'}
        </button>
        <button className="btn btn-primary" onClick={() => props.onAsk('Сделай утреннюю сводку по CRM: что важно, где узкие места, кому нужна помощь, и предложи 3 конкретных улучшения.')}>
          Спросить Джарвиса: сводка и выводы
        </button>
        <button className="btn" onClick={() => props.onAsk('Покажи, каким сотрудникам нужно дополнительное обучение работе с CRM и по каким темам.')}>
          Кому нужно обучение
        </button>
      </div>
      {err && (
        <div className="banner banner-err" style={{ marginTop: 12 }}>
          {err} <button className="link" onClick={props.onOpenSettings}>Настройки CRM</button>
        </div>
      )}
      {d && d.missing.length > 0 && <div className="banner banner-demo">Нет доступа к разделам: {d.missing.join(', ')} — добавьте учётной записи JARVIS права «просмотр».</div>}
      {o && (
        <>
          <div className="tiles">
            {tile('Новых за 24 ч', o.newLast24h)}
            {tile('Без ответственного', o.unassignedOpen, true)}
            {tile('Просрочено по SLA', o.stuck, true)}
            {tile('Задач просрочено', o.tasksOverdue, true)}
            {tile('Производство просрочено', o.productionOverdue, true)}
            {tile('Ждут предоплаты', o.awaitingPrepayment, true)}
            {tile('Склад на исходе', o.lowStock, true)}
          </div>
          <div className="card">
            <h2>Воронки</h2>
            {o.pipelines.map((p) => (
              <div key={p.slug} style={{ marginBottom: 12 }}>
                <strong>{p.name}</strong> <span className="muted small">открыто {p.open} · выиграно {p.won} · отказов {p.lost}</span>
                <div className="row" style={{ marginTop: 6 }}>
                  {p.byStage.map((s) => (
                    <span key={s.name} className={`tag ${s.breaches ? 'tag-bad' : ''}`}>
                      {s.name}: {s.open}
                      {s.breaches ? ` (⚠ ${s.breaches})` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="card">
            <h2>Менеджеры</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>Роль</th>
                    <th>Сделок</th>
                    <th>Просрочено</th>
                    <th>Задач</th>
                    <th>Просрочено</th>
                    <th>В срок / с опозданием</th>
                  </tr>
                </thead>
                <tbody>
                  {d!.managers.map((m) => (
                    <tr key={m.name}>
                      <td>{m.name}</td>
                      <td>{m.role}</td>
                      <td>{m.openDeals}</td>
                      <td className={m.stuckDeals ? 'dec-denied' : ''}>{m.stuckDeals}</td>
                      <td>{m.tasksOpen}</td>
                      <td className={m.tasksOverdue ? 'dec-denied' : ''}>{m.tasksOverdue}</td>
                      <td>
                        {m.doneOnTime} / {m.doneLate}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h2>Замечания по работе с CRM ({d!.issues.length})</h2>
            <p className="muted small">Это не оценка людей, а повод предложить обучение: наставник объяснит ошибку и даст задание.</p>
            <ul className="list">
              {d!.issues.slice(0, 40).map((i, idx) => (
                <li key={idx} className="list-item">
                  <div>
                    <span className="tag">{KIND[i.kind] ?? i.kind}</span> {i.title}
                    <div className="muted small">
                      {i.pipeline} / {i.stage} · {i.who.join(', ') || 'без ответственного'} · {i.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h2>Кому нужно обучение</h2>
            {d!.needs.length === 0 && <p className="muted">Ошибок не найдено.</p>}
            {d!.needs.map((n) => (
              <div key={n.employee} style={{ marginBottom: 10 }}>
                <strong>{n.employee}</strong> <span className="muted small">— замечаний: {n.total}</span>
                <ul className="small">
                  {n.topics.map((t) => (
                    <li key={t.kind}>
                      {t.topic} ({t.count})
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
