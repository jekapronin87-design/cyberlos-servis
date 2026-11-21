import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, ProviderEvent, ProviderMessage, ProviderRequest } from './types';

type ApiMessage = Anthropic.MessageParam;

/** Преобразует внутренние сообщения в формат Anthropic Messages API. */
export function toAnthropicMessages(messages: ProviderMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Anthropic.ContentBlockParam[]): void => {
    if (blocks.length === 0) return;
    const prev = out[out.length - 1];
    // API требует чередования ролей — склеиваем соседние сообщения одной роли.
    if (prev && prev.role === role && Array.isArray(prev.content)) {
      (prev.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
      push('assistant', blocks);
    } else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_result') {
          blocks.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError || b.denied });
        }
      }
      push('user', blocks);
    }
  }
  return out;
}

/** Провайдер Anthropic (Claude). Ключ передаётся из SecretStore и нигде не логируется. */
export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      },
      { signal },
    );

    const queue: ProviderEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;
    const notify = (): void => {
      wake?.();
      wake = null;
    };

    stream.on('text', (t) => {
      queue.push({ type: 'text', text: t });
      notify();
    });
    stream
      .finalMessage()
      .then((msg) => {
        for (const b of msg.content) {
          if (b.type === 'tool_use') {
            queue.push({ type: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
          }
        }
      })
      .catch((e: unknown) => {
        failure = e;
      })
      .finally(() => {
        finished = true;
        notify();
      });

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((r) => (wake = r));
    }
    if (signal.aborted) return;
    if (failure) throw failure;
  }
}

/** Понятное пользователю сообщение об ошибке API (без утечки ключа). */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401) return 'Неверный API-ключ Anthropic. Проверьте ключ в настройках.';
    if (err.status === 403) return 'Доступ к API запрещён для этого ключа.';
    if (err.status === 404) return 'Модель не найдена. Проверьте название модели в настройках.';
    if (err.status === 429) return 'Превышен лимит запросов API. Попробуйте позже.';
    if (err.status && err.status >= 500) return 'Сервис Anthropic временно недоступен. Попробуйте позже.';
    return `Ошибка API (${err.status ?? 'нет статуса'}).`;
  }
  if (err instanceof Anthropic.APIConnectionError) return 'Нет соединения с API. Проверьте интернет.';
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}
