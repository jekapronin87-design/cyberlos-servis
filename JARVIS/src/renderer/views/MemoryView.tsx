import { useState } from 'react';
import type { MemoryItem, MemoryKind } from '../../shared/types';
import { formatTime } from '../format';

const KINDS: { value: MemoryKind; label: string }[] = [
  { value: 'preference', label: 'Предпочтение' },
  { value: 'project', label: 'Проект' },
  { value: 'task', label: 'Задача' },
  { value: 'fact', label: 'Факт' },
];
const label = (k: MemoryKind): string => KINDS.find((x) => x.value === k)?.label ?? k;

export function MemoryView(props: {
  items: MemoryItem[];
  onAdd: (kind: MemoryKind, content: string) => Promise<void>;
  onRemove: (id: number) => Promise<void>;
}) {
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  return (
    <section className="page">
      <h1>Память</h1>
      <p className="muted">Что Системно помнит о вас. Вы можете добавлять и удалять записи; ассистент тоже может сохранять их по вашей просьбе.</p>
      <form
        className="card row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await props.onAdd(kind, content);
            setContent('');
            setError('');
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Ошибка');
          }
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Тип записи">
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Что запомнить…" maxLength={1000} />
        <button className="btn btn-primary" disabled={!content.trim()}>
          Добавить
        </button>
      </form>
      {error && <div className="banner banner-err">{error}</div>}
      {props.items.length === 0 ? (
        <p className="muted">Память пуста.</p>
      ) : (
        <ul className="list">
          {props.items.map((m) => (
            <li key={m.id} className="list-item">
              <div>
                <span className="tag">{label(m.kind)}</span> {m.content}
                <div className="muted small">
                  #{m.id} · {m.source === 'user' ? 'вы' : 'ассистент'} · {formatTime(m.createdAt)}
                </div>
              </div>
              <button className="btn btn-small" onClick={() => props.onRemove(m.id)} aria-label={`Удалить запись ${m.id}`}>
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
