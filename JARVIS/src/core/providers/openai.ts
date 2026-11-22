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

export interface OpenAiCompatOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  /** Локальная модель (Ollama/LM Studio): данные не покидают компьютер, первый ответ может быть долгим (загрузка модели). */
  local: boolean;
  fetchImpl?: Fetch;
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
        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
        : {}),
    };
    const timeout = AbortSignal.timeout(this.local ? 300_000 : 120_000);
    let res: Response;
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
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, text.slice(0, 200), this.id);
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
export function describeProviderHttp(e: ProviderHttpError): string {
  if (e.status === 0) return e.message;
  if (e.status === 401 || e.status === 403) return `Ключ для «${e.provider}» не подошёл. Проверьте его в настройках.`;
  if (e.status === 404) return `Модель или адрес для «${e.provider}» не найдены. Проверьте название модели.`;
  if (e.status === 429) return `Лимит бесплатных запросов «${e.provider}» исчерпан. Попробуйте позже.`;
  if (e.status >= 500) return `Сервис «${e.provider}» временно недоступен.`;
  return `Ошибка «${e.provider}» (${e.status}).`;
}
