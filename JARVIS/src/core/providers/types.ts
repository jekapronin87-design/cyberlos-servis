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
  /** Системная подсказка БЕЗ личных данных (досье, память) — для сторонних облачных моделей. */
  systemLite?: string;
}

/** Ошибка HTTP от API модели (для понятных сообщений и переключения на запасную модель). */
export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public provider = '',
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** Служебное: какая модель реально отвечает (для интерфейса и журнала). */
  | { type: 'route'; provider: string; model: string; reason: string }
  /** Расход токенов (для счётчика расходов). */
  | { type: 'usage'; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

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
