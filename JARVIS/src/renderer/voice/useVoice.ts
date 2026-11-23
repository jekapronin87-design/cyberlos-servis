import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { isEchoOfSpeech, isEndPhrase, isJunkTranscript, parseVoiceCommand, type UtteranceMeta } from '../../shared/voice';
import { VoiceListener, type ListenerState } from './listener';
import { uiSounds } from '../audio/uiSounds';
import { cancelSpeech, isAudibleNow, isSpeaking, recentSpoken, speak, speechState } from './speech';

export type VoiceUiState = 'idle' | 'listening' | 'hearing' | 'transcribing';

const STT_TIMEOUT_MS = 75_000;

const cleanError = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка голоса';

/** Журнал голоса (последние реплики и что с ними сделано) — виден в «Настройки → Голос → Проверить микрофон»: помогает понять, почему он (не) отвечает. */
export const voiceLog: { at: number; text: string }[] = [];
(window as unknown as { __voiceLog: typeof voiceLog }).__voiceLog = voiceLog; // для самопроверок (видно только внутри окна)
export const logVoice = (text: string): void => {
  voiceLog.push({ at: Date.now(), text });
  while (voiceLog.length > 14) voiceLog.shift();
};

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
  /** Сколько секунд беседы без слова-имени осталось (0 — беседа не идёт). */
  sessionLeft: number;
  /** Самопроверка: снять зависшую озвучку, переподключить заглохший микрофон. Вызывается при возврате в окно/на главный экран. */
  heal(): void;
}

