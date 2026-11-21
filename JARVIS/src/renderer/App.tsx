import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, ChatMessage, ConfirmRequest, Conversation, MemoryItem, MemoryKind, Settings } from '../shared/types';
import { DEFAULT_SETTINGS, type ModuleId } from '../shared/types';
import { stripUntrustedWrapper } from '../shared/text';
import { ConfirmDialog } from './components/ConfirmDialog';
import { HudView, type ActivityItem } from './hud/HudView';
import { IconAudit, IconCalls, IconChat, IconCrm, IconHud, IconJobs, IconMentor, IconMemory, IconProfile, IconSettings } from './hud/Icons';
import type { OrbState } from './hud/Orb';
import { AuditView } from './views/AuditView';
import { ChatView } from './views/ChatView';
import { CrmView } from './views/CrmView';
import { JobsView } from './views/JobsView';
import { MentorView } from './views/MentorView';
import { CallsView } from './views/CallsView';
import { MemoryView } from './views/MemoryView';
import { ProfileView } from './views/ProfileView';
import { SettingsView } from './views/SettingsView';
import { cancelSpeech, getSpeechLevel, onSpeaking, SpeechSession } from './voice/speech';
import { useCamera } from './voice/useCamera';
import { useVoice } from './voice/useVoice';

type View = 'hud' | 'chat' | 'crm' | 'mentor' | 'calls' | 'jobs' | 'profile' | 'memory' | 'audit' | 'settings';

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Неизвестная ошибка';

function applyTheme(theme: Settings['theme']): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

const greeting = (name: string): string => {
  const h = new Date().getHours();
  const part = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  return `${part}${name ? ', ' + name : ''}. Все системы работают в штатном режиме.`;
};

const TOOL_LABEL: Record<string, string> = {
  get_datetime: 'Время', remember: 'Запоминаю', list_memory: 'Читаю память', forget_memory: 'Забываю',
  fs_list: 'Просматриваю папку', fs_list_allowed: 'Проверяю доступы', fs_read: 'Читаю файл', fs_write: 'Создаю файл', fs_overwrite: 'Перезаписываю файл',
  fs_search: 'Ищу файлы', fs_move: 'Переношу файл', fs_delete: 'Удаляю в Корзину', fs_mkdir: 'Создаю папку', fs_open: 'Открываю файл',
  app_open: 'Запускаю программу', browser_open: 'Открываю сайт', browser_read: 'Читаю страницу', browser_click: 'Нажимаю на странице', browser_type: 'Ввожу текст',
  screen_capture: 'Смотрю на экран', camera_look: 'Смотрю на вас', project_overview: 'Анализирую проект', code_search: 'Ищу в коде', code_edit: 'Правлю код',
  run_script: 'Запускаю проверки', npm_install: 'Устанавливаю зависимости', project_scaffold: 'Создаю проект', git_commit: 'Коммит', git_status: 'Git: статус',
  git_diff: 'Git: изменения', git_push: 'Отправляю в Git', delegate_task: 'Поручаю агенту',
};

