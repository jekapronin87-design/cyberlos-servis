import { describe, expect, it } from 'vitest';
import { realtimeInstructions, scrubKeys } from '../src/core/realtime/service';
import { makeCore } from './helpers';

const VOICE_KEY = 'sk-test-voice-key-1234567890abcdef';
const OFFER = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 456 2 IN IP4 127.0.0.1\r\ns=-\r\n';

interface Call { url: string; method: string; auth: string | null; ct: string | null; body: string }

function fake(opts: { secretStatus?: number; callStatus?: number; secretBody?: unknown } = {}) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    calls.push({ url, method: String(init.method), auth: h.get('authorization'), ct: h.get('content-type'), body: String(init.body ?? '') });
    if (url.endsWith('/realtime/client_secrets')) {
      if (opts.secretStatus && opts.secretStatus !== 200) return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${VOICE_KEY}` } }), { status: opts.secretStatus });
      return new Response(JSON.stringify(opts.secretBody ?? { value: 'ek_temporary_abc123', expires_at: 1 }), { status: 200 });
    }
    if (url.endsWith('/realtime/calls')) {
      if (opts.callStatus && opts.callStatus !== 200) return new Response('{"error":{"message":"bad sdp"}}', { status: opts.callStatus });
      return new Response(ANSWER, { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

function setup(o: Parameters<typeof fake>[0] = {}, mic = true) {
  const fk = fake(o);
  const h = makeCore({ realtimeFetch: fk.f });
  h.core.setVoiceKey(VOICE_KEY);
  if (mic) h.core.updateSettings({ micEnabled: true });
  return { h, ...fk };
}

describe('Живой разговор (OpenAI Realtime)', () => {
  it('создаёт сессию (временный ключ) и обменивает SDP; настоящий ключ — только в первом запросе, временный — во втором', async () => {
    const { h, calls } = setup();
    const r = await h.core.realtime.connect(OFFER);
    expect(r).toMatchObject({ sdp: ANSWER, model: 'gpt-realtime', voice: 'cedar' });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['POST /v1/realtime/client_secrets', 'POST /v1/realtime/calls']);
    expect(calls[0]!.auth).toBe(`Bearer ${VOICE_KEY}`);
    expect(calls[1]!.auth).toBe('Bearer ek_temporary_abc123');
    expect(calls[1]!.ct).toBe('application/sdp');
    expect(calls[1]!.body).toBe(OFFER);
    const sess = JSON.parse(calls[0]!.body).session;
    expect(sess).toMatchObject({ type: 'realtime', model: 'gpt-realtime', tool_choice: 'auto' });
    expect(sess.audio.output.voice).toBe('cedar');
    expect(sess.audio.input.transcription).toMatchObject({ language: 'ru' });
    expect(sess.audio.input.turn_detection).toMatchObject({ type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true });
    expect(sess.tools).toHaveLength(1);
    expect(sess.tools[0]).toMatchObject({ type: 'function', name: 'ask_assistant' });
    expect(sess.instructions).toContain('ask_assistant');
    expect(JSON.stringify(h.core.listAudit(100))).not.toContain(VOICE_KEY);
    expect(JSON.stringify(h.core.listAudit(100))).not.toContain('ek_temporary');
  });

  it('учитывает выбранные модель и голос; поддерживает старую форму ответа client_secret.value', async () => {
    const { h, calls } = setup({ secretBody: { client_secret: { value: 'ek_old_shape' } } });
    h.core.updateSettings({ realtimeModel: 'gpt-realtime-mini', realtimeVoice: 'marin' });
    const r = await h.core.realtime.connect(OFFER);
    expect(r).toMatchObject({ model: 'gpt-realtime-mini', voice: 'marin' });
    expect(calls[1]!.auth).toBe('Bearer ek_old_shape');
  });

  it('понятные ошибки: микрофон выключен, нет ключа, не OpenAI, плохой SDP, 401/404/429 без утечки ключа', async () => {
    const a = setup({}, false);
    await expect(a.h.core.realtime.connect(OFFER)).rejects.toThrow(/Микрофон выключен/);
    const b = makeCore({ realtimeFetch: fake().f });
    b.core.updateSettings({ micEnabled: true });
    await expect(b.core.realtime.connect(OFFER)).rejects.toThrow(/ключ API голоса/);
    const c = setup();
    c.h.core.updateSettings({ voiceBaseUrl: 'https://api.example.com/v1' });
    await expect(c.h.core.realtime.connect(OFFER)).rejects.toThrow(/только с OpenAI/);
    expect(c.calls).toHaveLength(0);
    await expect(setup().h.core.realtime.connect('not sdp')).rejects.toThrow(/Некорректное/);
    const d = setup({ secretStatus: 401 });
    await expect(d.h.core.realtime.connect(OFFER)).rejects.toThrow(/не принял ключ/);
    const e = setup({ secretStatus: 404 });
    const err404 = await e.h.core.realtime.connect(OFFER).catch((x: Error) => x.message);
    expect(err404).toMatch(/не нашёл модель/);
    expect(err404).not.toContain(VOICE_KEY);
    await expect(setup({ secretStatus: 429 }).h.core.realtime.connect(OFFER)).rejects.toThrow(/Лимит/);
    await expect(setup({ callStatus: 400 }).h.core.realtime.connect(OFFER)).rejects.toThrow(/bad sdp/);
  });

  it('настройки проверяются; журнал пишет только модель и длительность', () => {
    const { h } = setup();
    expect(() => h.core.updateSettings({ voiceEngine: 'x' as never })).toThrow(/движок/);
    expect(() => h.core.updateSettings({ realtimeModel: 'bad model!' })).toThrow(/Некорректное/);
    h.core.updateSettings({ voiceEngine: 'realtime' });
    expect(h.core.getSettings().voiceEngine).toBe('realtime');
    h.core.realtime.ended(125);
    expect(JSON.stringify(h.core.listAudit(100))).toContain('realtime.end');
  });

  it('инструкции: имя, русский язык, единственная функция; scrubKeys прячет ключи', () => {
    const t = realtimeInstructions({ assistantName: 'Системно', userName: 'Евгений' });
    expect(t).toContain('Системно');
    expect(t).toContain('Евгений');
    expect(t).toContain('по-русски');
    expect(scrubKeys(`bad key sk-proj-abcdef123456 and ek_abc12345`)).not.toMatch(/abcdef123456|abc12345/);
  });
});
