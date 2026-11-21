import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleTts } from '../src/core/voice/service';
import { validateSettingsPatch } from '../src/core/db/repositories';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { takeSentences } from '../src/renderer/voice/speech';
import { buildSystemPrompt } from '../src/core/chat/prompt';
import { chat, makeCore } from './helpers';
import type { ChatProvider, ProviderEvent, ProviderRequest } from '../src/core/providers/types';

describe('новые настройки', () => {
  it('значения по умолчанию безопасны: камера, автопрослушивание и автозапуск выключены', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ cameraEnabled: false, autoListen: false, launchAtLogin: false, micEnabled: false, ttsVoice: 'onyx' });
    expect(DEFAULT_SETTINGS.ttsInstructions).toContain('Джарвис');
  });
  it('валидация', () => {
    expect(validateSettingsPatch({ cameraEnabled: true, autoListen: true, launchAtLogin: true, userName: '  Анна ' })).toEqual({ cameraEnabled: true, autoListen: true, launchAtLogin: true, userName: 'Анна' });
    expect(() => validateSettingsPatch({ cameraEnabled: 'yes' })).toThrow();
    expect(() => validateSettingsPatch({ userName: 'x'.repeat(41) })).toThrow();
    expect(() => validateSettingsPatch({ userName: 'a\nb' })).toThrow();
    expect(() => validateSettingsPatch({ ttsInstructions: 'x'.repeat(501) })).toThrow();
    expect(() => validateSettingsPatch({ systemVoice: 5 })).toThrow();
  });
  it('имя пользователя попадает в системный промпт, и просьба говорить разговорно', () => {
    const p = buildSystemPrompt({ settings: { customInstructions: '', memoryEnabled: true, userName: 'Евгений' }, memory: [] });
    expect(p).toContain('Евгений');
    expect(p).toMatch(/озвучиваются вслух/);
    expect(buildSystemPrompt({ settings: { customInstructions: '', memoryEnabled: true }, memory: [] })).not.toContain('Пользователя зовут');
  });
});

describe('облачная озвучка: манера речи', () => {
  const capture = (): { body: Record<string, unknown>; f: typeof fetch } => {
    const box = { body: {} as Record<string, unknown> };
    const f = (async (_u: string, init: RequestInit) => {
      box.body = JSON.parse(String(init.body));
      return new Response('AUDIO');
    }) as unknown as typeof fetch;
    return { get body() { return box.body; }, f } as never;
  };
  it('передаёт instructions только модели gpt-4o-mini-tts', async () => {
    const a = capture();
    await new OpenAiCompatibleTts({ baseUrl: 'https://x', apiKey: 'k', model: 'gpt-4o-mini-tts', voice: 'onyx', instructions: 'спокойно' }, a.f).synthesize('привет');
    expect(a.body).toMatchObject({ voice: 'onyx', instructions: 'спокойно' });
    const b = capture();
    await new OpenAiCompatibleTts({ baseUrl: 'https://x', apiKey: 'k', model: 'tts-1', voice: 'onyx', instructions: 'спокойно' }, b.f).synthesize('привет');
    expect(b.body).not.toHaveProperty('instructions');
  });
});

describe('деление ответа на предложения для потоковой озвучки', () => {
  it('отдаёт только законченные предложения, остаток копится', () => {
    let r = takeSentences('Добрый вечер, сэр. Сегодня в Москве ясно и тепло', false);
    expect(r.sentences).toEqual(['Добрый вечер, сэр.']);
    expect(r.rest).toBe('Сегодня в Москве ясно и тепло');
    r = takeSentences(r.rest + ', около десяти градусов. А', false);
    expect(r.sentences).toEqual(['Сегодня в Москве ясно и тепло, около десяти градусов.']);
    r = takeSentences(r.rest + ' завтра дождь', true);
    expect(r.sentences).toEqual(['А завтра дождь']);
    expect(r.rest).toBe('');
  });
  it('короткие обрывки склеиваются со следующим предложением', () => {
    const r = takeSentences('Да. Конечно, сейчас всё сделаю. ', false);
    expect(r.sentences.join(' ')).toContain('Да. Конечно');
  });
  it('без знака конца в потоке ничего не отдаётся до конца ответа', () => {
    expect(takeSentences('Привет как дела', false).sentences).toEqual([]);
    expect(takeSentences('Привет как дела', true).sentences).toEqual(['Привет как дела']);
  });
});

describe('камера (инструмент camera_look)', () => {
  const frame = { mime: 'image/jpeg', base64: Buffer.from('FACE').toString('base64'), width: 4, height: 4 };

  it('без выключателя в настройках отказывает и кадр не снимается', async () => {
    let shots = 0;
    const h = makeCore({ host: { captureCamera: async () => (shots++, frame) } });
    const res = await Promise.resolve(h.core.tools.get('camera_look')!.execute({}, { conversationId: 1, runId: 'r', signal: new AbortController().signal })).then(() => 'ok', (e: Error) => e.message);
    expect(res).toMatch(/Камера выключена/);
    expect(shots).toBe(0);
  });

  it('с выключателем: кадр без окна подтверждения (согласие — включённая камера), хранится как «camera», чистится при перезапуске', async () => {
    const seen: boolean[] = [];
    let step = 0;
    const p: ChatProvider = {
      id: 'v',
      name: 'v',
      async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        step++;
        if (step === 1) yield { type: 'tool_use', id: 'c1', name: 'camera_look', input: {} };
        else {
          const r = req.messages.at(-1)!.content.find((b) => b.type === 'tool_result');
          seen.push(r?.type === 'tool_result' && !!r.images?.length);
          yield { type: 'text', text: 'Вы улыбаетесь.' };
        }
      },
    };
    const h = makeCore({ host: { captureCamera: async () => frame }, liveProvider: p });
    h.secrets.set('anthropic.apiKey', 'sk-ant-test-key-1234567890');
    h.core.updateSettings({ cameraEnabled: true });
    const { id } = await chat(h, 'Джарвис, что я сейчас делаю?');
    expect(h.confirms).toHaveLength(0);
    expect(seen).toEqual([true]); // модель получила изображение
    const tool = h.core.messages(id).find((m) => m.role === 'tool')!.content[0] as { imageIds: number[] };
    const row = h.core.db.prepare('SELECT kind FROM attachments WHERE id = ?').get(tool.imageIds[0]!) as { kind: string };
    expect(row.kind).toBe('camera');
    expect(h.core.listAudit().some((a) => a.target === 'camera_look' && a.decision === 'allowed')).toBe(true);
    // перезапуск приложения: кадры камеры удаляются
    h.core.attachments.purgeKind('camera');
    expect(h.core.getAttachment(tool.imageIds[0]!)).toBeNull();
  });

  it('инструмента нет, если ОС не предоставила камеру', () => {
    expect(makeCore().core.tools.get('camera_look')).toBeUndefined();
  });
});
