// «Живой разговор»: голос в голос через OpenAI Realtime (WebRTC). Микрофон → модель → голос, без пауз «распознал → подумал → озвучил».
// Ключ API в этом файле не появляется: соединение устанавливает основной процесс (IPC realtime.connect).
import { isEndPhrase, isStopPhrase } from '../../shared/voice';

export type RtState = 'idle' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking';
export type RtEndReason = 'user' | 'idle' | 'error' | 'goodbye';

export interface RtHandlers {
  onState(s: RtState): void;
  onUserText(text: string): void;
  onAssistantText(text: string): void;
  /** Нештатные сообщения (не фатальные) и итог. */
  onNote(text: string, kind?: 'info' | 'warn'): void;
  /** Функция ask_assistant: выполнить просьбу ядром ассистента и вернуть текст ответа. */
  onAsk(request: string): Promise<string>;
  /** Голосовое «стоп»: остановить выполняемую задачу. */
  onStopTask(): void;
  onEnd(reason: RtEndReason, seconds: number): void;
}

interface RtEvent {
  type?: string;
  transcript?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  error?: { message?: string; code?: string };
}

const OUT_LOUD = 0.03;

export class RealtimeConversation {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private inAn: AnalyserNode | null = null;
  private outAn: AnalyserNode | null = null;
  private timer = 0;
  private startedAt = 0;
  private lastActivity = 0;
  private lastOutLoud = -Infinity;
  private userSpeaking = false;
  private responsePending = false;
  private toolBusy = 0;
  private endAfterReply = false;
  private handled = new Set<string>();
  private _state: RtState = 'idle';
  private stopped = false;
  private lostSince = 0;

  constructor(
    private h: RtHandlers,
    private opts: { idleSec: number },
  ) {}

  get state(): RtState {
    return this._state;
  }
  get active(): boolean {
    return this._state !== 'idle';
  }
  /** Сколько секунд осталось до автозавершения разговора из-за тишины. */
  get idleLeft(): number {
    return Math.max(0, Math.round(this.opts.idleSec - (Date.now() - this.lastActivity) / 1000));
  }

