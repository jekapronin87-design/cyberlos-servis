import { useEffect, useRef, useState } from 'react';
import type { AppInfo, ChatMessage } from '../../shared/types';
import { MessageView } from '../components/MessageView';

const SUGGESTIONS = ['Привет, Джарвис', 'Который час?', 'Запомни: отвечай коротко и по делу', 'Что ты помнишь?'];

export function ChatView(props: {
  info: AppInfo | null;
  messages: ChatMessage[];
  streaming: string;
  running: boolean;
  hasConversation: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const empty = props.messages.length === 0 && !props.streaming;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [props.messages.length, props.streaming]);

  const submit = (value = text): void => {
    const v = value.trim();
    if (!v || props.running) return;
    props.onSend(v);
    setText('');
  };

  return (
    <section className="chat">
      {props.info?.mode === 'demo' && (
        <div className="banner banner-demo" role="status">
          Демо-режим: настоящая модель не подключена, ответы шаблонные. Введите API-ключ в «Настройках», чтобы включить ИИ.
        </div>
      )}
      <div className="messages" aria-live="polite">
        {empty && (
          <div className="welcome">
            <h1>Я Джарвис</h1>
            <p className="muted">Ваш персональный ИИ-ассистент. Пока я умею общаться, помнить ваши предпочтения и проекты.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {props.messages.map((m) => (
          <MessageView key={m.id} message={m} />
        ))}
        {props.streaming && (
          <div className="bubble bubble-assistant">
            <p>{props.streaming}</p>
          </div>
        )}
        {props.running && !props.streaming && <div className="typing muted">Джарвис думает…</div>}
        <div ref={bottom} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" className="btn btn-icon" disabled title="Голосовой ввод появится на этапе 2" aria-label="Микрофон (недоступен)">
          Микр.
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={props.hasConversation ? 'Напишите сообщение… (Enter — отправить, Shift+Enter — новая строка)' : 'Напишите сообщение, чтобы начать диалог…'}
          rows={2}
          maxLength={20000}
          aria-label="Сообщение"
        />
        {props.running ? (
          <button type="button" className="btn btn-danger" onClick={props.onStop}>
            Стоп
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
            Отправить
          </button>
        )}
      </form>
    </section>
  );
}
