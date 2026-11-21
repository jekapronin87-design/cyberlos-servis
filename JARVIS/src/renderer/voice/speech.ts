// Озвучка ответов Джарвиса: потоковая (по предложениям), с уровнем громкости для анимации шара.
//  • «api»    — облачный синтез речи, предложения запрашиваются заранее параллельно и играются по очереди;
//  • «system» — голоса Windows (бесплатно).
import type { TtsMode } from '../../shared/types';
import { textForSpeech } from '../../shared/voice';

type Listener = (speaking: boolean) => void;
const listeners = new Set<Listener>();
let speaking = false;
let generation = 0; // растёт при каждой отмене — «старые» сессии замолкают

const setSpeaking = (v: boolean): void => {
  if (speaking === v) return;
  speaking = v;
  listeners.forEach((l) => l(v));
};
export const isSpeaking = (): boolean => speaking;
export const onSpeaking = (cb: Listener): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// ---------- уровень звука ----------
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let pseudo = 0; // для голосов Windows: всплеск на каждом слове, затухает
let pseudoAt = 0;
let smooth = 0;
let activeAudio = 0;

function ensureAudio(): { ctx: AudioContext; an: AnalyserNode } {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(audioCtx.destination);
  }
  return { ctx: audioCtx, an: analyser! };
}

/** Текущая «громкость» речи 0..1 (для анимации шара). */
export function getSpeechLevel(): number {
  let target = 0;
  if (activeAudio > 0 && analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    target = Math.min(1, Math.sqrt(sum / buf.length) * 5);
  } else if (speaking) {
    const age = performance.now() - pseudoAt;
    target = Math.max(0.12, pseudo * Math.exp(-age / 180)); // системный голос: имитация по границам слов
  }
  smooth += (target - smooth) * 0.35;
  return smooth;
}

// ---------- выбор голоса Windows ----------
function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const have = window.speechSynthesis.getVoices();
    if (have.length) return resolve(have);
    const t = setTimeout(() => resolve(window.speechSynthesis.getVoices()), 800);
    window.speechSynthesis.addEventListener('voiceschanged', () => (clearTimeout(t), resolve(window.speechSynthesis.getVoices())), { once: true });
  });
}

export async function listSystemVoices(): Promise<{ name: string; lang: string }[]> {
  if (!window.speechSynthesis) return [];
  return (await voicesReady()).filter((v) => v.lang.toLowerCase().startsWith('ru')).map((v) => ({ name: v.name, lang: v.lang }));
}

function pickVoice(voices: SpeechSynthesisVoice[], wanted: string): SpeechSynthesisVoice | undefined {
  const ru = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'));
  if (wanted) {
    const w = ru.find((v) => v.name === wanted);
    if (w) return w;
  }
  // Для Джарвиса предпочитаем мужской «естественный» голос; на Windows это обычно Microsoft Pavel/Dmitry.
  return ru.find((v) => /natural|online/i.test(v.name) && /pavel|dmitry|male/i.test(v.name)) ?? ru.find((v) => /pavel|dmitry|yuri|male/i.test(v.name)) ?? ru.find((v) => /natural|online/i.test(v.name)) ?? ru[0];
}

