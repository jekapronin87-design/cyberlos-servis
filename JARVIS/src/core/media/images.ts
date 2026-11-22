import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../../shared/types';
import type { AuditLog } from '../security/audit';
import type { SecretStore } from '../security/secrets';
import type { ToolRegistry } from '../tools/registry';
import { SECRET_VOICE_KEY } from '../voice/service';

export interface ImageDeps {
  getSettings: () => Pick<Settings, 'voiceBaseUrl' | 'imageModel'>;
  secrets: SecretStore;
  audit: AuditLog;
  /** Папка, куда сохраняются картинки (внутри каталога данных приложения). */
  dir: string;
  fetchImpl?: typeof fetch;
}

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;

/**
 * Генерация картинок через OpenAI-совместимый API (тот же ключ, что и для голоса).
 * Платная операция, поэтому каждый раз — с подтверждением. Файл сохраняется в папку приложения и показывается в чате.
 */
export function registerImageTool(registry: ToolRegistry, d: ImageDeps): void {
  registry.register<{ prompt: string; size?: string }>({
    name: 'image_generate',
    description:
      'Создаёт картинку по описанию (платно, каждый раз с подтверждением пользователя). Описание пиши подробно: сюжет, стиль, цвета, композиция. size: 1024x1024, 1536x1024 (горизонтальная) или 1024x1536 (вертикальная).',
    risk: 'medium',
    mutates: false,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'Подробное описание картинки' }, size: { type: 'string', enum: [...SIZES] } },
      required: ['prompt'],
    },
    describe: (i) => `Создать картинку (платный запрос к OpenAI): «${String(i.prompt).slice(0, 300)}»`,
    execute: async (i, ctx) => {
      const prompt = String(i.prompt ?? '').trim();
      if (!prompt) throw new Error('Опишите, что нарисовать');
      if (prompt.length > 3000) throw new Error('Описание длиннее 3000 символов');
      const size = (SIZES as readonly string[]).includes(i.size ?? '') ? (i.size as string) : '1024x1024';
      const key = d.secrets.get(SECRET_VOICE_KEY);
      if (!key) throw new Error('Для картинок нужен ключ OpenAI: Настройки → Голос → «API-ключ» (тот же ключ).');
      const s = d.getSettings();
      const f = d.fetchImpl ?? fetch;
      const isGpt = /^gpt-image/.test(s.imageModel);
      const res = await f(`${s.voiceBaseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: s.imageModel, prompt, size, n: 1, ...(isGpt ? {} : { response_format: 'b64_json' }) }),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]),
      }).catch(() => {
        throw new Error('Нет связи с сервисом картинок. Проверьте интернет.');
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('Ключ OpenAI не подошёл.');
        if (res.status === 429) throw new Error('Лимит или баланс OpenAI исчерпан.');
        if (res.status === 400) throw new Error('Сервис отклонил описание (возможно, оно нарушает правила сервиса). Переформулируйте.');
        throw new Error(`Ошибка сервиса картинок (${res.status}).`);
      }
      const j = (await res.json().catch(() => ({}))) as { data?: { b64_json?: string; url?: string }[] };
      let b64 = j.data?.[0]?.b64_json;
      if (!b64 && j.data?.[0]?.url) {
        const img = await f(j.data[0].url, { signal: AbortSignal.timeout(60_000) });
        b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
      }
      if (!b64) throw new Error('Сервис не вернул картинку.');
      mkdirSync(d.dir, { recursive: true });
      const file = join(d.dir, `image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      writeFileSync(file, Buffer.from(b64, 'base64'));
      d.audit.record({ actor: 'assistant', action: 'media.image_generated', decision: 'info', details: { model: s.imageModel, size, chars: prompt.length } });
      return { text: `Картинка создана и показана в чате. Файл сохранён: ${file}`, images: [{ mime: 'image/png', base64: b64, kind: 'image' }] };
    },
  });
}
