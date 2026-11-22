// Захват речи с микрофона и выделение фраз по паузам (VAD по громкости).
// Звук никуда не отправляется отсюда: готовая фраза отдаётся вызывающему коду.

export type ListenerState = 'idle' | 'listening' | 'hearing';

export interface ListenerOptions {
  /** true — слушать постоянно (режим «Системно»); false — одна фраза и остановка. */
  continuous: boolean;
  onState(s: ListenerState): void;
  onLevel(level: number): void;
  onUtterance(blob: Blob, meta: { startedAt: number; endedAt: number }): void;
  onError(message: string): void;
  /** Для тестов. */
  minSpeechMs?: number;
  silenceMs?: number;
  maxUtteranceMs?: number;
}

const POLL_MS = 50;
const NO_SPEECH_TIMEOUT_MS = 8000;
const IDLE_ROLLOVER_MS = 1500;

export class VoiceListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  /** Куски записи текущей фразы; у каждого MediaRecorder — свой массив. */
  private chunks: Blob[] = [];
  private timer: number | null = null;
  private noiseFloor = 0.01;
  private speechMs = 0;
  private silenceMs = 0;
  private segmentMs = 0;
  private heard = false;
  private running = false;
  private startedAt = 0;
  private segStart = 0;
  /** Момент, когда в фразе впервые прозвучала речь, и момент последней речи (без тишины вокруг). */
  private speechFirstAt = 0;
  private speechLastAt = 0;

  constructor(private o: ListenerOptions) {}

  get active(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.running = true;
    this.startedAt = Date.now();
    this.o.onState('listening');
    this.beginSegment();
    this.timer = window.setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (!this.running && !this.stream) return;
    this.running = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.discardSegment();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.o.onLevel(0);
    this.o.onState('idle');
  }

  private rms(): number {
    const a = this.analyser!;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  private beginSegment(): void {
    if (!this.stream) return;
    const chunks: Blob[] = [];
    this.chunks = chunks;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.segmentMs = 0;
    this.heard = false;
    this.segStart = performance.now();
    this.speechFirstAt = 0;
    this.speechLastAt = 0;
    const rec = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    this.recorder = rec;
    rec.start();
  }

  private discardSegment(): void {
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      rec.stop();
    }
    this.chunks = [];
  }

  /** Завершить текущую фразу и отдать её наружу. */
  private finishSegment(): void {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    const chunks = this.chunks;
    // Для определения эха важна длительность самой речи, а не записи с тишиной вокруг.
    const meta = { startedAt: this.speechFirstAt || this.segStart, endedAt: this.speechLastAt || performance.now() };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size > 0) this.o.onUtterance(blob, meta);
    };
    rec.stop();
  }

  private tick(): void {
    if (!this.running || !this.analyser) return;
    const level = this.rms();
    this.o.onLevel(Math.min(1, level * 6));
    const threshold = Math.max(0.02, this.noiseFloor * 3);
    const speaking = level > threshold;
    const minSpeech = this.o.minSpeechMs ?? 250;
    const silenceLimit = this.o.silenceMs ?? 900;
    const maxMs = this.o.maxUtteranceMs ?? 15000;

    if (!speaking) this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05; // подстраиваемся под шум
    this.segmentMs += POLL_MS;

    if (speaking) {
      const nowT = performance.now();
      if (!this.speechFirstAt) this.speechFirstAt = nowT;
      this.speechLastAt = nowT;
      this.speechMs += POLL_MS;
      this.silenceMs = 0;
      if (!this.heard && this.speechMs >= minSpeech) {
        this.heard = true;
        this.o.onState('hearing');
      }
    } else if (this.heard) {
      this.silenceMs += POLL_MS;
    }

    if (this.heard && (this.silenceMs >= silenceLimit || this.segmentMs >= maxMs)) {
      this.finishSegment();
      this.o.onState('listening');
      if (this.o.continuous) this.beginSegment();
      else this.stop();
      return;
    }
    if (!this.heard) {
      if (!this.o.continuous && Date.now() - this.startedAt > NO_SPEECH_TIMEOUT_MS) {
        this.stop(); // никто не заговорил
        return;
      }
      if (this.segmentMs >= IDLE_ROLLOVER_MS) {
        this.discardSegment();
        this.beginSegment(); // не копим тишину в памяти
      }
    }
  }
}
