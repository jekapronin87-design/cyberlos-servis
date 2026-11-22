import type { Settings, FreeProviderId } from '../../shared/types';
import { FREE_PROVIDER_PRESETS } from '../../shared/types';
import type { SecretStore } from '../security/secrets';
import { SECRET_ANTHROPIC_KEY } from '../security/secrets';
import { AnthropicProvider } from './anthropic';
import { DemoProvider } from './demo';
import { OpenAiCompatProvider } from './openai';
import { RoutingProvider } from './router';
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
    /** Для тестов: подмена сети бесплатных моделей. */
    private fetchImpl?: typeof fetch,
  ) {
    this.demo = demo ?? new DemoProvider();
  }

  apiKey(): string | null {
    return this.secrets.get(SECRET_ANTHROPIC_KEY) ?? (this.env.ANTHROPIC_API_KEY?.trim() || null);
  }

  providerKey(id: FreeProviderId): string | null {
    return this.secrets.get(`provider.${id}.key`);
  }

  /** Включённые бесплатные модели, для которых есть всё необходимое (ключ, если он нужен). */
  freeProviders(settings: Pick<Settings, 'freeProviders'>): OpenAiCompatProvider[] {
    const out: OpenAiCompatProvider[] = [];
    for (const c of settings.freeProviders) {
      if (!c.enabled || !c.model) continue;
      const preset = FREE_PROVIDER_PRESETS.find((p) => p.id === c.id)!;
      const key = this.providerKey(c.id);
      if (preset.needsKey && !key) continue;
      out.push(new OpenAiCompatProvider({ id: c.id, name: preset.name, baseUrl: c.baseUrl, apiKey: key, model: c.model, local: preset.local, fetchImpl: this.fetchImpl }));
    }
    // Локальные — первыми: бесплатно и приватно.
    return out.sort((a, b) => Number(b.local) - Number(a.local));
  }

  resolve(settings: Pick<Settings, 'provider' | 'routingMode' | 'freeProviders' | 'model'>): ResolvedProvider {
    if (settings.provider === 'demo') return { provider: this.demo, mode: 'demo', note: 'Выбран демо-режим' };
    const key = this.apiKey();
    const free = this.freeProviders(settings);
    if (free.length > 0 && !this.liveOverride) {
      const claude = key && settings.routingMode !== 'free' ? (this.claudeFor(key)) : null;
      if (claude || settings.routingMode !== 'claude') {
        return {
          provider: new RoutingProvider({ mode: settings.routingMode, free, claude, claudeModel: settings.model }),
          mode: 'live',
          note: 'Авто: простое — бесплатные модели, сложное — Claude',
        };
      }
    }
    if (!key) {
      return {
        provider: this.demo,
        mode: 'demo',
        note: 'API-ключ не задан — работает демо-режим',
      };
    }
    if (this.liveOverride) return { provider: this.liveOverride, mode: 'live' };
    return { provider: this.claudeFor(key), mode: 'live' };
  }

  private claudeFor(key: string): AnthropicProvider {
    if (!this.anthropic || this.anthropic.key !== key) this.anthropic = { key, provider: new AnthropicProvider(key) };
    return this.anthropic.provider;
  }
}
