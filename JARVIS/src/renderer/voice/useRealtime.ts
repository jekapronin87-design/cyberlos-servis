import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { RealtimeConversation, type RtState } from './realtime';
import type { VoiceControl, VoiceNote, VoiceUiState } from './useVoice';
import { logVoice } from './useVoice';
import { uiSounds } from '../audio/uiSounds';

/** «Живой разговор» в форме обычного VoiceControl — весь существующий интерфейс (шар, кнопка микрофона, подписи) работает без изменений. */
export function useRealtime(p: {
  settings: Settings;
  enableMic(): Promise<boolean>;
  /** Выполнить просьбу ядром ассистента и вернуть текст ответа. */
  runRequest(text: string): Promise<string>;
  onStopTask(): void;
  onError(message: string): void;
  onUserText(text: string): void;
  onAssistantText(text: string): void;
  /** Перед стартом: выключить обычный слушатель и озвучку. */
  beforeStart(): void;
}): { control: VoiceControl; active: boolean; speaking: boolean; level(): number } {
  const [rtState, setRtState] = useState<RtState>('idle');
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [left, setLeft] = useState(0);
  const conv = useRef<RealtimeConversation | null>(null);
  const pRef = useRef(p);
  pRef.current = p;

  const say = useCallback((text: string, kind: VoiceNote['kind'] = 'info') => {
    logVoice(text);
    setNote({ text, kind, at: Date.now() });
  }, []);

  const stop = useCallback(() => {
    conv.current?.stop('user');
  }, []);

  const toggle = useCallback(() => {
    void (async () => {
      if (conv.current?.active) return stop();
      const cur = pRef.current;
      if (!cur.settings.micEnabled && !(await cur.enableMic())) return;
      const hasKey = (await window.jarvis.app.info()).hasVoiceKey;
      if (!hasKey) return cur.onError('Для живого разговора нужен ключ API OpenAI: «Настройки → Голос».');
      cur.beforeStart();
      const c = new RealtimeConversation(
        {
          onState: setRtState,
          onUserText: (t) => {
            logVoice(`Вы: «${t.slice(0, 90)}»`);
            pRef.current.onUserText(t);
          },
          onAssistantText: (t) => {
            logVoice(`Ассистент: «${t.slice(0, 90)}»`);
            pRef.current.onAssistantText(t);
          },
          onNote: say,
          onAsk: (text) => pRef.current.runRequest(text),
          onStopTask: () => pRef.current.onStopTask(),
          onEnd: (_reason, seconds) => {
            if (conv.current === c) conv.current = null;
            setLeft(0);
            if (seconds > 0) {
              say(`Живой разговор завершён (${Math.max(1, Math.round(seconds / 60))} мин).`);
              void window.jarvis.realtime.ended(seconds).catch(() => undefined);
              uiSounds.play('sleep');
            }
          },
        },
        { idleSec: Math.max(30, cur.settings.voiceSessionSec) },
      );
      conv.current = c;
      say('Подключаюсь к живому разговору…');
      try {
        await c.start();
        uiSounds.play('wake');
      } catch (e) {
        if (conv.current === c) conv.current = null;
        cur.onError(e instanceof Error ? e.message : 'Не удалось начать живой разговор');
      }
    })();
  }, [say, stop]);

  useEffect(() => {
    if (rtState === 'idle') return;
    const t = setInterval(() => setLeft(conv.current?.idleLeft ?? 0), 1000);
    return () => clearInterval(t);
  }, [rtState]);
  useEffect(() => () => conv.current?.stop('user'), []);
  // Главный выключатель микрофона выключен — разговор прекращается сразу.
  useEffect(() => {
    if (!p.settings.micEnabled) conv.current?.stop('user');
  }, [p.settings.micEnabled]);

  const uiState: VoiceUiState = rtState === 'idle' ? 'idle' : rtState === 'hearing' ? 'hearing' : rtState === 'connecting' || rtState === 'thinking' ? 'transcribing' : 'listening';
  const control: VoiceControl = {
    note,
    state: uiState,
    awaiting: rtState !== 'idle' && rtState !== 'connecting',
    level: 0,
    toggle,
    stop,
    followUp: () => undefined,
    sessionLeft: left,
    heal: () => undefined,
  };
  return { control, active: rtState !== 'idle', speaking: rtState === 'speaking', level: () => conv.current?.level() ?? 0 };
}
