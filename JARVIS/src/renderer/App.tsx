import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, ChatMessage, ConfirmRequest, Conversation, MemoryItem, MemoryKind, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import { AuditView } from './views/AuditView';
import { ChatView } from './views/ChatView';
import { MemoryView } from './views/MemoryView';
import { SettingsView } from './views/SettingsView';
import { cancelSpeech, speak } from './voice/speech';
import { useVoice } from './voice/useVoice';
import { textForSpeech } from '../shared/voice';

type View = 'chat' | 'memory' | 'audit' | 'settings';

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Неизвестная ошибка';

function applyTheme(theme: Settings['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function App() {
  const [view, setView] = useState<View>('chat');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState('');
  const [running, setRunning] = useState(false);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [confirms, setConfirms] = useState<ConfirmRequest[]>([]);
  const [error, setError] = useState('');
  const activeRef = useRef<number | null>(null);
  activeRef.current = activeId;
  const runningRef = useRef(false);
  runningRef.current = running;
  const speakNext = useRef(false);
  const lastReply = useRef('');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshConvs = useCallback(async () => setConvs(await window.jarvis.conversations.list()), []);
  const refreshInfo = useCallback(async () => setInfo(await window.jarvis.app.info()), []);
  const refreshMemory = useCallback(async () => setMemory(await window.jarvis.memory.list()), []);

  // Начальная загрузка
  useEffect(() => {
    void (async () => {
      const [s, list] = await Promise.all([window.jarvis.settings.get(), window.jarvis.conversations.list()]);
      setSettings(s);
      setConvs(list);
      await Promise.all([refreshInfo(), refreshMemory()]);
      if (list[0]) {
        setActiveId(list[0].id);
        setMessages(await window.jarvis.conversations.messages(list[0].id));
      }
    })().catch((e) => setError(cleanError(e)));
  }, [refreshInfo, refreshMemory]);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  // События main -> renderer
  useEffect(() => {
    const offChat = window.jarvis.chat.onEvent((e) => {
      if (e.type === 'run_started') {
        setRunning(true);
        setError('');
        lastReply.current = '';
      } else if (e.type === 'delta') {
        if (e.conversationId === activeRef.current) setStreaming((s) => s + e.text);
      } else if (e.type === 'message') {
        const m = e.message;
        if (m.conversationId === activeRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          if (m.role === 'assistant') setStreaming('');
        }
        if (m.role === 'assistant') {
          const t = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
          if (t.trim()) lastReply.current = t;
        }
        if (m.role === 'tool') void refreshMemory();
      } else if (e.type === 'run_finished') {
        setRunning(false);
        setStreaming('');
        if (e.status === 'error' && e.error) setError(e.error);
        // Отвечаем голосом только на команды, отданные голосом, и только если ответ завершён нормально.
        if (speakNext.current && e.status === 'done' && lastReply.current) {
          const mode = settingsRef.current.ttsMode;
          void speak(textForSpeech(lastReply.current), mode).catch((err) => setError(cleanError(err)));
        }
        speakNext.current = false;
        void refreshConvs();
        void refreshMemory();
      }
    });
    const offReq = window.jarvis.confirm.onRequest((r) => setConfirms((q) => [...q, r]));
    const offClosed = window.jarvis.confirm.onClosed((id) => setConfirms((q) => q.filter((r) => r.id !== id)));
    return () => {
      offChat();
      offReq();
      offClosed();
    };
  }, [refreshConvs, refreshMemory]);

  const openConversation = async (id: number): Promise<void> => {
    setActiveId(id);
    setStreaming('');
    setMessages(await window.jarvis.conversations.messages(id));
    setView('chat');
  };

  const newConversation = async (): Promise<void> => {
    const c = await window.jarvis.conversations.create();
    await refreshConvs();
    await openConversation(c.id);
  };

  const send = async (text: string): Promise<void> => {
    try {
      let id = activeId;
      if (id === null) {
        const c = await window.jarvis.conversations.create();
        id = c.id;
        setActiveId(id);
        activeRef.current = id;
        await refreshConvs();
      }
      await window.jarvis.chat.send(id, text);
    } catch (e) {
      setError(cleanError(e));
    }
  };

  const removeConversation = async (id: number): Promise<void> => {
    if (!window.confirm('Удалить диалог вместе с историей?')) return;
    await window.jarvis.conversations.remove(id);
    const list = await window.jarvis.conversations.list();
    setConvs(list);
    if (id === activeId) {
      if (list[0]) await openConversation(list[0].id);
      else {
        setActiveId(null);
        setMessages([]);
      }
    }
  };

  const stop = useCallback((): void => {
    cancelSpeech();
    speakNext.current = false;
    void window.jarvis.chat.stop();
  }, []);

  const voice = useVoice({
    settings,
    isBusy: () => runningRef.current,
    onCommand: (text) => {
      speakNext.current = true;
      setView('chat');
      void send(text);
    },
    onStopCommand: stop,
    onError: setError,
    enableMic: async () => {
      if (!window.confirm('Включить микрофон?\n\nФразы, которые вы произносите, будут отправляться выбранному сервису распознавания речи. Микрофон слушает только пока вы включили кнопку «Микрофон», и после запуска приложения всегда выключен.')) return false;
      setSettings(await window.jarvis.settings.update({ micEnabled: true }));
      return true;
    },
  });

  const answer = useCallback((id: string, approve: boolean): void => {
    setConfirms((q) => q.filter((r) => r.id !== id));
    void window.jarvis.confirm.respond(id, approve);
  }, []);

  const current = confirms[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          JARVIS
        </div>
        <button className="btn btn-primary full" onClick={() => void newConversation()}>
          + Новый диалог
        </button>
        <nav className="nav" aria-label="Разделы">
          {(
            [
              ['chat', 'Чат'],
              ['memory', 'Память'],
              ['audit', 'Журнал'],
              ['settings', 'Настройки'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={`nav-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)} aria-current={view === v ? 'page' : undefined}>
              {label}
            </button>
          ))}
        </nav>
        <div className="conv-title muted small">Диалоги</div>
        <ul className="convs">
          {convs.map((c) => (
            <li key={c.id} className={c.id === activeId && view === 'chat' ? 'active' : ''}>
              <button className="conv-open" onClick={() => void openConversation(c.id)} title={c.title}>
                {c.title}
              </button>
              <button className="conv-del" onClick={() => void removeConversation(c.id)} aria-label={`Удалить диалог «${c.title}»`}>
                ×
              </button>
            </li>
          ))}
          {convs.length === 0 && <li className="muted small pad">Пока пусто</li>}
        </ul>
        {voice.state !== 'idle' && (
          <div className="mic-live" role="status">
            <span className="mic-live-dot" /> Микрофон включён
            <button className="link" onClick={voice.stop}>
              выкл.
            </button>
          </div>
        )}
        <div className={`status ${info?.mode === 'live' ? 'status-live' : 'status-demo'}`}>
          <span className="dot" /> {info ? (info.mode === 'live' ? `Claude · ${info.model}` : 'Демо-режим') : '…'}
          <div className="muted small">v{info?.version}</div>
        </div>
      </aside>

      <main className="main">
        {error && (
          <div className="banner banner-err" role="alert">
            {error}
            <button className="link" onClick={() => setError('')}>
              Закрыть
            </button>
          </div>
        )}
        {view === 'chat' && (
          <ChatView info={info} messages={messages} streaming={streaming} running={running} hasConversation={activeId !== null} onSend={(t) => void send(t)} onStop={stop} voice={voice} />
        )}
        {view === 'memory' && (
          <MemoryView
            items={memory}
            onAdd={async (k: MemoryKind, c: string) => {
              await window.jarvis.memory.add(k, c);
              await refreshMemory();
            }}
            onRemove={async (id) => {
              await window.jarvis.memory.remove(id);
              await refreshMemory();
            }}
          />
        )}
        {view === 'audit' && <AuditView />}
        {view === 'settings' && (
          <SettingsView
            settings={settings}
            info={info}
            onUpdate={async (patch) => {
              setSettings(await window.jarvis.settings.update(patch));
              await refreshInfo();
            }}
            onSetVoiceKey={async (k) => {
              await window.jarvis.voice.setKey(k);
              await refreshInfo();
            }}
            onClearVoiceKey={async () => {
              await window.jarvis.voice.clearKey();
              await refreshInfo();
            }}
            onSetKey={async (k) => {
              await window.jarvis.secrets.setApiKey(k);
              await refreshInfo();
            }}
            onClearKey={async () => {
              await window.jarvis.secrets.clearApiKey();
              await refreshInfo();
            }}
          />
        )}
      </main>

      {current && <ConfirmDialog req={current} onAnswer={(a) => answer(current.id, a)} onStop={stop} />}
    </div>
  );
}
