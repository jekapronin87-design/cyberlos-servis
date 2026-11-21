import { useEffect, useState } from 'react';
import { stripUntrustedWrapper } from '../../shared/text';
import type { ChatMessage } from '../../shared/types';
import { prettyInput } from '../format';

function Attachment({ id }: { id: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.jarvis.attachments.get(id).then((a) => alive && a && setSrc(`data:${a.mime};base64,${a.base64}`));
    return () => {
      alive = false;
    };
  }, [id]);
  return src ? <img className="shot" src={src} alt="Снимок экрана, отправленный ассистенту" /> : <span className="muted small">загрузка снимка…</span>;
}

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
              <pre>{stripUntrustedWrapper(b.content)}</pre>
              {b.imageIds?.map((id) => <Attachment key={id} id={id} />)}
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
