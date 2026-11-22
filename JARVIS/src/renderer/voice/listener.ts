// Захват речи с микрофона и выделение фраз по паузам (VAD по громкости).
// Звук пишется «как есть» (PCM) в кольцевой буфер, поэтому в начале фразы сохраняется 0,6 с ДО того, как сработал детектор:
// начало слова («Си-» в «Системно») не обрезается. Готовая фраза кодируется в WAV 16 кГц и отдаётся вызывающему коду; сам модуль звук никуда не отправляет.
import { applyEchoGate } from './gate';
import { concat, downsample, encodeWav, TARGET_RATE } from './wav';

export type ListenerState = 'idle' | 'listening' | 'hearing';

export interface ListenerOptions {
  /** true — слушать постоянно (режим «Системно»); false — одна фраза и остановка. */
  continuous: boolean;
  onState(s: ListenerState): void;
  onLevel(level: number): void;
  onUtterance(blob: Blob, meta: { startedAt: number; endedAt: number }): void;
  onError(message: string): void;
  /**
   * Что сейчас говорит сам ассистент: чтобы не принимать его голос из колонок за вашу речь.
   * speaking — говорит прямо сейчас; lastEnd — когда закончил (performance.now()).
   */
  gate?: () => { speaking: boolean; lastEnd: number };
  /** Диагностика: фраза отброшена (причина). */
  onDropped?: (reason: 'echo' | 'short') => void;
  /** Для тестов. */
  minSpeechMs?: number;
  silenceMs?: number;
  maxUtteranceMs?: number;
}

const NO_SPEECH_TIMEOUT_MS = 8000;
const PRE_ROLL_MS = 600;
const BUFFER = 2048;
interface Chunk {
  /** Момент окончания куска (performance.now()). */
  t: number;
  d: Float32Array;
  ms: number;
}

