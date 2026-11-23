import type { ChatProvider, ProviderEvent, ProviderMessage, ProviderRequest } from './types';
import { ProviderHttpError } from './types';

type Fetch = typeof fetch;

interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Внутренний формат → формат OpenAI Chat Completions. Изображения не передаются (большинство бесплатных моделей их не принимает). */
export function toOpenAiMessages(system: string, messages: ProviderMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const calls: OaiToolCall[] = m.content
        .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text.trim() && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text.trim() ? text : null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const note = b.images?.length || b.imageIds?.length ? '\n[к результату приложено изображение — эта модель его не видит]' : '';
          out.push({ role: 'tool', tool_call_id: b.toolUseId, content: (b.content || '(пусто)') + note });
        } else if (b.type === 'text' && b.text.trim()) {
          out.push({ role: 'user', content: b.text });
        }
      }
    }
  }
  return out;
}

/**
 * Схема параметров инструмента в виде, понятном и «строгим» OpenAI-совместимым API (Gemini, Groq, Ollama): без additionalProperties/$schema/default,
 * тип-списки превращаются в один тип, у массивов есть items. Пустые параметры (нет полей) не передаются вовсе — Gemini отвечает на них ошибкой.
 */
export function cleanSchema(s: unknown): Record<string, unknown> | undefined {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o = { ...(v as Record<string, unknown>) };
    delete o['additionalProperties'];
    delete o['$schema'];
    delete o['default'];
    if (Array.isArray(o['type'])) o['type'] = (o['type'] as string[]).find((t) => t !== 'null') ?? 'string';
    if (o['type'] === 'array' && !o['items']) o['items'] = { type: 'string' };
    if (o['properties'] && typeof o['properties'] === 'object') o['properties'] = Object.fromEntries(Object.entries(o['properties'] as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    if (o['items']) o['items'] = walk(o['items']);
    return o;
  };
  const r = walk(s) as Record<string, unknown>;
  const props = r['properties'] as Record<string, unknown> | undefined;
  if (!props || Object.keys(props).length === 0) return undefined;
  // объект без вложенных полей (например, свободный словарь) для строгих API превращаем в строку
  for (const [k, p] of Object.entries(props)) {
    const pp = p as Record<string, unknown>;
    if (pp['type'] === 'object' && !pp['properties']) props[k] = { type: 'string', description: `${String(pp['description'] ?? k)} (JSON-строка)` };
  }
  return r;
}

export interface OpenAiCompatOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Локальная модель (Ollama/LM Studio): данные не покидают компьютер, первый ответ может быть долгим (загрузка модели). */
  local: boolean;
  fetchImpl?: Fetch;
  /** Пауза между повторами при 5xx/429 (мс; в тестах 0). */
  retryDelayMs?: number;
}

/** Провайдер для любого OpenAI-совместимого API: Ollama, Groq, Gemini, OpenRouter, Qwen и др. */
export class OpenAiCompatProvider implements ChatProvider {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly local: boolean;

