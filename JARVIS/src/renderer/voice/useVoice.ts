import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { isEndPhrase, isJunkTranscript, isLikelyEcho, parseVoiceCommand, type UtteranceMeta } from '../../shared/voice';
import { VoiceListener, type ListenerState } from './listener';
import { cancelSpeech, isSpeaking, speak, speechState } from './speech';

export type VoiceUiState = 'idle' | 'listening' | 'hearing' | 'transcribing';

const STT_TIMEOUT_MS = 30_000;

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка голоса';

export interface VoiceNote {
  text: string;
  kind: 'info' | 'warn';
  at: number;
}

export interface VoiceControl {
  /** Что Системно сейчас понял/сделал с вашей последней фразой — чтобы было видно, почему он (не) ответил. */
  note: VoiceNote | null;
  state: VoiceUiState;
  /** Сказали «Системно» без команды — ждём продолжение. */
  awaiting: boolean;
  level: number;
  toggle(): void;
  stop(): void;
  /** После ответа Системно: несколько секунд принимать следующую фразу без слова-имени. */
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
  const [note, setNote] = useState<VoiceNote | null>(null);
  const say = useCallback((text: string, kind: VoiceNote['kind'] = 'info') => setNote({ text, kind, at: Date.now() }), []);
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
    // Беседа: после слова-имени ассистент слушает без него, пока вы разговариваете; затихает после паузы (по умолчанию 2 минуты) или на «пока».
    awaitTimer.current = v ? window.setTimeout(() => setAwait(false), Math.max(10, pRef.current.settings.voiceSessionSec) * 1000) : null;
  }, []);

  const handleUtterance = useCallback(
    async (blob: Blob, meta: UtteranceMeta): Promise<void> => {
      const cur = pRef.current;
      // Своя речь из колонок (эхо) — не команда: длинную фразу, пересекающуюся с речью Системно, не отправляем на распознавание.
      if (isLikelyEcho(meta, speechState())) {
        say('Слышу свою собственную речь из колонок — пропускаю. Если мешает, используйте наушники.');
        return;
      }
      setTranscribing((n) => n + 1);
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let timer = 0;
        const text = await Promise.race([
          window.jarvis.voice.transcribe(bytes, blob.type || 'audio/wav'),
          new Promise<never>((_, rej) => {
            timer = window.setTimeout(() => rej(new Error('Распознавание речи не ответило за 30 секунд. Проверьте интернет и ключ голоса.')), STT_TIMEOUT_MS);
          }),
        ]).finally(() => window.clearTimeout(timer));
        const wake = cur.settings.voiceMode === 'wake';
        if (isJunkTranscript(text)) return; // «Продолжение следует…» и прочие выдумки распознавания на шуме
        if (wake && awaitingRef.current && isEndPhrase(text)) {
          setAwait(false);
          say('Хорошо, я на связи. Позовите по имени, когда понадоблюсь.');
          if (cur.settings.ttsMode !== 'off') void speak('Хорошо.', cur.settings.ttsMode, { systemVoice: cur.settings.systemVoice, speed: cur.settings.ttsSpeed }).catch(() => {});
          return;
        }
        const cmd = parseVoiceCommand(text, { requireWake: wake && !awaitingRef.current, names: [cur.settings.assistantName] });
        const heard = text.trim().slice(0, 90);
        if (!heard) return; // тишина или шум
        if (cmd.kind === 'ignore') {
          say(`Услышал: «${heard}» — но нет слова «${cur.settings.assistantName}». Начните фразу с этого слова.`, 'warn');
        } else if (cmd.kind === 'stop') {
          say('Команда «стоп»');
          cancelSpeech();
          cur.onStopCommand();
        } else if (cmd.kind === 'wake') {
          if (isSpeaking()) {
            say(`Услышал: «${heard}» — но я ещё говорю. Скажите «стоп», чтобы прервать.`, 'warn');
            return;
          }
          if (!cmd.text) {
            if (wake) {
              setAwait(true);
              say('Слушаю вас…');
              if (cur.settings.ttsMode !== 'off') void speak('Слушаю.', cur.settings.ttsMode, { systemVoice: cur.settings.systemVoice, speed: cur.settings.ttsSpeed }).catch(() => {});
            }
            return;
          }
          if (wake) setAwait(true); // беседа продолжается без слова-имени
          if (cur.isBusy()) {
            say(`Услышал: «${heard}» — но я ещё отвечаю на предыдущий запрос. Скажите «стоп».`, 'warn');
            return;
          }
          say(`Понял: «${cmd.text.slice(0, 90)}»`);
          cur.onCommand(cmd.text);
        }
      } catch (e) {
        const m = cleanError(e);
        say(m, 'warn');
        cur.onError(m);
      } finally {
        setTranscribing((n) => n - 1);
      }
    },
    [setAwait, say],
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
        onUtterance: (b, meta) => {
          queue.current = queue.current.then(() => handleUtterance(b, meta));
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

  return { state, awaiting, level, toggle, stop, followUp, note };
}
