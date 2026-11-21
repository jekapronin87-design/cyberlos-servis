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
}) {
  const [text, setText] = useState('');
  const [boot, setBoot] = useState(true);
  const [, force] = useState(0);
  const note = props.voice.note;
  const noteFresh = !!note && Date.now() - note.at < 10_000;
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => force((n) => n + 1), 10_200);
    return () => clearTimeout(t);
  }, [note]);
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
  const wake = props.settings.voiceMode === 'wake';
  const hint = props.voice.awaiting
    ? 'Слушаю вас…'
    : live
      ? wake
        ? 'Скажите: «Джарвис, …»'
        : 'Говорите…'
      : props.info?.mode === 'demo'
        ? 'Демо-режим: подключите ключ Claude в настройках'
        : 'Нажмите микрофон или напишите';

  return (
    <section className="hud" data-state={props.orbState}>
      <div className="hud-grid" aria-hidden="true" />
      <div className="hud-scan" aria-hidden="true" />

      <header className="hud-top">
        <div className="hud-brand">
          <span className="hud-brand-mark" aria-hidden="true" />
          <div>
            <div className="hud-title">J.A.R.V.I.S.</div>
            <div className="hud-sub">
              {props.info?.mode === 'live' ? `Claude · ${props.info.model}` : 'ДЕМО-РЕЖИМ'} · {STATE_LABEL[props.orbState]}
            </div>
          </div>
        </div>
        <div className="hud-right">
          <Clock />
          <div className="hud-flags">
            <span className={`flag ${live ? 'flag-on' : ''}`}>МИК</span>
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

      <div className="hud-captions" aria-live="polite">
        {props.userText && <div className="cap-user">{props.userText}</div>}
        {props.replyText && <div className="cap-reply">{props.replyText}</div>}
        {!props.userText && !props.replyText && <div className="cap-hint">{hint}</div>}
      </div>

      {live && wake && !noteFresh && (
        <div className="hud-wakehint" role="status">
          {props.voice.awaiting ? 'Слушаю — говорите' : 'Скажите «Джарвис, …» — без этого слова я не отвечу'}
        </div>
      )}
      {noteFresh && (
        <div className={`hud-note hud-note-${note!.kind}`} role="status">
          {note!.text}
        </div>
      )}

      {props.camera.stream && <CameraPreview stream={props.camera.stream} />}

      <form
        className="hud-bar"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button type="button" className={`hud-btn ${live ? 'on' : ''}`} onClick={props.voice.toggle} aria-pressed={live} title={live ? 'Выключить микрофон' : 'Включить микрофон'} data-testid="hud-mic">
          <IconMic />
          <span>{live ? (props.voice.state === 'hearing' ? 'Слышу' : props.voice.state === 'transcribing' ? 'Распознаю' : 'Слушаю') : 'Микрофон'}</span>
        </button>
        <input
          className="hud-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={hint}
          aria-label="Сообщение Джарвису"
          maxLength={20000}
          autoComplete="off"
        />
        {props.running ? (
          <button type="button" className="hud-btn danger" onClick={props.onStop} title="Остановить">
            <IconStop />
            <span>Стоп</span>
          </button>
        ) : (
          <button type="submit" className="hud-btn primary" disabled={!text.trim()} title="Отправить">
            <IconSend />
          </button>
        )}
        <button type="button" className={`hud-btn ${props.camera.active ? 'on' : ''}`} onClick={props.camera.toggle} aria-pressed={props.camera.active} title={props.camera.active ? 'Выключить камеру' : 'Включить камеру (Джарвис сможет видеть вас)'} data-testid="hud-cam">
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