export function useVoice(p: {
  settings: Settings;
  isBusy: () => boolean;
  onCommand(text: string): void;
  onStopCommand(): void;
  onError(message: string): void;
  /** Включить главный выключатель микрофона (с подтверждением пользователя). Вернёт true, если включён. */
  enableMic(): Promise<boolean>;
  /** Выбран «живой разговор»: услышав имя, не выполнять команду здесь, а начать разговор (text — сказанное после имени). */
  onRealtimeWake?: (text: string) => void;
}): VoiceControl {
  const [listenState, setListenState] = useState<ListenerState>('idle');
  const [transcribing, setTranscribing] = useState(0);
  const [awaiting, setAwaiting] = useState(false);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<VoiceNote | null>(null);
  const say = useCallback((text: string, kind: VoiceNote['kind'] = 'info') => {
    logVoice(text);
    setNote({ text, kind, at: Date.now() });
  }, []);
  const listener = useRef<VoiceListener | null>(null);
  const awaitingRef = useRef(false);
  const awaitTimer = useRef<number | null>(null);
  const awaitUntil = useRef(0);
  const [sessionLeft, setSessionLeft] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Сколько подряд «коротких» (≤3 слов) реплик принято в беседе без слова-имени — признак зацикливания на эхе или шуме. */
  const shortStreak = useRef(0);
  /** Команда, которую подержали, пока не станет ясно, закончили ли вы мысль (длинная речь часто идёт несколькими кусками). */
  const pending = useRef<{ text: string; timer: number; since: number } | null>(null);
  /** Идёт ли сейчас вторая часть речи (слышим вас или распознаём) — тогда команду не выполняем, ждём. */
  const activity = useRef({ hearing: false, transcribing: 0 });
  const clearPending = (): void => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
  };
  const pRef = useRef(p);
  pRef.current = p;

  const setAwait = useCallback((v: boolean) => {
    awaitingRef.current = v;
    setAwaiting(v);
    if (awaitTimer.current !== null) window.clearTimeout(awaitTimer.current);
    // Беседа: после слова-имени ассистент слушает без него, пока вы разговариваете; затихает после паузы (по умолчанию 2 минуты) или на «пока».
    const arm = (ms: number): void => {
      awaitUntil.current = Date.now() + ms;
      awaitTimer.current = window.setTimeout(() => {
        // Пока он думает или говорит — беседа не заканчивается: отсчёт паузы идёт только когда все молчат.
        if (pRef.current.isBusy() || isSpeaking()) return arm(15_000);
        awaitTimer.current = null;
        awaitingRef.current = false;
        setAwaiting(false);
        setSessionLeft(0);
        uiSounds.play('sleep');
        say(`Беседа закончилась (пауза). Чтобы продолжить, скажите «${pRef.current.settings.assistantName}, …».`, 'warn');
      }, ms);
    };
    if (v) arm(Math.max(10, pRef.current.settings.voiceSessionSec) * 1000);
    else {
      awaitTimer.current = null;
      awaitUntil.current = 0;
      setSessionLeft(0);
    }
  }, [say]);

  // Обратный отсчёт беседы на экране — чтобы было видно, слушает ли он без слова-имени
  useEffect(() => {
    if (!awaiting) return;
    const t = setInterval(() => setSessionLeft(Math.max(0, Math.round((awaitUntil.current - Date.now()) / 1000))), 1000);
    setSessionLeft(Math.max(0, Math.round((awaitUntil.current - Date.now()) / 1000)));
    return () => clearInterval(t);
  }, [awaiting]);

  const handleUtterance = useCallback(
    async (blob: Blob, meta: UtteranceMeta): Promise<void> => {
      const cur = pRef.current;
      setTranscribing((n) => n + 1);
      activity.current.transcribing += 1;
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let timer = 0;
        const text = await Promise.race([
          window.jarvis.voice.transcribe(bytes, blob.type || 'audio/wav'),
          new Promise<never>((_, rej) => {
            timer = window.setTimeout(() => rej(new Error('Распознавание речи не ответило за 75 секунд. Проверьте интернет и ключ голоса.')), STT_TIMEOUT_MS);
          }),
        ]).finally(() => window.clearTimeout(timer));
        const wake = cur.settings.voiceMode === 'wake';
        if (isJunkTranscript(text)) {
          if (text.trim()) logVoice(`Отброшено как шум/выдумку распознавания: «${text.trim().slice(0, 60)}»`);
          return;
        }
        if (!cur.settings.voiceHeadphones && isEchoOfSpeech(text, recentSpoken())) {
          say('Это слова самого ассистента из колонок — пропускаю. С наушниками такого не будет.');
          return;
        } // «Продолжение следует…» и прочие выдумки распознавания на шуме
        if (wake && awaitingRef.current && isEndPhrase(text)) {
          setAwait(false);
          say('Хорошо, я на связи. Позовите по имени, когда понадоблюсь.');
          if (cur.settings.ttsMode !== 'off') void speak('Хорошо.', cur.settings.ttsMode, { systemVoice: cur.settings.systemVoice, speed: cur.settings.ttsSpeed }).catch(() => {});
          return;
        }
        const cmd = parseVoiceCommand(text, { requireWake: wake && !awaitingRef.current, names: [cur.settings.assistantName] });
        const heard = text.trim().slice(0, 90);
        if (!heard) {
          logVoice('Фраза записана, но распознана как тишина — пропущена.');
          return; // тишина или шум
        }
        logVoice(`Распознано: «${heard}»`);
        if (cmd.kind === 'ignore') {
          say(`Услышал: «${heard}» — но нет слова «${cur.settings.assistantName}». Начните фразу с этого слова.`, 'warn');
        } else if (cmd.kind === 'stop') {
          say('Команда «стоп»');
          clearPending();
          cancelSpeech();
          cur.onStopCommand();
        } else if (cmd.kind === 'wake' && cur.settings.voiceEngine === 'realtime' && cur.onRealtimeWake) {
          say('Слышу вас — начинаю разговор…');
          const t = cmd.text;
          stop(); // микрофон переходит к живому разговору
          cur.onRealtimeWake(t);
          return;
        } else if (cmd.kind === 'wake') {
          if (isSpeaking()) {
            // В наушниках эхо невозможно: ваша речь поверх ассистента — это перебивание, он замолкает и слушает вас.
            if (cur.settings.voiceHeadphones) cancelSpeech();
            else {
              say(`Услышал: «${heard}» — но я ещё говорю. Скажите «стоп», чтобы прервать.`, 'warn');
              return;
            }
          }
          if (!cmd.text) {
            if (wake) {
              const already = awaitingRef.current;
              setAwait(true);
              if (already) return; // уже слушаю: повторный зов по имени (или шум) не должен вызывать новый ответ
              say('Слушаю вас…');
              if (cur.settings.ttsMode !== 'off') void speak('Слушаю.', cur.settings.ttsMode, { systemVoice: cur.settings.systemVoice, speed: cur.settings.ttsSpeed }).catch(() => {});
            }
            return;
          }
          const words = cmd.text.split(/\s+/).filter(Boolean).length;
          if (wake && awaitingRef.current) {
            shortStreak.current = words <= 3 ? shortStreak.current + 1 : 0;
            // Две коротких реплики подряд без слова-имени — скорее всего, я слышу сам себя или шум, а не вас. Прекращаем, чтобы не зациклиться.
            if (shortStreak.current >= 3) {
              shortStreak.current = 0;
              setAwait(false);
              say('Похоже, я слышу сам себя или шум, а не вас, — беседу завершил. Скажите имя, когда понадоблюсь (в наушниках такого не бывает).', 'warn');
              return;
            }
          } else shortStreak.current = 0;
          if (wake) setAwait(true); // беседа продолжается без слова-имени
          // Длинная речь приходит кусками (пауза посреди мысли): если фраза не закончена (нет точки/вопроса) или была долгой, ждём продолжение и склеиваем.
          const text2 = pending.current ? `${pending.current.text} ${cmd.text}` : cmd.text;
          const long = meta.endedAt - meta.startedAt > 6000;
          const finished = /[.!?…]["»)]?\s*$/.test(cmd.text.trim());
          const run = (): void => {
            clearPending();
            const c2 = pRef.current;
            if (c2.isBusy()) {
              say(`Услышал: «${text2.slice(0, 90)}» — но я ещё отвечаю на предыдущий запрос. Скажите «стоп».`, 'warn');
              return;
            }
            say(`Понял: «${text2.slice(0, 90)}»`);
            c2.onCommand(text2);
          };
          // Короткие команды без точки («открой аналитику») выполняются сразу — ждём только когда фраза длинная и оборвана.
          if (wake && !finished && (long || words >= 6)) {
            const since = pending.current?.since ?? Date.now();
            if (pending.current) window.clearTimeout(pending.current.timer);
            // Выполняем, когда вы замолчали и ничего не распознаётся; но не ждём бесконечно (не дольше 12 с)
            const arm = (): number =>
              window.setTimeout(() => {
                const busy = activity.current.hearing || activity.current.transcribing > 0;
                if (busy && Date.now() - since < 12_000 && pending.current) pending.current.timer = arm();
                else run();
              }, 1600);
            pending.current = { text: text2, timer: arm(), since };
            say(`Слушаю дальше… («${text2.slice(-60)}»)`);
            return;
          }
          run();
        }
      } catch (e) {
        const m = cleanError(e);
        say(m, 'warn');
        cur.onError(m);
      } finally {
        setTranscribing((n) => n - 1);
        activity.current.transcribing -= 1;
      }
    },
    [setAwait, say],
  );

  const stop = useCallback(() => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
    listener.current?.stop();
    listener.current = null;
    setAwait(false);
  }, [setAwait]);

  const toggleRef = useRef<() => void>(() => undefined);
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
        onState: (s) => {
          activity.current.hearing = s === 'hearing';
          setListenState(s);
        },
        onLevel: setLevel,
        gate: () => {
          if (pRef.current.settings.voiceHeadphones) return { speaking: false, lastEnd: 0 };
          const s = speechState();
          // Эхом считаем только то, что звучит из колонок прямо сейчас. Пауза между предложениями (следующее ещё готовится) — это тишина, ваша речь в ней настоящая.
          const speaking = isSpeaking() && isAudibleNow();
          return { speaking, lastEnd: s.lastSpokeEnd };
        },
        onDropped: (why) => say(why === 'echo' ? 'Пока я говорил, микрофон слышал мой голос из колонок — это пропущено. Говорите после того, как я закончу (с наушниками можно перебивать).' : 'Слишком короткая фраза после моей речи — не расслышал. Повторите.', 'warn'),
        onUtterance: (b, meta) => {
          queue.current = queue.current.then(() => handleUtterance(b, meta));
        },
        onLost: () => {
          say('Микрофон отключился или «заснул» — переподключаю…', 'warn');
          stop();
          window.setTimeout(() => toggleRef.current(), 600);
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

  toggleRef.current = toggle;

  // Главный выключатель выключен — мгновенно прекращаем прослушивание.
  useEffect(() => {
    if (!p.settings.micEnabled) stop();
  }, [p.settings.micEnabled, stop]);
  useEffect(() => () => stop(), [stop]);

  const state: VoiceUiState = transcribing > 0 && listenState !== 'hearing' ? 'transcribing' : listenState;
  const followUp = useCallback(() => {
    if (listener.current?.active && pRef.current.settings.voiceMode === 'wake') setAwait(true);
  }, [setAwait]);

  /** Самопроверка: зависшая озвучка и заглохший захват. */
  const heal = useCallback(() => {
    isSpeaking(); // сам сбросит зависший флаг «говорит»
    const l = listener.current;
    if (l?.active && !document.hidden && Date.now() - l.lastAudioAt > 3500) {
      say('Звук с микрофона перестал поступать — переподключаю…', 'warn');
      stop();
      window.setTimeout(() => toggleRef.current(), 400);
    }
  }, [say, stop]);
  useEffect(() => {
    const t = setInterval(heal, 3000);
    const onVis = (): void => {
      if (!document.hidden) heal();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', heal);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', heal);
    };
  }, [heal]);

  return { state, awaiting, level, toggle, stop, followUp, note, sessionLeft, heal };
}
