import type { ContentBlock } from '../../shared/types';
import type { ToolSpec } from '../tools/registry';

/** Сообщение в формате, не зависящем от провайдера. role 'tool' преобразуется адаптером. */
export interface ProviderMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: ToolSpec[];
  model: string;
  maxTokens: number;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

/**
 * Контракт ИИ-провайдера. Новые провайдеры (локальные модели, другие API) добавляются
 * реализацией этого интерфейса и регистрацией в ProviderRegistry.
 */
export interface ChatProvider {
  readonly id: string;
  readonly name: string;
  /** Поток событий ответа. Обязан прекращать работу при signal.abort(). */
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
