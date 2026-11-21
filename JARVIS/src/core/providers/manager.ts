import type { Settings } from '../../shared/types';
import type { SecretStore } from '../security/secrets';
import { SECRET_ANTHROPIC_KEY } from '../security/secrets';
import { AnthropicProvider } from './anthropic';
import { DemoProvider } from './demo';
import type { ChatProvider } from './types';

export interface ResolvedProvider {
  provider: ChatProvider;
  mode: 'demo' | 'live';
  /** Почему выбран именно этот провайдер (для отображения в интерфейсе). */
  note?: string;
}

/** Выбирает провайдера по настройкам и наличию ключа. Без ключа всегда работает демо-режим. */
export class ProviderManager {
  private demo: ChatProvider;
  private anthropic: { key: string; provider: AnthropicProvider } | null = null;

  constructor(
    private secrets: SecretStore,
    private env: Record<string, string | undefined> = process.env,
    demo?: ChatProvider,
    /** Для тестов: подменяет облачного провайдера. */
    private liveOverride?: ChatProvider,
  ) {
    this.demo = demo ?? new DemoProvider();
  }

  apiKey(): string | null {
    return this.secrets.get(SECRET_ANTHROPIC_KEY) ?? (this.env.ANTHROPIC_API_KEY?.trim() || null);
  }

  resolve(settings: Pick<Settings, 'provider'>): ResolvedProvider {
    if (settings.provider === 'demo') return { provider: this.demo, mode: 'demo', note: 'Выбран демо-режим' };
    const key = this.apiKey();
    if (!key) {
      return {
        provider: this.demo,
        mode: 'demo',
        note: 'API-ключ не задан — работает демо-режим',
      };
    }
    if (this.liveOverride) return { provider: this.liveOverride, mode: 'live' };
    if (!this.anthropic || this.anthropic.key !== key) {
      this.anthropic = { key, provider: new AnthropicProvider(key) };
    }
    return { provider: this.anthropic.provider, mode: 'live' };
  }
}