export function App() {
  const [view, setView] = useState<View>('hud');
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
  const [userText, setUserText] = useState('');
  const [replyText, setReplyText] = useState('');
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [updateAvail, setUpdateAvail] = useState<string | null>(null);
  const [jobToast, setJobToast] = useState<{ title: string; summary: string; ok: boolean } | null>(null);
  const activeRef = useRef<number | null>(null);
  activeRef.current = activeId;
  const runningRef = useRef(false);
  runningRef.current = running;
  const session = useRef<SpeechSession | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const clearTimer = useRef<number | null>(null);

  const refreshConvs = useCallback(async () => setConvs(await window.jarvis.conversations.list()), []);
  const refreshInfo = useCallback(async () => setInfo(await window.jarvis.app.info()), []);
  const refreshMemory = useCallback(async () => setMemory(await window.jarvis.memory.list()), []);

  useEffect(() => onSpeaking(setSpeaking), []);

  // Результат задачи по расписанию: баннер и (если включено) озвучка
  useEffect(
    () =>
      window.jarvis.jobs.onResult((r) => {
        if (r.quiet) return;
        setJobToast({ title: r.job.title, summary: r.summary, ok: r.status === 'ok' });
        const st = settingsRef.current;
        if (r.job.speak && r.status === 'ok' && st.ttsMode !== 'off') {
          const s = new SpeechSession({ mode: st.ttsMode, systemVoice: st.systemVoice, speed: st.ttsSpeed, onError: setError });
          s.push(`${r.job.title}. ${r.summary}`);
          void s.end();
        }
      }),
    [],
  );

  // Тихая проверка обновлений при запуске: баннер только если точно известно, что версия устарела
  useEffect(() => {
    void window.jarvis.update
      .check()
      .then((u) => {
        if (u.canUpdate && u.upToDate === false && u.latest) setUpdateAvail(u.latest.message || u.latest.sha.slice(0, 7));
      })
      .catch(() => {});
  }, []);

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

  const showReply = useCallback((t: string) => {
    setReplyText(t);
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
  }, []);

  // События main -> renderer
  useEffect(() => {
    const offChat = window.jarvis.chat.onEvent((e) => {
      if (e.type === 'run_started') {
        setRunning(true);
        setError('');
        setReplyText('');
      } else if (e.type === 'delta') {
        if (e.conversationId === activeRef.current) setStreaming((s) => s + e.text);
        setReplyText((r) => (r + e.text).slice(-700));
        session.current?.push(e.text);
      } else if (e.type === 'message') {
        const m = e.message;
        if (m.conversationId === activeRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          if (m.role === 'assistant') setStreaming('');
        }
        if (m.role === 'assistant') {
          setReplyText('');
          const t = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
          if (t.trim()) showReply(t.trim().slice(-700));
          for (const b of m.content) {
            if (b.type === 'tool_use') setActivity((a) => [...a.slice(-5), { id: b.id, label: TOOL_LABEL[b.name] ?? b.name, status: 'run' as const }]);
          }
        }
        if (m.role === 'tool') {
          setActivity((a) =>
            a.map((it) => {
              const r = m.content.find((b) => b.type === 'tool_result' && b.toolUseId === it.id);
              return r && r.type === 'tool_result' ? { ...it, status: r.denied ? 'denied' : r.isError ? 'err' : 'ok' } : it;
            }),
          );
          void refreshMemory();
        }
        if (m.role === 'user') {
          const t = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
          setUserText(t);
        }
      } else if (e.type === 'run_finished') {
        setRunning(false);
        setStreaming('');
        if (e.status === 'error' && e.error) setError(e.error);
        void refreshConvs();
        void refreshMemory();
        // Озвучка: дочитываем остаток и после ответа даём поговорить дальше без слова «Джарвис»
        const s = session.current;
        session.current = null;
        if (s) {
          if (e.status === 'done') void s.end().then(() => followUpRef.current?.());
          else cancelSpeech();
        }
        // Подпись под шаром гаснет через некоторое время
        if (clearTimer.current) window.clearTimeout(clearTimer.current);
        clearTimer.current = window.setTimeout(() => {
          setUserText('');
          setReplyText('');
        }, 14000);
      }
    });
    const offReq = window.jarvis.confirm.onRequest((r) => setConfirms((q) => [...q, r]));
    const offClosed = window.jarvis.confirm.onClosed((id) => setConfirms((q) => q.filter((r) => r.id !== id)));
    return () => {
      offChat();
      offReq();
      offClosed();
    };
  }, [refreshConvs, refreshMemory, showReply]);

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
      setUserText(text);
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

  /** Отправить сообщение на главном экране; если озвучка включена — ответ прозвучит голосом. */
  const sendSpoken = async (text: string): Promise<void> => {
    const st = settingsRef.current;
    if (st.ttsMode !== 'off') session.current = new SpeechSession({ mode: st.ttsMode, systemVoice: st.systemVoice, speed: st.ttsSpeed, onError: setError });
    setView('hud');
    await send(text);
  };

  const stop = useCallback((): void => {
    cancelSpeech();
    session.current = null;
    void window.jarvis.chat.stop();
  }, []);

  const answer = useCallback((id: string, approve: boolean): void => {
    setConfirms((q) => q.filter((r) => r.id !== id));
    void window.jarvis.confirm.respond(id, approve);
  }, []);

  const enableDevice = useCallback(
    (what: 'mic' | 'cam') => async (): Promise<boolean> => {
      const text =
        what === 'mic'
          ? 'Включить микрофон?\n\nФразы, которые вы произносите, будут отправляться выбранному сервису распознавания речи. Микрофон слушает только пока вы включили кнопку «Микрофон».'
          : 'Включить камеру?\n\nДжарвис сможет смотреть на вас, когда вы об этом просите («Джарвис, что я сейчас делаю?»). Кадр отправляется ИИ только по запросу и хранится до перезапуска приложения. Пока камера включена, в окне виден индикатор и превью.';
      if (!window.confirm(text)) return false;
      setSettings(await window.jarvis.settings.update(what === 'mic' ? { micEnabled: true } : { cameraEnabled: true }));
      return true;
    },
    [],
  );

  const voice = useVoice({
    settings,
    isBusy: () => runningRef.current,
    onCommand: (text) => {
      // Голосовая команда: отвечаем голосом, по мере того как ответ генерируется
      const st = settingsRef.current;
      session.current = new SpeechSession({ mode: st.ttsMode, systemVoice: st.systemVoice, speed: st.ttsSpeed, onError: setError });
      setView((v) => (v === 'settings' || v === 'audit' || v === 'memory' ? 'hud' : v));
      void send(text);
    },
    onStopCommand: stop,
    onError: setError,
    enableMic: enableDevice('mic'),
  });
  const followUpRef = useRef<(() => void) | null>(null);
  followUpRef.current = voice.followUp;

  const camera = useCamera({ settings, enableCamera: enableDevice('cam'), onError: setError });

  // Автозапуск прослушивания и приветствие (только если пользователь явно включил это в настройках)
  const greeted = useRef(false);
  useEffect(() => {
    if (greeted.current || !info) return;
    greeted.current = true;
    if (settings.autoListen && settings.micEnabled && settings.voiceMode === 'wake' && info.hasVoiceKey) {
      voice.toggle();
      if (settings.ttsMode !== 'off') {
        const s = new SpeechSession({ mode: settings.ttsMode, systemVoice: settings.systemVoice, speed: settings.ttsSpeed, onError: setError });
        s.push(greeting(settings.userName));
        void s.end();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  // Состояние шара и его «громкость»
  const orbState: OrbState = speaking ? 'speaking' : running || voice.state === 'transcribing' ? 'thinking' : voice.state === 'listening' || voice.state === 'hearing' ? 'listening' : 'idle';
  const levelRef = useRef({ voiceLevel: 0, state: orbState });
  levelRef.current = { voiceLevel: voice.level, state: orbState };
  const getLevel = useCallback((): number => {
    const { voiceLevel, state } = levelRef.current;
    if (state === 'speaking') return getSpeechLevel();
    if (state === 'listening') return voiceLevel;
    if (state === 'thinking') return 0.12 + 0.08 * Math.sin(performance.now() / 260);
    return 0;
  }, []);

  const current = confirms[0];
  const off = settings.disabledModules;
  const navAll = [
    ['hud', 'Джарвис', <IconHud key="h" />],
    ['chat', 'Чат', <IconChat key="c" />],
    ['crm', 'CRM', <IconCrm key="r" />],
    ['mentor', 'Наставник', <IconMentor key="n" />],
    ['calls', 'Звонки', <IconCalls key="t" />],
    ['jobs', 'Задачи', <IconJobs key="j" />],
    ['profile', 'Досье', <IconProfile key="p" />],
    ['memory', 'Память', <IconMemory key="m" />],
    ['audit', 'Журнал', <IconAudit key="a" />],
    ['settings', 'Настройки', <IconSettings key="s" />],
  ] as const;
  const needs: Partial<Record<View, ModuleId>> = { crm: 'crm', mentor: 'mentor', calls: 'telephony', jobs: 'scheduler' };
  const nav = navAll.filter(([v]) => !(needs[v] && off.includes(needs[v]!)));

  return (
    <div className="app">
      <nav className="rail" aria-label="Разделы">
        <div className="rail-brand" aria-hidden="true">
          <span className="brand-mark" />
        </div>
        {nav.map(([v, label, icon]) => (
          <button key={v} className={`nav-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)} aria-current={view === v ? 'page' : undefined} title={label}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
        <div className="rail-foot">
          <div className={`status ${info?.mode === 'live' ? 'status-live' : 'status-demo'}`} title={info?.mode === 'live' ? `Claude · ${info.model}` : 'Демо-режим'}>
            <span className="dot" />
            <span>{info ? (info.mode === 'live' ? 'Claude' : 'Демо') : '…'}</span>
          </div>
          <div className="muted small">v{info?.version}</div>
        </div>
      </nav>

      <main className="main">
        {error && (
          <div className="banner banner-err" role="alert">
            {error}
            <button className="link" onClick={() => setError('')}>
              Закрыть
            </button>
          </div>
        )}
        {jobToast && (
          <div className={`banner ${jobToast.ok ? 'banner-ok' : 'banner-err'}`} role="status">
            ⏱ <strong>{jobToast.title}:</strong> {jobToast.summary.slice(0, 400)}
            <button className="link" onClick={() => { setView('jobs'); setJobToast(null); }}>
              Открыть задачи
            </button>
            <button className="link" onClick={() => setJobToast(null)}>
              Закрыть
            </button>
          </div>
        )}
        {updateAvail && view !== 'settings' && (
          <div className="banner banner-demo" role="status">
            Доступно обновление JARVIS: {updateAvail}
            <button className="link" onClick={() => setView('settings')}>
              Открыть настройки обновления
            </button>
          </div>
        )}
        {voice.state !== 'idle' && view !== 'hud' && (
          <div className="mic-live" role="status">
            <span className="mic-live-dot" /> Микрофон включён
            <button className="link" onClick={voice.stop}>
              выключить
            </button>
          </div>
        )}
        {view === 'hud' && (
          <HudView
            info={info}
            settings={settings}
            orbState={orbState}
            getLevel={getLevel}
            userText={userText}
            replyText={stripUntrustedWrapper(replyText)}
            activity={activity}
            running={running}
            voice={voice}
            camera={camera}
            onSend={(t) => void send(t)}
            onStop={stop}
          />
        )}
        {view === 'chat' && (
          <div className="chat-layout">
            <aside className="convs-pane">
              <button className="btn btn-primary full" onClick={() => void newConversation()}>
                + Новый диалог
              </button>
              <ul className="convs">
                {convs.map((c) => (
                  <li key={c.id} className={c.id === activeId ? 'active' : ''}>
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
            </aside>
            <ChatView info={info} messages={messages} streaming={streaming} running={running} hasConversation={activeId !== null} onSend={(t) => void send(t)} onStop={stop} voice={voice} />
          </div>
        )}
        {view === 'mentor' && <MentorView onAsk={(t) => void sendSpoken(t)} />}
        {view === 'calls' && <CallsView />}
        {view === 'jobs' && <JobsView onOpenConversation={(id) => void openConversation(id)} />}
        {view === 'crm' && <CrmView onAsk={(t) => void sendSpoken(t)} onOpenSettings={() => setView('settings')} />}
        {view === 'profile' && (
          <ProfileView
            enabled={settings.profileEnabled}
            onIntroduce={() => void sendSpoken('Давай познакомимся. Задавай мне по одному короткому вопросу — о моей работе, близких, целях, распорядке и о том, как со мной лучше общаться. Когда узнаешь достаточно, покажи, что собираешься сохранить в досье.')}
            onImportedText={(name, text, truncated) =>
              void sendSpoken(`Вот текст из файла «${name}»${truncated ? ' (показано начало)' : ''}. Выдели из него то, что стоит знать обо мне и моих делах, и предложи сохранить это в досье (разделы: обо мне, работа, близкие, цели, распорядок, как со мной общаться, чего не делать). Секреты и пароли не сохраняй.\n\n${text}`)
            }
          />
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
            onSetKey={async (k) => {
              await window.jarvis.secrets.setApiKey(k);
              await refreshInfo();
            }}
            onClearKey={async () => {
              await window.jarvis.secrets.clearApiKey();
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
          />
        )}
      </main>

      {current && <ConfirmDialog req={current} onAnswer={(a) => answer(current.id, a)} onStop={stop} />}
    </div>
  );
}