  constructor(private o: OpenAiCompatOptions) {
    this.id = o.id;
    this.name = o.name;
    this.model = o.model;
    this.local = o.local;
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const f = this.o.fetchImpl ?? fetch;
    const system = this.local ? req.system : (req.systemLite ?? req.system);
    const body = {
      model: this.o.model,
      messages: toOpenAiMessages(system, req.messages),
      stream: true,
      max_tokens: req.maxTokens,
      ...(req.tools.length
        ? { tools: req.tools.map((t) => { const parameters = cleanSchema(t.inputSchema); return { type: 'function', function: { name: t.name, description: t.description.slice(0, 1000), ...(parameters ? { parameters } : {}) } }; }) }
        : {}),
    };
    const timeout = AbortSignal.timeout(this.local ? 300_000 : 120_000);
    let res: Response | undefined;
    // Бесплатные тарифы часто отвечают «перегружено» (503) или «слишком часто» (429) — пробуем ещё раз через пару секунд
    for (let attempt = 0; attempt < (this.local ? 1 : 3); attempt++) {
      try {
        res = await f(`${this.o.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, timeout]),
        });
      } catch (e) {
        if (signal.aborted) return;
        throw new ProviderHttpError(0, this.local ? 'Ollama не запущена или недоступна. Запустите её или отключите эту модель.' : 'Нет связи с сервисом модели.', this.id);
      }
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt === 2) break;
      await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 1500 * (attempt + 1)));
    }
    if (!res) throw new ProviderHttpError(0, 'Нет ответа от сервиса модели.', this.id);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, text.slice(0, 800), this.id);
    }
    if (!res.body) throw new ProviderHttpError(502, 'Пустой ответ', this.id);

    const calls = new Map<number, { id: string; name: string; args: string }>();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j: { choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          const d = j.choices?.[0]?.delta;
          if (!d) continue;
          if (typeof d.content === 'string' && d.content) yield { type: 'text', text: d.content };
          for (const tc of d.tool_calls ?? []) {
            const i = tc.index ?? 0;
            const cur = calls.get(i) ?? { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(i, cur);
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      throw new ProviderHttpError(0, 'Связь с моделью прервалась.', this.id);
    }
    if (signal.aborted) return;
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue;
      let input: Record<string, unknown> = {};
      try {
        const v = JSON.parse(c.args || '{}') as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) input = v as Record<string, unknown>;
      } catch {
        /* битые аргументы — пустой ввод: исполнитель вернёт модели ошибку проверки, и она повторит вызов */
      }
      yield { type: 'tool_use', id: c.id || `call_${Date.now()}_${i}`, name: c.name, input };
    }
  }

  /** Короткая проверка связи (кнопка «Проверить»). */
  async ping(): Promise<string> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`${this.o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.o.model, messages: [{ role: 'user', content: 'Ответь одним словом: готов' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(this.local ? 120_000 : 30_000),
    }).catch(() => {
      throw new ProviderHttpError(0, this.local ? 'Ollama не отвечает. Запущена ли она?' : 'Нет связи с сервисом.', this.id);
    });
    if (!res.ok) throw new ProviderHttpError(res.status, (await res.text().catch(() => '')).slice(0, 200), this.id);
    const j = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content?.trim() || '(пустой ответ)';
  }
}

/** Понятное сообщение для человека. */
/** Достаёт из тела ошибки сервиса короткую причину («model overloaded», «quota exceeded»…) — чтобы было понятно, что именно случилось. */
export function upstreamReason(body: string): string {
  try {
    const j = JSON.parse(body) as unknown;
    const first = Array.isArray(j) ? j[0] : j;
    const m = (first as { error?: { message?: unknown; status?: unknown } } | undefined)?.error;
    const text = typeof m?.message === 'string' ? m.message : typeof m?.status === 'string' ? m.status : '';
    return text.replace(/\s+/g, ' ').replace(/\b(AIza|sk-|gsk_)[\w-]{6,}/g, '[ключ]').slice(0, 180);
  } catch {
    return body.replace(/\s+/g, ' ').replace(/\b(AIza|sk-|gsk_)[\w-]{6,}/g, '[ключ]').slice(0, 120);
  }
}

export function describeProviderHttp(e: ProviderHttpError): string {
  if (e.status === 0) return e.message;
  const why = e.status >= 400 ? upstreamReason(e.message) : '';
  if (e.status >= 500 && /overload|unavailable|high demand|capacity/i.test(why + e.message)) return `Сервис «${e.provider}» перегружен (бесплатный тариф часто так отвечает). Подождите минуту и повторите — программа уже пробовала 3 раза${why ? `. Ответ сервиса: ${why}` : ''}.`;
  if (e.status === 401 || e.status === 403) return `Ключ для «${e.provider}» не подошёл. Проверьте его в настройках.`;
  if (e.status === 404) return `Модель или адрес для «${e.provider}» не найдены. Проверьте название модели.`;
  if (e.status === 429) return `Лимит бесплатных запросов «${e.provider}» исчерпан. Попробуйте позже.`;
  if (e.status >= 500) return `Сервис «${e.provider}» временно недоступен (${e.status})${why ? `. Ответ сервиса: ${why}` : ''}.`;
  return `Ошибка «${e.provider}» (${e.status})${why ? `: ${why}` : ''}.`;
}
