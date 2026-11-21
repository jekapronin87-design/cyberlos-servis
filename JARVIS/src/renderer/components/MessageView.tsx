import type { ChatMessage } from '../../shared/types';
import { prettyInput } from '../format';

export function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return (
      <>
        {message.content.map((b, i) =>
          b.type === 'tool_result' ? (
            <div key={i} className={`tool-card ${b.denied ? 'tool-denied' : b.isError ? 'tool-error' : ''}`}>
              <div className="tool-head">
                <span>{b.denied ? 'Отклонено' : b.isError ? 'Ошибка' : 'Результат'}</span>
                <code>{b.name}</code>
              </div>
              <pre>{b.content}</pre>
            </div>
          ) : null,
        )}
      </>
    );
  }
  const texts = message.content.filter((b) => b.type === 'text');
  const uses = message.content.filter((b) => b.type === 'tool_use');
  return (
    <>
      {texts.length > 0 && (
        <div className={`bubble bubble-${message.role}`}>
          {texts.map((b, i) => (b.type === 'text' ? <p key={i}>{b.text}</p> : null))}
        </div>
      )}
      {uses.map((b, i) =>
        b.type === 'tool_use' ? (
          <div key={i} className="tool-card">
            <div className="tool-head">
              <span>Вызов инструмента</span>
              <code>{b.name}</code>
            </div>
            {prettyInput(b.input) && <pre>{prettyInput(b.input)}</pre>}
          </div>
        ) : null,
      )}
    </>
  );
}
