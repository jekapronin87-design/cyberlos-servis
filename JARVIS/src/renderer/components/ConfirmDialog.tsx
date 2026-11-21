import { useEffect, useRef } from 'react';
import type { ConfirmRequest } from '../../shared/types';
import { RISK_LABEL, prettyInput } from '../format';

export function ConfirmDialog({ req, onAnswer, onStop }: { req: ConfirmRequest; onAnswer: (approve: boolean) => void; onStop: () => void }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  // Фокус по умолчанию на «Отклонить», Esc = отказ: случайное нажатие Enter ничего не разрешит.
  useEffect(() => {
    denyRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onAnswer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.id, onAnswer]);

  return (
    <div className="overlay" role="presentation">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">Подтвердите действие</h2>
        <p className="dialog-desc">{req.description}</p>
        <div className="dialog-meta">
          <span className={`risk risk-${req.risk}`}>{RISK_LABEL[req.risk]}</span>
          <span className="muted">{req.reason}</span>
        </div>
        <div className="muted small">
          Инструмент: <code>{req.toolName}</code>
          {prettyInput(req.input) && <code className="block">{prettyInput(req.input)}</code>}
        </div>
        <div className="dialog-actions">
          <button className="btn link-btn" onClick={onStop} title="Прервать всю задачу, а не только это действие">
            Остановить задачу
          </button>
          <button ref={denyRef} className="btn" onClick={() => onAnswer(false)}>
            Отклонить
          </button>
          <button className="btn btn-danger" onClick={() => onAnswer(true)}>
            Разрешить
          </button>
        </div>
      </div>
    </div>
  );
}
