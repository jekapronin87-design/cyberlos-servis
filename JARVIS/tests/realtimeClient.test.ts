import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeConversation, type RtHandlers, type RtState } from '../src/renderer/voice/realtime';

// Подделка WebRTC и звука: проверяем логику событий «живого разговора» без сети и микрофона.
class FakeChannel {
  readyState = 'open';
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 'closed'; }
  emit(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
let channel: FakeChannel;
let tracksStopped = 0;

class FakePc {
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  closed = false;
  addTrack() {}
  createDataChannel() {
    channel = new FakeChannel();
    return channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() { queueMicrotask(() => channel.onopen?.()); }
  close() { this.closed = true; }
}

const analyser = () => ({ fftSize: 512, getByteTimeDomainData: (b: Uint8Array) => b.fill(128), connect() {} });
class FakeCtx {
  createAnalyser() { return analyser(); }
  createMediaStreamSource() { return { connect() {} }; }
  async close() {}
}
class FakeAudio { autoplay = false; srcObject: unknown = null; play() { return Promise.resolve(); } pause() {} }

function handlers(over: Partial<RtHandlers> = {}) {
  const log = { states: [] as RtState[], user: [] as string[], assistant: [] as string[], notes: [] as string[], ends: [] as string[], stopTask: 0, asks: [] as string[] };
  const h: RtHandlers = {
    onState: (s) => log.states.push(s),
    onUserText: (t) => log.user.push(t),
    onAssistantText: (t) => log.assistant.push(t),
    onNote: (t) => log.notes.push(t),
    onAsk: async (t) => { log.asks.push(t); return `Ответ на: ${t}`; },
    onStopTask: () => { log.stopTask++; },
    onEnd: (r) => log.ends.push(r),
    ...over,
  };
  return { h, log };
}

beforeEach(() => {
  vi.useFakeTimers();
  tracksStopped = 0;
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.RTCPeerConnection = FakePc;
  g.AudioContext = FakeCtx;
  g.Audio = FakeAudio;
  g.MediaStream = class { constructor(public t: unknown[] = []) {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [{}], getTracks: () => [{ stop: () => tracksStopped++ }] }) } } });
  g.jarvis = { realtime: { connect: vi.fn(async () => ({ sdp: 'v=0 answer', model: 'm', voice: 'v' })), ended: vi.fn() } };
});
afterEach(() => vi.useRealTimers());

async function started(over: Partial<RtHandlers> = {}) {
  const { h, log } = handlers(over);
  const c = new RealtimeConversation(h, { idleSec: 60 });
  const p = c.start();
  await vi.advanceTimersByTimeAsync(10);
  await p;
  return { c, log };
}

describe('Живой разговор: клиент', () => {
  it('подключение: отправляет SDP в основной процесс, после открытия канала — «слушаю»; ключей в клиенте нет', async () => {
    const { c, log } = await started();
    expect(c.state).toBe('listening');
    expect((globalThis as unknown as { jarvis: { realtime: { connect: ReturnType<typeof vi.fn> } } }).jarvis.realtime.connect).toHaveBeenCalledWith('v=0 offer');
    expect(log.states).toContain('connecting');
    c.stop('user');
    expect(c.state).toBe('idle');
    expect(tracksStopped).toBe(1);
    expect(log.ends).toEqual(['user']);
  });

  it('речь пользователя → «слышу», конец речи → «думаю»; реплики попадают в подписи', async () => {
    const { c, log } = await started();
    channel.emit({ type: 'input_audio_buffer.speech_started' });
    expect(c.state).toBe('hearing');
    channel.emit({ type: 'input_audio_buffer.speech_stopped' });
    expect(c.state).toBe('thinking');
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Покажи производство' });
    channel.emit({ type: 'response.output_audio_transcript.done', transcript: 'Смотрю.' });
    channel.emit({ type: 'response.done' });
    expect(c.state).toBe('listening');
    expect(log.user).toEqual(['Покажи производство']);
    expect(log.assistant).toEqual(['Смотрю.']);
    c.stop();
  });

  it('вызов ask_assistant: просьба уходит ядру, ответ возвращается моделью как function_call_output, затем response.create; повтор события не дублирует', async () => {
    const { c, log } = await started();
    const call = { type: 'response.function_call_arguments.done', name: 'ask_assistant', call_id: 'call_1', arguments: JSON.stringify({ request: 'что в производстве' }) };
    channel.emit(call);
    channel.emit({ type: 'response.output_item.done', item: { type: 'function_call', name: 'ask_assistant', call_id: 'call_1', arguments: call.arguments } });
    expect(c.state).toBe('thinking');
    await vi.advanceTimersByTimeAsync(10);
    expect(log.asks).toEqual(['что в производстве']);
    const out = channel.sent.filter((m) => m.type === 'conversation.item.create');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ item: { type: 'function_call_output', call_id: 'call_1', output: 'Ответ на: что в производстве' } });
    expect(channel.sent.at(-1)).toEqual({ type: 'response.create' });
    c.stop();
  });

  it('ошибка ядра и неизвестная функция возвращаются модели текстом, разговор не падает', async () => {
    const { c } = await started({ onAsk: async () => { throw new Error('CRM недоступна'); } });
    channel.emit({ type: 'response.function_call_arguments.done', name: 'ask_assistant', call_id: 'c1', arguments: '{"request":"x"}' });
    channel.emit({ type: 'response.function_call_arguments.done', name: 'rm_rf', call_id: 'c2', arguments: '{}' });
    await vi.advanceTimersByTimeAsync(10);
    const outs = Object.fromEntries(channel.sent.filter((m) => m.type === 'conversation.item.create').map((m) => [(m.item as { call_id: string }).call_id, (m.item as { output: string }).output]));
    expect(outs['c1']).toContain('CRM недоступна');
    expect(outs['c2']).toContain('Неизвестная функция');
    expect(c.state).not.toBe('idle');
    c.stop();
  });

  it('«стоп» отменяет ответ и задачу; «пока» заканчивает разговор после прощания', async () => {
    const { c, log } = await started();
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Стоп' });
    expect(channel.sent.map((m) => m.type)).toEqual(expect.arrayContaining(['response.cancel', 'output_audio_buffer.clear']));
    expect(log.stopTask).toBe(1);
    channel.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Ладно, пока' });
    channel.emit({ type: 'response.done' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.state).toBe('idle');
    expect(log.ends).toEqual(['goodbye']);
  });

  it('тишина дольше настройки заканчивает разговор; сообщения об ошибках OpenAI показываются без ключей', async () => {
    const { c, log } = await started();
    channel.emit({ type: 'error', error: { message: 'Bad key sk-proj-abcdef123456 rejected' } });
    expect(log.notes.at(-1)).not.toContain('abcdef123456');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(c.state).toBe('idle');
    expect(log.ends).toEqual(['idle']);
  });

  it('если соединение не открылось — понятная ошибка и освобождение микрофона', async () => {
    (globalThis as unknown as { jarvis: { realtime: { connect: unknown } } }).jarvis.realtime.connect = vi.fn(async () => { throw new Error('Error invoking remote method \'realtime:connect\': Error: OpenAI не принял ключ API голоса (401).'); });
    const { h, log } = handlers();
    const c = new RealtimeConversation(h, { idleSec: 60 });
    await expect(c.start()).rejects.toThrow(/не принял ключ/);
    expect(c.state).toBe('idle');
    expect(tracksStopped).toBe(1);
    expect(log.ends).toEqual(['error']);
  });
});
