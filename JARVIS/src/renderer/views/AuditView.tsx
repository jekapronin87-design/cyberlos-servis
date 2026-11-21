import { useEffect, useState } from 'react';
import type { AuditEntry } from '../../shared/types';
import { RISK_LABEL, formatTime } from '../format';

const DECISION: Record<AuditEntry['decision'], string> = {
  allowed: 'разрешено',
  confirmed: 'подтверждено',
  denied: 'запрещено',
  rejected: 'отклонено',
  error: 'ошибка',
  info: 'событие',
};

export function AuditView() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<string>('');

  const load = (): void => {
    void window.jarvis.audit.list(300).then(setRows);
  };
  useEffect(load, []);

  return (
    <section className="page">
      <h1>Журнал действий</h1>
      <p className="muted">Все важные действия ассистента и ваши решения. Записи нельзя изменить или удалить из приложения; цепочка хешей выявляет подмену.</p>
      <div className="row">
        <button className="btn" onClick={load}>
          Обновить
        </button>
        <button
          className="btn"
          onClick={async () => {
            const r = await window.jarvis.audit.verify();
            setVerify(r.ok ? `Целостность подтверждена (${r.checked} записей)` : `НАРУШЕНИЕ целостности в записи #${r.brokenAtId}`);
          }}
        >
          Проверить целостность
        </button>
        {verify && <span className={verify.startsWith('НАРУШ') ? 'err' : 'ok'}>{verify}</span>}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Время</th>
              <th>Кто</th>
              <th>Действие</th>
              <th>Объект</th>
              <th>Риск</th>
              <th>Решение</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} title={r.details ? JSON.stringify(r.details) : undefined}>
                <td>{formatTime(r.ts)}</td>
                <td>{r.actor}</td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td>{r.target ?? ''}</td>
                <td>{r.risk ? <span className={`risk risk-${r.risk}`}>{RISK_LABEL[r.risk]}</span> : ''}</td>
                <td className={`dec-${r.decision}`}>{DECISION[r.decision]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
