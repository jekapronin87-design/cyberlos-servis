import type { Settings } from '../../shared/types';
import { isPromptLeak } from '../../shared/voice';
import type { AuditLog } from '../security/audit';
import type { SecretStore } from '../security/secrets';

export const SECRET_VOICE_KEY = 'voice.apiKey';
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const MAX_TTS_CHARS = 4000;

type Fetch = typeof fetch;

/** Контракты, позволяющие подключать любых провайдеров речи. */
export interface SpeechToText {
  transcribe(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<string>;
}
export interface TextToSpeech {
  synthesize(text: string, signal?: AbortSignal): Promise<{ mime: string; data: Uint8Array }>;
}

const extFor = (mime: string): string => (mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm');

/** Сигнал отмены с таймаутом: зависший запрос к голосовому API не должен блокировать очередь фраз. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function friendly(e: unknown): Error {
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new Error('Сервис голоса не ответил вовремя. Проверьте интернет.');
  if (e instanceof TypeError) return new Error('Нет связи с сервисом голоса. Проверьте интернет и адрес API в настройках.');
  return e instanceof Error ? e : new Error(String(e));
}

async function apiError(res: Response): Promise<Error> {
  if (res.status === 401) return new Error('Неверный ключ API голоса. Проверьте его в настройках.');
  if (res.status === 429) return new Error('Превышен лимит запросов к API голоса.');
  if (res.status === 404) return new Error('Адрес или модель API голоса не найдены. Проверьте настройки.');
  return new Error(`Ошибка API голоса (${res.status}).`);
}

/** Распознавание речи через OpenAI-совместимый эндпоинт /audio/transcriptions. */
export class OpenAiCompatibleStt implements SpeechToText {
  constructor(
    private cfg: { baseUrl: string; apiKey: string; model: string; hint?: string },
    private fetchImpl: Fetch = fetch,
  ) {}

  async transcribe(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart], { type: mime }), `speech.${extFor(mime)}`);
    form.append('model', this.cfg.model);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    form.append('temperature', '0'); // без «фантазий» на неразборчивой речи
    // Подсказка словаря повышает шанс правильно услышать имя ассистента.
    if (this.cfg.hint) form.append('prompt', this.cfg.hint);
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
      signal: withTimeout(signal, 60_000),
    }).catch((e: unknown) => {
      throw friendly(e);
    });
    if (!res.ok) throw await apiError(res);
    const json = (await res.json()) as { text?: unknown };
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    return this.cfg.hint && isPromptLeak(text, this.cfg.hint) ? '' : text;
  }
}

/** Синтез речи через OpenAI-совместимый эндпоинт /audio/speech. */
export class OpenAiCompatibleTts implements TextToSpeech {
  constructor(
    private cfg: { baseUrl: string; apiKey: string; model: string; voice: string; instructions?: string },
    private fetchImpl: Fetch = fetch,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<{ mime: string; data: Uint8Array }> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        voice: this.cfg.voice,
        input: text,
        response_format: 'mp3',
        // Стиль речи поддерживает только gpt-4o-mini-tts
        ...(this.cfg.instructions && /gpt-4o-mini-tts/.test(this.cfg.model) ? { instructions: this.cfg.instructions } : {}),
      }),
      signal: withTimeout(signal, 30_000),
    }).catch((e: unknown) => {
      throw friendly(e);
    });
    if (!res.ok) throw await apiError(res);
    return { mime: 'audio/mpeg', data: new Uint8Array(await res.arrayBuffer()) };
  }
}

/**
 * Голосовой сервис ядра: проверяет главный выключатель микрофона, лимиты, пишет в журнал
 * (без текста разговоров — только длительность/размер) и вызывает выбранный API.
 * Ключ берётся из хранилища секретов и никогда не уходит в интерфейс.
 */
export class VoiceService {
  constructor(
    private deps: {
      getSettings: () => Settings;
      secrets: SecretStore;
      audit: AuditLog;
      fetchImpl?: Fetch;
    },
  ) {}