// ---------- деление на предложения ----------
/** Забирает из буфера законченные предложения; остаток возвращает. Короткие обрывки («Да.») клеятся со следующим предложением. */
export function takeSentences(buffer: string, final: boolean): { sentences: string[]; rest: string } {
  const out: string[] = [];
  let rest = buffer;
  let carry = '';
  const re = /^([\s\S]*?[.!?…]+["»)]?)(\s+|$)/;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(re)) && (m[2] !== '' || final)) {
    const cur = carry ? `${carry} ${m[1]!.trim()}` : m[1]!.trim();
    rest = rest.slice(m[0].length);
    if (cur.length < 18 && rest.trim() && !final) {
      carry = cur;
      continue;
    }
    carry = '';
    if (cur) out.push(cur);
  }
  // Незаконченный «хвост» (в том числе накопленный обрывок) возвращаем в буфер, при финале — озвучиваем.
  rest = carry ? `${carry} ${rest}`.trim() : rest;
  if (final && rest.trim()) {
    out.push(rest.trim());
    rest = '';
  }
  return { sentences: out, rest };
}

export function cancelSpeech(): void {
  generation++;
  window.speechSynthesis?.cancel();
  activeAudio = 0;
  document.querySelectorAll<HTMLAudioElement>('audio[data-jv-tts]').forEach((a) => {
    a.pause();
    a.remove();
  });
  setSpeaking(false);
}

export interface SpeechOptions {
  mode: TtsMode;
  systemVoice?: string;
  onError?: (message: string) => void;
}

/** Одна реплика: текст можно подавать частями по мере генерации, озвучка начинается с первого предложения. */
export class SpeechSession {
  private buf = '';
  private gen: number;
  private chain: Promise<void> = Promise.resolve();
  private fetches: Promise<Blob | null>[] = [];

  constructor(private o: SpeechOptions) {
    cancelSpeech();
    this.gen = generation;
  }

  private get alive(): boolean {
    return this.gen === generation;
  }

  push(text: string): void {
    if (this.o.mode === 'off' || !this.alive) return;
    this.buf += text;
    const { sentences, rest } = takeSentences(this.buf, false);
    this.buf = rest;
    sentences.forEach((s) => this.enqueue(s));
  }

  /** Дочитать остаток и дождаться конца воспроизведения. */
  async end(): Promise<void> {
    if (this.o.mode === 'off' || !this.alive) return;
    const { sentences } = takeSentences(this.buf, true);
    this.buf = '';
    sentences.forEach((s) => this.enqueue(s));
    await this.chain;
    if (this.alive) setSpeaking(false);
  }

  private enqueue(sentence: string): void {
    const text = textForSpeech(sentence, 600);
    if (!text) return;
    setSpeaking(true);
    if (this.o.mode === 'api') {
      // Запрос стартует сразу (параллельно), воспроизведение — строго по порядку.
      const req = window.jarvis.voice
        .speak(text)
        .then(({ mime, data }) => new Blob([data as BlobPart], { type: mime }))
        .catch((e: unknown) => {
          if (this.alive) this.o.onError?.(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка озвучки');
          return null;
        });
      this.chain = this.chain.then(async () => {
        const blob = await req;
        if (blob && this.alive) await this.playBlob(blob);
      });
    } else {
      this.chain = this.chain.then(() => (this.alive ? this.sayWithSystem(text) : undefined));
    }
  }

  private async playBlob(blob: Blob): Promise<void> {
    const { ctx, an } = ensureAudio();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.setAttribute('data-jv-tts', '1');
    const src = ctx.createMediaElementSource(audio);
    src.connect(an);
    document.body.appendChild(audio);
    activeAudio++;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      audio.onended = audio.onerror = done;
      void audio.play().catch(done);
    });
    activeAudio = Math.max(0, activeAudio - 1);
    audio.remove();
    URL.revokeObjectURL(url);
  }

  private async sayWithSystem(text: string): Promise<void> {
    if (!window.speechSynthesis) return;
    const voices = await voicesReady();
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      const v = pickVoice(voices, this.o.systemVoice ?? '');
      if (v) u.voice = v;
      u.rate = 1.02;
      u.pitch = 0.82; // чуть ниже — солиднее
      u.onboundary = () => {
        pseudo = 0.7 + Math.random() * 0.3;
        pseudoAt = performance.now();
      };
      u.onend = u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}

/** Озвучить готовый текст целиком. */
export async function speak(text: string, mode: TtsMode, opts: Omit<SpeechOptions, 'mode'> = {}): Promise<void> {
  const s = new SpeechSession({ mode, ...opts });
  s.push(text);
  await s.end();
}