  private rms(an: AnalyserNode | null): number {
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 5);
  }

  /** Текущая «громкость» для шара: что говорит ассистент или что слышит микрофон. */
  level(): number {
    return this._state === 'speaking' ? this.rms(this.outAn) : this._state === 'hearing' || this._state === 'listening' ? this.rms(this.inAn) : 0;
  }

  private setState(s: RtState): void {
    if (s === this._state) return;
    this._state = s;
    this.h.onState(s);
  }

  /** Состояние выводится из набора признаков — так оно не «залипает», если какое-то событие не пришло. */
  private refresh(): void {
    if (this.stopped || this._state === 'connecting') return;
    const speaking = performance.now() - this.lastOutLoud < 600;
    this.setState(this.toolBusy > 0 ? 'thinking' : speaking ? 'speaking' : this.userSpeaking ? 'hearing' : this.responsePending ? 'thinking' : 'listening');
  }

  async start(): Promise<void> {
    this.setState('connecting');
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.ctx = new AudioContext();
      const audioEl = new Audio();
      audioEl.autoplay = true;
      this.audioEl = audioEl;
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        audioEl.srcObject = stream;
        void audioEl.play().catch(() => undefined);
        if (this.ctx) {
          this.outAn = this.ctx.createAnalyser();
          this.outAn.fftSize = 512;
          this.ctx.createMediaStreamSource(stream).connect(this.outAn); // только для анализа уровня: звук играет <audio>
        }
      };
      if (this.ctx) {
        this.inAn = this.ctx.createAnalyser();
        this.inAn.fftSize = 512;
        this.ctx.createMediaStreamSource(this.mic).connect(this.inAn);
      }
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (m) => this.onMessage(m.data);
      const opened = new Promise<void>((resolve, reject) => {
        const to = window.setTimeout(() => reject(new Error('Соединение с OpenAI не установилось за 15 секунд. Проверьте интернет (и что не мешает VPN или брандмауэр).')), 15_000);
        dc.onopen = () => {
          window.clearTimeout(to);
          resolve();
        };
        dc.onclose = () => this.onLost('Канал связи закрыт.');
      });
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.onLost('Соединение потеряно.');
        else if (pc.connectionState === 'disconnected') this.lostSince = Date.now();
        else this.lostSince = 0;
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await window.jarvis.realtime.connect(offer.sdp ?? '');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await opened;
      this.lastActivity = Date.now();
      this.setState('listening');
      this.timer = window.setInterval(() => this.tick(), 250);
      this.h.onNote('Живой разговор включён. Говорите — «пока» закончит разговор.');
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Не удалось начать живой разговор';
      this.teardown();
      this.h.onNote(msg, 'warn');
      this.h.onEnd('error', 0);
      throw new Error(msg);
    }
  }

  private tick(): void {
    if (this.stopped) return;
    // Звучит ли ассистент: смотрим на уровень входящего звука (надёжнее, чем ждать событий)
    if (this.rms(this.outAn) * 0.2 > OUT_LOUD) {
      this.lastOutLoud = performance.now();
      this.lastActivity = Date.now();
    }
    if (this.lostSince && Date.now() - this.lostSince > 6000) return this.onLost('Соединение прервалось.');
    this.refresh();
    if (this._state === 'listening' && Date.now() - this.lastActivity > this.opts.idleSec * 1000) {
      this.h.onNote('Разговор закончился (долгая тишина). Нажмите на микрофон, чтобы продолжить.', 'info');
      this.stop('idle');
    }
  }

  private send(o: unknown): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(o));
  }

  private onMessage(data: unknown): void {
    let ev: RtEvent;
    try {
      ev = JSON.parse(String(data)) as RtEvent;
    } catch {
      return;
    }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        this.lastActivity = Date.now();
        this.refresh();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.responsePending = true;
        this.refresh();
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const t = (ev.transcript ?? '').trim();
        if (!t) break;
        this.h.onUserText(t);
        this.lastActivity = Date.now();
        if (isStopPhrase(t)) {
          this.send({ type: 'response.cancel' });
          this.send({ type: 'output_audio_buffer.clear' });
          this.h.onStopTask();
        } else if (isEndPhrase(t)) {
          this.endAfterReply = true;
          window.setTimeout(() => this.endAfterReply && this.stop('goodbye'), 7000);
        }
        break;
      }
      case 'response.created':
        this.responsePending = true;
        this.refresh();
        break;
      case 'response.output_audio_transcript.delta':
        this.lastActivity = Date.now();
        break;
      case 'response.output_audio_transcript.done':
        if (ev.transcript?.trim()) this.h.onAssistantText(ev.transcript.trim());
        break;
      case 'response.done':
        this.responsePending = false;
        this.refresh();
        if (this.endAfterReply) window.setTimeout(() => this.stop('goodbye'), 3500); // дать договорить прощание
        break;
      case 'response.function_call_arguments.done':
        if (ev.name && ev.call_id) void this.callTool(ev.name, ev.call_id, ev.arguments ?? '');
        break;
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call' && ev.item.name && ev.item.call_id) void this.callTool(ev.item.name, ev.item.call_id, ev.item.arguments ?? '');
        break;
      case 'error': {
        const m = (ev.error?.message ?? 'ошибка').replace(/\b(sk|ek|sess)[-_][A-Za-z0-9_*.-]{4,}/g, '[ключ]').slice(0, 200);
        this.h.onNote(`OpenAI: ${m}`, 'warn');
        break;
      }
      default:
        break;
    }
  }

  private async callTool(name: string, callId: string, args: string): Promise<void> {
    if (this.handled.has(callId)) return;
    this.handled.add(callId);
    this.toolBusy += 1;
    this.lastActivity = Date.now();
    this.refresh();
    let out = '';
    try {
      if (name !== 'ask_assistant') throw new Error('Неизвестная функция');
      const req = String((JSON.parse(args || '{}') as { request?: unknown }).request ?? '').trim();
      if (!req) throw new Error('Пустая просьба');
      out = await Promise.race([
        this.h.onAsk(req),
        new Promise<string>((resolve) => window.setTimeout(() => resolve('Ассистент не успел ответить за 3 минуты. Скажи пользователю, что задача ещё выполняется или не удалась.'), 180_000)),
      ]);
    } catch (e) {
      out = `Ошибка: ${e instanceof Error ? e.message : 'не удалось выполнить'}`;
    } finally {
      this.toolBusy -= 1;
    }
    if (this.stopped) return;
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: out.slice(0, 6000) } });
    this.send({ type: 'response.create' });
    this.responsePending = true;
    this.lastActivity = Date.now();
    this.refresh();
  }

  private onLost(why: string): void {
    if (this.stopped) return;
    this.h.onNote(`${why} Разговор завершён — нажмите на микрофон, чтобы начать снова.`, 'warn');
    this.stop('error');
  }

  stop(reason: RtEndReason = 'user'): void {
    if (this.stopped) return;
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    this.teardown();
    this.h.onEnd(reason, seconds);
  }

  private teardown(): void {
    this.stopped = true;
    window.clearInterval(this.timer);
    try {
      this.dc?.close();
    } catch {
      /* уже закрыт */
    }
    try {
      this.pc?.close();
    } catch {
      /* уже закрыт */
    }
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
    }
    void this.ctx?.close().catch(() => undefined);
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audioEl = null;
    this.ctx = null;
    this.inAn = this.outAn = null;
    this.userSpeaking = false;
    this.responsePending = false;
    this._state = 'idle';
    this.h.onState('idle');
  }
}

/** Проверка без разговора: создаёт сессию и сразу закрывает (звук не передаётся, ничего не тратится сверх запроса сессии). */
export async function testRealtime(): Promise<string> {
  const pc = new RTCPeerConnection();
  try {
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.createDataChannel('oai-events');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const a = await window.jarvis.realtime.connect(offer.sdp ?? '');
    return `Живой разговор доступен: модель ${a.model}, голос ${a.voice}.`;
  } finally {
    pc.close();
  }
}