export class VoiceListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private running = false;
  private startedAt = 0;
  private noiseFloor = 0.006;
  /** Кольцо последних кусков звука (до начала фразы). */
  private pre: Chunk[] = [];
  private preMs = 0;
  /** Текущая фраза. */
  private rec: Chunk[] | null = null;
  private recMs = 0;
  private speechMs = 0;
  private silenceMs = 0;
  private peak = 0;
  private heard = false;
  private speechFirstAt = 0;
  private speechLastAt = 0;
  private segStart = 0;

  constructor(private o: ListenerOptions) {}

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      this.o.onError(
        name === 'NotFoundError'
          ? 'Микрофон не найден. Подключите микрофон и попробуйте снова.'
          : 'Нет доступа к микрофону. Проверьте, что он включён в настройках Системно и разрешён в Windows (Параметры → Конфиденциальность → Микрофон).',
      );
      return;
    }
    this.ctx = new AudioContext();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor: даёт «сырой» звук без перекодирования. Подключается к выходу через нулевое усиление, иначе браузер его не запускает.
    this.proc = this.ctx.createScriptProcessor(BUFFER, 1, 1);
    this.proc.onaudioprocess = (e) => this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.src.connect(this.proc);
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);
    this.running = true;
    this.startedAt = Date.now();
    this.o.onState('listening');
  }

  stop(): void {
    if (!this.running && !this.stream) return;
    this.running = false;
    if (this.proc) this.proc.onaudioprocess = null;
    this.proc?.disconnect();
    this.src?.disconnect();
    this.proc = null;
    this.src = null;
    this.rec = null;
    this.pre = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.o.onLevel(0);
    this.o.onState('idle');
  }

  private reset(): void {
    this.rec = null;
    this.recMs = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.peak = 0;
    this.heard = false;
    this.speechFirstAt = 0;
    this.speechLastAt = 0;
  }

  private onAudio(chunk: Float32Array): void {
    if (!this.running || !this.ctx) return;
    const ms = (chunk.length / this.ctx.sampleRate) * 1000;
    let sum = 0;
    for (const v of chunk) sum += v * v;
    const level = Math.sqrt(sum / chunk.length);
    this.o.onLevel(Math.min(1, level * 6));

    // Порог с гистерезисом: начать фразу труднее, чем продолжить (тихие хвосты слов не теряются). Нижняя граница — чтобы тихий голос не пропадал.
    const startThr = Math.max(0.006, this.noiseFloor * 2.6);
    // Внутри фразы порог растёт вместе с её громкостью (≥10% от пика): ровный фоновый шум, который автоусиление микрофона «раздувает» в паузах, не удерживает запись бесконечно.
    const keepThr = Math.max(0.004, this.noiseFloor * 1.8, this.rec ? this.peak * 0.1 : 0);
    const speaking = level > (this.rec ? keepThr : startThr);
    if (!speaking && !this.rec) this.noiseFloor = this.noiseFloor * 0.97 + level * 0.03; // подстраиваемся под шум
    if (this.rec && this.heard && level < this.peak * 0.35) this.noiseFloor = Math.min(0.05, this.noiseFloor * 0.985 + level * 0.015); // шум меняется и во время фразы

    const minSpeech = this.o.minSpeechMs ?? 160;
    const silenceLimit = this.o.silenceMs ?? 850;
    const maxMs = this.o.maxUtteranceMs ?? 20000;

    if (!this.rec) {
      // ждём речь; параллельно держим «предисторию»
      this.pre.push({ t: performance.now(), d: chunk, ms });
      this.preMs += ms;
      while (this.preMs > PRE_ROLL_MS && this.pre.length > 1) this.preMs -= this.pre.shift()!.ms;
      if (speaking) {
        this.rec = [...this.pre];
        this.recMs = this.preMs;
        this.pre = [];
        this.preMs = 0;
        this.segStart = performance.now() - this.recMs;
        this.speechFirstAt = performance.now();
        this.speechLastAt = performance.now();
        this.speechMs = ms;
        this.peak = level;
        this.silenceMs = 0;
      } else if (!this.o.continuous && Date.now() - this.startedAt > NO_SPEECH_TIMEOUT_MS) {
        this.stop(); // никто не заговорил
      }
      return;
    }

    this.rec.push({ t: performance.now(), d: chunk, ms });
    this.recMs += ms;
    if (speaking) {
      this.speechMs += ms;
      this.silenceMs = 0;
      this.speechLastAt = performance.now();
      this.peak = Math.max(this.peak, level);
      if (!this.heard && this.speechMs >= minSpeech) {
        this.heard = true;
        this.o.onState('hearing');
      }
    } else {
      this.silenceMs += ms;
    }

    // шум/щелчок: речи было слишком мало — выбрасываем и продолжаем слушать
    if (!this.heard && this.silenceMs >= 450) {
      this.reset();
      return;
    }
    if (this.heard && (this.silenceMs >= silenceLimit || this.recMs >= maxMs)) this.finish();
  }

  private finish(): void {
    const rec = this.rec;
    const rate = this.ctx?.sampleRate ?? 48000;
    const meta = { startedAt: this.speechFirstAt || this.segStart, endedAt: this.speechLastAt || performance.now() };
    const quiet = this.peak < 0.012; // почти тишина — отправлять на распознавание нет смысла
    this.reset();
    this.o.onState('listening');
    if (rec && !quiet) {
      const r = applyEchoGate(rec, meta, this.o.gate?.());
      if ('drop' in r) return void this.o.onDropped?.(r.drop);
      const chunks = r.chunks;
      meta.startedAt = r.startedAt;
      const wav = encodeWav(downsample(concat(chunks.map((c) => c.d)), rate, TARGET_RATE), Math.min(rate, TARGET_RATE));
      this.o.onUtterance(new Blob([wav as BlobPart], { type: 'audio/wav' }), meta);
    }
    if (!this.o.continuous) this.stop();
  }
}
