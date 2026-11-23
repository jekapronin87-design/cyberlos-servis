import { useEffect, useRef, useState } from 'react';
import type { AppInfo, Settings } from '../../shared/types';
import type { CameraControl } from '../voice/useCamera';
import type { VoiceControl } from '../voice/useVoice';
import { IconCam, IconMic, IconSend, IconStop } from './Icons';
import { Orb, type OrbState } from './Orb';

export interface ActivityItem {
  id: string;
  label: string;
  status: 'run' | 'ok' | 'err' | 'denied';
}

const STATE_LABEL: Record<OrbState, string> = {
  idle: 'ГОТОВ',
  listening: 'СЛУШАЮ',
  thinking: 'ДУМАЮ',
  speaking: 'ГОВОРЮ',
};

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hud-clock">
      <div className="hud-time">{now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
      <div className="hud-date">{now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    </div>
  );
}

function CameraPreview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => {});
    }
  }, [stream]);
  return (
    <div className="hud-cam" role="img" aria-label="Превью камеры">
      <video ref={ref} muted playsInline />
      <span className="hud-cam-tag">● КАМЕРА</span>
    </div>
  );
}

export function HudView(props: {
  info: AppInfo | null;
  settings: Settings;
  orbState: OrbState;
  getLevel: () => number;
  userText: string;
  replyText: string;
  activity: ActivityItem[];
  running: boolean;
  voice: VoiceControl;
  camera: CameraControl;
  onSend: (t: string) => void;
  onStop: () => void;
  /** Микрофон «ждёт имя» в фоне (режим «Системно»): флаг МИК горит, хотя разговор не идёт. */
  armed?: boolean;
  /** Одно нажатие: разрешить микрофон, включить режим «слушать имя» и начать слушать. */
  onSetupHandsFree?: () => void;
}) {
  const [text, setText] = useState('');
  const [boot, setBoot] = useState(true);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setBoot(false), 1800);
    return () => clearTimeout(t);
  }, []);

  const submit = (): void => {
    const v = text.trim();
    if (!v || props.running) return;
    props.onSend(v);
    setText('');
  };
  const live = props.voice.state !== 'idle';
  const rtMode = props.settings.voiceEngine === 'realtime';
  const [typing, setTyping] = useState(false);
  /** Режим «Системно» настроен: микрофон разрешён, слушает имя сам при запуске. Иначе показываем одну кнопку настройки. */
  const ready = props.settings.micEnabled && props.settings.voiceMode === 'wake' && props.settings.autoListen;

  return (
    <section className="hud" data-state={props.orbState}>
      <div className="hud-grid" aria-hidden="true" />
      <div className="hud-scan" aria-hidden="true" />

      <header className="hud-top">
        <div className="hud-brand">
          <span className="hud-brand-mark" aria-hidden="true" />
          <div>
            <div className="hud-title">{props.settings.assistantName.toUpperCase()}</div>
            <div className="hud-sub">
              {props.info?.mode === 'live' ? `Claude · ${props.info.model}` : 'ДЕМО-РЕЖИМ'} · {STATE_LABEL[props.orbState]}
            </div>
          </div>
        </div>
        <div className="hud-right">
          <Clock />
          <div className="hud-flags">
            <span className={`flag ${live || props.armed ? 'flag-on' : ''}`}>МИК</span>
            <span className={`flag ${props.camera.active ? 'flag-on' : ''}`}>КАМ</span>
            <span className={`flag ${props.info?.mode === 'live' ? 'flag-ok' : ''}`}>ИИ</span>
          </div>
        </div>
      </header>

      <aside className="hud-activity" aria-label="Активность">
        <div className="hud-panel-title">АКТИВНОСТЬ</div>
        {props.activity.length === 0 && <div className="hud-empty">Ожидаю команд</div>}
        {props.activity.map((a) => (
          <div key={a.id} className={`act act-${a.status}`}>
            <span className="act-dot" />
            <span className="act-label">{a.label}</span>
          </div>
        ))}
      </aside>

      <div className="hud-stage">
        <Orb state={props.orbState} getLevel={props.getLevel} />
      </div>

      {!ready && !live && props.onSetupHandsFree && (
        <button type="button" className="hud-setup" onClick={props.onSetupHandsFree} data-testid="hud-setup">
          <IconMic />
          <span>Включить режим «{props.settings.assistantName}»</span>
          <small>микрофон будет включаться, когда вы скажете «{props.settings.assistantName}»</small>
        </button>
      )}

      {props.camera.stream && <CameraPreview stream={props.camera.stream} />}

      <form
        className="hud-bar"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" className={`hud-btn ${live ? 'on' : ''}`} onClick={props.voice.toggle} aria-pressed={live} title={live ? (rtMode ? 'Закончить разговор' : 'Выключить микрофон') : rtMode ? 'Начать живой разговор' : 'Включить микрофон'} data-testid="hud-mic">
          <IconMic />
          <span>{live ? (props.voice.state === 'hearing' ? 'Слышу' : props.voice.state === 'transcribing' ? (rtMode ? 'Думаю' : 'Распознаю') : 'Слушаю') : rtMode ? 'Живой разговор' : 'Микрофон'}</span>
        </button>
        <button type="button" className={`hud-btn ${typing ? 'on-soft' : ''}`} onClick={() => setTyping((t) => !t)} aria-pressed={typing} title="Написать вместо того, чтобы говорить" data-testid="hud-type">
          <IconSend />
          <span>Написать</span>
        </button>
        {typing && (
        <input
          className="hud-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Напишите сообщение…"
          aria-label={`Сообщение: ${props.settings.assistantName}`}
          maxLength={20000}
          autoComplete="off"
          autoFocus
        />
        )}
        {typing && !props.running && (
          <button type="submit" className="hud-btn primary" disabled={!text.trim()} title="Отправить">
            <IconSend />
          </button>
        )}
        {props.running ? (
          <button type="button" className="hud-btn danger" onClick={props.onStop} title="Остановить">
            <IconStop />
            <span>Стоп</span>
          </button>
        ) : null}
        <button type="button" className={`hud-btn ${props.camera.active ? 'on' : ''}`} onClick={props.camera.toggle} aria-pressed={props.camera.active} title={props.camera.active ? 'Выключить камеру' : `Включить камеру (${props.settings.assistantName} сможет видеть вас)`} data-testid="hud-cam">
          <IconCam />
          <span>{props.camera.active ? 'Камера вкл' : 'Камера'}</span>
        </button>
      </form>

      {boot && (
        <div className="hud-boot" aria-hidden="true">
          <div className="boot-line">ИНИЦИАЛИЗАЦИЯ ЯДРА…</div>
          <div className="boot-line">ЗАГРУЗКА МОДУЛЕЙ БЕЗОПАСНОСТИ…</div>
          <div className="boot-line">СИСТЕМЫ В НОРМЕ</div>
        </div>
      )}
    </section>
  );
}