  hasKey(): boolean {
    return this.deps.secrets.has(SECRET_VOICE_KEY);
  }

  private key(): string {
    const k = this.deps.secrets.get(SECRET_VOICE_KEY);
    if (!k) throw new Error('Не задан ключ API голоса. Добавьте его в «Настройки → Голос».');
    return k;
  }

  async transcribe(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
    const s = this.deps.getSettings();
    if (!s.micEnabled) throw new Error('Микрофон выключен в настройках.');
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw new Error('Пустая запись.');
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error('Запись слишком длинная.');
    if (!/^audio\/[\w.+-]+(;.*)?$/.test(mime)) throw new Error('Неподдерживаемый формат звука.');
    const stt = new OpenAiCompatibleStt({ baseUrl: s.voiceBaseUrl, apiKey: this.key(), model: s.sttModel, hint: `${s.assistantName}, Джарвис.` }, this.deps.fetchImpl);
    try {
      const text = await stt.transcribe(audio, mime, signal);
      this.deps.audit.record({ actor: 'user', action: 'voice.transcribe', decision: 'info', details: { bytes: audio.byteLength, chars: text.length } });
      return text;
    } catch (e) {
      this.deps.audit.record({ actor: 'system', action: 'voice.transcribe', decision: 'error', details: { bytes: audio.byteLength } });
      throw e;
    }
  }

  /** Расшифровка ФАЙЛА с отметками времени слов (для субтитров). Не связана с микрофоном: звук берётся из видео пользователя. */
  async transcribeWords(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<{ text: string; words: { w: string; s: number; e: number }[] }> {
    const s = this.deps.getSettings();
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw new Error('Пустое аудио.');
    if (audio.byteLength > 24 * 1024 * 1024) throw new Error('Звук слишком длинный для расшифровки (лимит сервиса — 25 МБ, около 100 минут).');
    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart], { type: mime }), `speech.${mime.includes('wav') ? 'wav' : 'mp3'}`);
    form.append('model', 'whisper-1'); // только эта модель отдаёт время каждого слова
    form.append('language', 'ru');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('temperature', '0');
    const f = this.deps.fetchImpl ?? fetch;
    const res = await f(`${s.voiceBaseUrl}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${this.key()}` }, body: form, signal: withTimeout(signal, 180_000) }).catch((e: unknown) => {
      throw friendly(e);
    });
    if (!res.ok) throw await apiError(res);
    const j = (await res.json().catch(() => ({}))) as { text?: unknown; words?: { word?: unknown; start?: unknown; end?: unknown }[] };
    const words = (j.words ?? []).filter((w) => typeof w.word === 'string' && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end))).map((w) => ({ w: String(w.word).trim(), s: Number(w.start), e: Number(w.end) }));
    this.deps.audit.record({ actor: 'user', action: 'voice.transcribe_file', decision: 'info', details: { bytes: audio.byteLength, words: words.length } });
    return { text: typeof j.text === 'string' ? j.text : '', words };
  }

  async speak(text: string, signal?: AbortSignal): Promise<{ mime: string; data: Uint8Array }> {
    const s = this.deps.getSettings();
    if (s.ttsMode !== 'api') throw new Error('Облачная озвучка выключена.');
    const t = text.trim();
    if (!t) throw new Error('Нечего озвучивать.');
    if (t.length > MAX_TTS_CHARS) throw new Error('Текст для озвучки слишком длинный.');
    const tts = new OpenAiCompatibleTts({ baseUrl: s.voiceBaseUrl, apiKey: this.key(), model: s.ttsModel, voice: s.ttsVoice, instructions: s.ttsInstructions }, this.deps.fetchImpl);
    const out = await tts.synthesize(t, signal);
    this.deps.audit.record({ actor: 'assistant', action: 'voice.speak', decision: 'info', details: { chars: t.length } });
    return out;
  }
}
