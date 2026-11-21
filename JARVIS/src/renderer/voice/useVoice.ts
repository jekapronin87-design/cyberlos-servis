import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { parseVoiceCommand } from '../../shared/voice';
import { VoiceListener, type ListenerState } from './listener';
import { cancelSpeech, isSpeaking, speak } from './speech';

export type VoiceUiState = 'idle' | 'listening' | 'hearing' | 'transcribing';

const AWAIT_MS = 8000;

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка голоса';

export interface VoiceControl {
  state: VoiceUiState;
  /** Сказали «Джарвис» без команды — ждём продолжение. */
  awaiting: boolean;
  level: number;
  toggle(): void;
  stop(): void;
  /** После ответа Джарвиса: несколько секунд принимать следующую фразу без слова «Джарвис». */
  followUp(): void;
}

export function useVoice(p: {
  settings: Settings;
  isBusy: () => boolean;
  onCommand(text: string): void;
  onStopCommand(): void;
  onError(message: string): void;
  /** Включить главный выключатель микрофона (с подтверждением пользователя). Вернёт true, если включён. */
  enableMic(): Promise<boolean>;
}): VoiceControl {
  const [listenState, setListenState] = useState<ListenerState>('idle');
  const [transcribing, setTranscribing] = useState(0);
  const [awaiting, setAwaiting] = useState(false);
  const [level, setLevel] = useState(0);
  const listener = useRef<VoiceListener | null>(null);
  const awaitingRef = useRef(false);
  const awaitTimer = useRef<number | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pRef = useRef(p);
  pRef.current = p;

  const setAwait = useCallback((v: boolean) => {
    awaitingRef.current = v;
    setAwaiting(v);
    if (awaitTimer.current !== null) window.clearTimeout(awaitTimer.current);
    awaitTimer.current = v ? window.setTimeout(() => setAwait(false), AWAIT_MS) : null;
  }, []);

  const handleUtterance = useCallback(
    async (blob: Blob): Promise<void> => {
      const cur = pRef.current;
      setTranscribing((n) => n + 1);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = await window.jarvis.voice.transcribe(bytes, 'audio/webm');
        const wake = cur.settings.voiceMode === 'wake';
        const cmd = parseVoiceCommand(text, { requireWake: wake && !awaitingRef.current });
        if (cmd.kind === 'stop') {
          cancelSpeech();
          cur.onStopCommand();
        } else if (cmd.kind === 'wake') {
          if (isSpeaking()) return; // пока говорит Джарвис, реагируем только на «стоп»
          if (!cmd.text) {
            if (wake) {
              setAwait(true);
              if (cur.settings.ttsMode !== 'off') void speak('Слушаю.', cur.settings.ttsMode, { systemVoice: cur.settings.systemVoice }).catch(() => {});
            }
            return;
          }
          setAwait(false);
          if (cur.isBusy()) {
            cur.onError('Джарвис ещё отвечает. Скажите «стоп», чтобы прервать.');
            return;
          }
          cur.onCommand(cmd.text);
        }
      } catch (e) {
        cur.onError(cleanError(e));
      } finally {
        setTranscribing((n) => n - 1);
      }
    },
    [setAwait],
  );

  const stop = useCallback(() => {
    listener.current?.stop();
    listener.current = null;
    setAwait(false);
  }, [setAwait]);

  const toggle = useCallback(() => {
    void (async () => {
      if (listener.current?.active) return stop();
      const cur = pRef.current;
      if (!cur.settings.micEnabled && !(await cur.enableMic())) return;
      const hasKey = (await window.jarvis.app.info()).hasVoiceKey; // свежее значение, не кэш интерфейса
      if (!hasKey) {
        cur.onError('Для распознавания речи нужен ключ API голоса: «Настройки → Голос».');
        return;
      }
      cancelSpeech(); // не слушаем собственную озвучку
      const l = new VoiceListener({
        continuous: cur.settings.voiceMode === 'wake',
        onState: setListenState,
        onLevel: setLevel,
        onUtterance: (b) => {
          queue.current = queue.current.then(() => handleUtterance(b));
        },
        onError: (m) => {
          pRef.current.onError(m);
          stop();
        },
      });
      listener.current = l;
      await l.start();
    })();
  }, [handleUtterance, stop]);

  // Главный выключатель выключен — мгновенно прекращаем прослушивание.
  useEffect(() => {
    if (!p.settings.micEnabled) stop();
  }, [p.settings.micEnabled, stop]);
  useEffect(() => () => stop(), [stop]);

  const state: VoiceUiState = transcribing > 0 && listenState !== 'hearing' ? 'transcribing' : listenState;
  const followUp = useCallback(() => {
    if (listener.current?.active && pRef.current.settings.voiceMode === 'wake') setAwait(true);
  }, [setAwait]);

  return { state, awaiting, level, toggle, stop, followUp };
}
