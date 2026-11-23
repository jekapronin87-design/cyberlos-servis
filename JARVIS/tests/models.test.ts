import { describe, expect, it } from 'vitest';
import { OpenAiCompatProvider, toOpenAiMessages } from '../src/core/providers/openai';
import { RoutingProvider, classify } from '../src/core/providers/router';
import { ProviderManager } from '../src/core/providers/manager';
import { MemorySecretStore } from '../src/core/security/secrets';
import type { ChatProvider, ProviderEvent, ProviderMessage, ProviderRequest } from '../src/core/providers/types';
import { ProviderHttpError } from '../src/core/providers/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { makeCore } from './helpers';

const u = (text: string): ProviderMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const sse = (chunks: unknown[]): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] });
const req = (messages: ProviderMessage[], over: Partial<ProviderRequest> = {}): ProviderRequest => ({ system: 'FULL personal', systemLite: 'LITE', messages, tools: [], model: 'claude-x', maxTokens: 100, ...over });
const collect = async (p: ChatProvider, r: ProviderRequest): Promise<ProviderEvent[]> => {
  const out: ProviderEvent[] = [];
  for await (const e of p.stream(r, new AbortController().signal)) out.push(e);
  return out;
};
const fake = (id: string, fn: () => ProviderEvent[] | Error, local = false): ChatProvider & { calls: ProviderRequest[]; local: boolean; model: string; name: string } => {
  const calls: ProviderRequest[] = [];
  return {
    id, name: id, local, model: id + '-model', calls,
    async *stream(r) {
      calls.push(r);
      const v = fn();
      if (v instanceof Error) throw v;
      for (const e of v) yield e;
    },
  };
};
const say = (t: string): ProviderEvent[] => [{ type: 'text', text: t }];

describe('OpenAI-совместимый провайдер', () => {
  it('сообщения: вызовы и результаты инструментов переводятся в формат OpenAI', () => {
    const msgs: ProviderMessage[] = [
      u('который час'),
      { role: 'assistant', content: [{ type: 'text', text: 'Смотрю' }, { type: 'tool_use', id: 'c1', name: 'get_datetime', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'c1', name: 'get_datetime', content: '12:00' }] },
    ];
    const o = toOpenAiMessages('SYS', msgs);
    expect(o[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(o[2]).toMatchObject({ role: 'assistant', content: 'Смотрю', tool_calls: [{ id: 'c1', function: { name: 'get_datetime', arguments: '{}' } }] });
    expect(o[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '12:00' });
  });

  it('поток: текст по кусочкам и вызов инструмента, собранный из фрагментов', async () => {
    const f = (async () =>
      sse([delta({ content: 'При' }), delta({ content: 'вет' }), delta({ tool_calls: [{ index: 0, id: 'x1', function: { name: 'remember', arguments: '{"kind":"fa' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: 'ct","content":"a"}' } }] })])) as unknown as typeof fetch;
    const p = new OpenAiCompatProvider({ id: 'groq', name: 'Groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', local: false, fetchImpl: f });
    const ev = await collect(p, req([u('hi')]));
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Привет');
    expect(ev.find((e) => e.type === 'tool_use')).toMatchObject({ name: 'remember', id: 'x1', input: { kind: 'fact', content: 'a' } });
  });

  it('облачная модель получает системную подсказку БЕЗ личных данных, локальная — полную; ключ уходит только в заголовок', async () => {
    const seen: { system: string; auth: string | null }[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
      seen.push({ system: body.messages[0]!.content, auth: new Headers(init.headers).get('authorization') });
      return sse([delta({ content: 'ок' })]);
    }) as unknown as typeof fetch;
    const mk = (local: boolean) => new OpenAiCompatProvider({ id: 'x', name: 'x', baseUrl: 'https://x/v1', apiKey: local ? null : 'SECRETKEY', model: 'm', local, fetchImpl: f });
    await collect(mk(false), req([u('hi')]));
    await collect(mk(true), req([u('hi')]));
    expect(seen[0]).toEqual({ system: 'LITE', auth: 'Bearer SECRETKEY' });
    expect(seen[1]).toEqual({ system: 'FULL personal', auth: null });
  });

  it('ошибки: 429 и недоступность превращаются в ProviderHttpError', async () => {
    const f429 = (async () => new Response('limit', { status: 429 })) as unknown as typeof fetch;
    const p = new OpenAiCompatProvider({ id: 'groq', name: 'Groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', local: false, fetchImpl: f429 });
    await expect(collect(p, req([u('hi')]))).rejects.toMatchObject({ status: 429 });
    const fdown = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const l = new OpenAiCompatProvider({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: null, model: 'm', local: true, fetchImpl: fdown });
    await expect(collect(l, req([u('hi')]))).rejects.toThrow(/Ollama/);
  });
});

describe('выбор модели', () => {
  it('простой запрос — простой; код, анализ, длинный текст, CRM — сложные', () => {
    expect(classify([u('Привет, как дела?')])).toMatchObject({ hard: false });
    expect(classify([u('Который час?')])).toMatchObject({ hard: false });
    expect(classify([u('Напиши скрипт на Python')])).toMatchObject({ hard: true });
    expect(classify([u('Проанализируй заявки за неделю')])).toMatchObject({ hard: true });
    expect(classify([u('а'.repeat(800))])).toMatchObject({ hard: true });
    expect(classify([u('используй Claude для этого')])).toMatchObject({ hard: true });
    const withCrm: ProviderMessage[] = [u('что там'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'crm_overview', input: {} }] }];
    expect(classify(withCrm)).toMatchObject({ hard: true, sensitive: true });
    expect(classify([u('Привет')]).sensitive).toBe(false);
  });

  it('простое → бесплатная; сложное → Claude', async () => {
    const free = fake('groq', () => say('free'));
    const claude = fake('anthropic', () => say('claude'));
    const r = new RoutingProvider({ mode: 'smart', free: [free as never], claude, claudeModel: 'claude-x' });
    expect(JSON.stringify(await collect(r, req([u('Привет')])))).toContain('free');
    expect(JSON.stringify(await collect(r, req([u('Напиши скрипт для отчёта')])))).toContain('claude');
    expect(free.calls).toHaveLength(1);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]!.model).toBe('claude-x');
  });

  it('если бесплатная упала (лимит) — запрос уходит в Claude; если Claude упал — на бесплатную', async () => {
    const limited = fake('groq', () => new ProviderHttpError(429, 'limit', 'groq'));
    const claude = fake('anthropic', () => say('claude'));
    const r = new RoutingProvider({ mode: 'smart', free: [limited as never], claude, claudeModel: 'c' });
    const ev = await collect(r, req([u('Привет')]));
    expect(JSON.stringify(ev)).toContain('claude');
    const down = fake('anthropic', () => new ProviderHttpError(0, 'нет баланса'));
    const ok = fake('groq', () => say('free-ok'));
    const r2 = new RoutingProvider({ mode: 'smart', free: [ok as never], claude: down, claudeModel: 'c' });
    expect(JSON.stringify(await collect(r2, req([u('Напиши код')])))).toContain('free-ok');
  });

  it('если ответ уже начался — не переключаемся (ошибка пробрасывается)', async () => {
    const broken: ChatProvider & { local: boolean; model: string; name: string } = {
      id: 'groq', name: 'groq', local: false, model: 'm',
      async *stream() { yield { type: 'text', text: 'Нача' } as ProviderEvent; throw new ProviderHttpError(0, 'обрыв'); },
    };
    const claude = fake('anthropic', () => say('claude'));
    const r = new RoutingProvider({ mode: 'smart', free: [broken as never], claude, claudeModel: 'c' });
    await expect(collect(r, req([u('Привет')]))).rejects.toThrow(/обрыв/);
    expect(claude.calls).toHaveLength(0);
  });

  it('личные данные (CRM) не уходят сторонним облакам, только локальной модели или Claude', async () => {
    const cloud = fake('groq', () => say('cloud'));
    const local = fake('ollama', () => say('local'), true);
    const claude = fake('anthropic', () => say('claude'));
    const history: ProviderMessage[] = [u('Привет'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'crm_team', input: {} }] }, { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'a', name: 'crm_team', content: 'данные' }] }];
    const r = new RoutingProvider({ mode: 'free', free: [cloud as never, local as never], claude: null, claudeModel: 'c' });
    expect(JSON.stringify(await collect(r, req(history)))).toContain('local');
    expect(cloud.calls).toHaveLength(0);
    const onlyCloud = new RoutingProvider({ mode: 'free', free: [cloud as never], claude: null, claudeModel: 'c' });
    await expect(collect(onlyCloud, req(history))).rejects.toThrow(/локальная модель/);
    const smart = new RoutingProvider({ mode: 'smart', free: [cloud as never], claude, claudeModel: 'c' });
    expect(JSON.stringify(await collect(smart, req(history)))).toContain('claude');
  });

  it('режим «только Claude» и «только бесплатные» соблюдаются', async () => {
    const free = fake('groq', () => say('free'));
    const claude = fake('anthropic', () => say('claude'));
    const onlyClaude = new RoutingProvider({ mode: 'claude', free: [free as never], claude, claudeModel: 'c' });
    expect(JSON.stringify(await collect(onlyClaude, req([u('Привет')])))).toContain('claude');
    const onlyFree = new RoutingProvider({ mode: 'free', free: [free as never], claude, claudeModel: 'c' });
    expect(JSON.stringify(await collect(onlyFree, req([u('Напиши код')])))).toContain('free');
    expect(claude.calls).toHaveLength(1); // платная не вызывалась во втором случае
  });
});

describe('менеджер провайдеров и ядро', () => {
  const cfg = (over: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...over });
  it('без ключа Claude, но с включённой бесплатной моделью — рабочий (live) режим; без ключа у облачной — демо', () => {
    const secrets = new MemorySecretStore();
    const pm = new ProviderManager(secrets, {});
    const on = (id: string) => DEFAULT_SETTINGS.freeProviders.map((c) => (c.id === id ? { ...c, enabled: true } : c));
    expect(pm.resolve(cfg({ freeProviders: on('groq') })).mode).toBe('demo'); // ключа Groq нет
    secrets.set('provider.groq.key', 'g'.repeat(30));
    expect(pm.resolve(cfg({ freeProviders: on('groq') })).mode).toBe('live');
    expect(pm.resolve(cfg({ freeProviders: on('ollama') })).mode).toBe('live'); // Ollama без ключа
    expect(pm.resolve(cfg({ freeProviders: on('ollama'), provider: 'demo' })).mode).toBe('demo');
  });

  it('настройки проверяются', () => {
    const h = makeCore();
    expect(() => h.core.updateSettings({ routingMode: 'x' })).toThrow();
    expect(() => h.core.updateSettings({ freeProviders: [{ id: 'evil', enabled: true, model: 'm', baseUrl: 'https://a.b' }] })).toThrow();
    expect(() => h.core.updateSettings({ freeProviders: [{ id: 'groq', enabled: true, model: 'm', baseUrl: 'http://evil.com/v1' }] })).toThrow(/https/);
    expect(h.core.providerStatuses().map((p) => p.id)).toContain('ollama');
  });

  it('сквозной чат через Ollama (подменённая сеть): ответ приходит, в сообщении указана модель, ключи и данные не утекают', async () => {
    let body = '';
    const modelFetch = (async (_u: string, init: RequestInit) => {
      body = String(init.body);
      return sse([delta({ content: 'Привет от Qwen' })]);
    }) as unknown as typeof fetch;
    const h = makeCore({ modelFetch });
    h.core.updateSettings({ freeProviders: DEFAULT_SETTINGS.freeProviders.map((c) => (c.id === 'ollama' ? { ...c, enabled: true } : c)) });
    expect(h.core.info().mode).toBe('live');
    const conv = h.core.createConversation().id;
    const events: unknown[] = [];
    await h.core.startChat(conv, 'Привет', (e) => events.push(e)).done;
    const msgs = h.core.messages(conv);
    const last = msgs[msgs.length - 1]!;
    expect(last.provider).toBe('ollama');
    expect(last.content[0]).toMatchObject({ type: 'text', text: 'Привет от Qwen' });
    expect(JSON.parse(body).model).toBe('qwen2.5:7b');
    expect(JSON.stringify(h.core.listAudit(50))).toContain('chat.route');
  });

  it('досье не уходит стороннему облаку (только локальной модели)', async () => {
    const bodies: Record<string, string> = {};
    const modelFetch = (async (url: string, init: RequestInit) => {
      bodies[url.includes('groq') ? 'groq' : 'ollama'] = String(init.body);
      return sse([delta({ content: 'ок' })]);
    }) as unknown as typeof fetch;
    const h = makeCore({ modelFetch });
    h.core.setProfileSection('work', 'ТАЙНАЯ-ПОДРОБНОСТЬ-ДОСЬЕ');
    h.secrets.set('provider.groq.key', 'g'.repeat(30));
    h.core.updateSettings({ freeProviders: DEFAULT_SETTINGS.freeProviders.map((c) => (c.id === 'groq' ? { ...c, enabled: true } : c)) });
    await h.core.startChat(h.core.createConversation().id, 'Привет', () => undefined).done;
    expect(bodies.groq).toBeDefined();
    expect(bodies.groq).not.toContain('ТАЙНАЯ-ПОДРОБНОСТЬ-ДОСЬЕ');
    h.core.updateSettings({ freeProviders: DEFAULT_SETTINGS.freeProviders.map((c) => (c.id === 'ollama' ? { ...c, enabled: true } : c)) });
    await h.core.startChat(h.core.createConversation().id, 'Привет', () => undefined).done;
    expect(bodies.ollama).toContain('ТАЙНАЯ-ПОДРОБНОСТЬ-ДОСЬЕ');
  });
});

describe('картинки', () => {
  it('создаёт картинку после подтверждения, сохраняет файл, без ключа — понятная ошибка', async () => {
    const png = Buffer.from('fakepng').toString('base64');
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const h = makeCore({ fetchImpl });
    const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };
    const tool = h.core.tools.get('image_generate')!;
    await expect(tool.execute({ prompt: 'кот' }, ctx)).rejects.toThrow(/ключ OpenAI/);
    h.core.setVoiceKey('sk-' + 'a'.repeat(40));
    const out = (await tool.execute({ prompt: 'космический город', size: '1536x1024' }, ctx)) as { text: string; images: { kind: string }[] };
    expect(url).toContain('/images/generations');
    expect(out.images[0]!.kind).toBe('image');
    expect(out.text).toContain('image-');
    expect(h.core.tools.list().find((t) => t.name === 'image_generate')!.risk).toBe('medium');
  });
});

import Anthropic from '@anthropic-ai/sdk';
import { describeApiError } from '../src/core/providers/anthropic';
describe('Понятные ошибки Anthropic', () => {
  it('400 показывает настоящую причину; закончились деньги — отдельное объяснение; ключ не утекает', () => {
    const mk = (status: number, message: string) => new Anthropic.APIError(status, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers());
    expect(describeApiError(mk(400, 'Your credit balance is too low to access the Anthropic API.'))).toMatch(/закончились деньги/);
    expect(describeApiError(mk(400, 'tools.3.input_schema: bad'))).toContain('tools.3.input_schema: bad');
    expect(describeApiError(mk(400, 'key sk-ant-abcdef123456 bad'))).not.toContain('abcdef123456');
    expect(describeApiError(mk(400, 'prompt is too long: 250000 tokens'))).toMatch(/слишком длинным/);
  });
});

import { cleanSchema, describeProviderHttp } from '../src/core/providers/openai';
describe('Gemini и другие бесплатные модели: схемы, повторы, понятные ошибки', () => {
  it('cleanSchema: без additionalProperties и списков типов; пустые параметры не передаются; массивы с items', () => {
    expect(cleanSchema({ type: 'object', properties: {} })).toBeUndefined();
    const s = cleanSchema({ type: 'object', properties: { q: { type: 'object', additionalProperties: { type: ['string', 'number'] }, description: 'фильтры' }, a: { type: 'array' }, n: { type: ['integer', 'null'] }, ok: { type: 'string', default: 'x' } }, additionalProperties: false, required: ['q'] })!;
    const p = s['properties'] as Record<string, Record<string, unknown>>;
    expect(s['additionalProperties']).toBeUndefined();
    expect(p['q']).toMatchObject({ type: 'string' });
    expect(p['a']).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(p['n']!['type']).toBe('integer');
    expect(p['ok']!['default']).toBeUndefined();
    expect(s['required']).toEqual(['q']);
  });

  const sseText = (t: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
  const run = async (f: typeof fetch) => {
    const p = new OpenAiCompatProvider({ id: 'gemini', name: 'Gemini', baseUrl: 'https://x/v1', apiKey: 'AIzaSyKEY1234567', model: 'm', local: false, fetchImpl: f, retryDelayMs: 0 });
    let text = '';
    for await (const ev of p.stream({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'привет' }] }], tools: [{ name: 'show_stats', description: 'd', inputSchema: { type: 'object', properties: {} } }, { name: 'crm_live_get', description: 'd', inputSchema: { type: 'object', properties: { query: { type: 'object', additionalProperties: { type: ['string', 'number'] } } }, required: ['query'] } }], model: 'm', maxTokens: 50 }, new AbortController().signal)) if (ev.type === 'text') text += ev.text;
    return text;
  };

  it('503 «перегружено» дважды, затем ответ — пользователь ничего не замечает; в запросе нет «опасных» полей схемы', async () => {
    let n = 0;
    const bodies: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return ++n < 3 ? new Response(JSON.stringify([{ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }]), { status: 503 }) : sseText('Привет!');
    }) as unknown as typeof fetch;
    expect(await run(f)).toBe('Привет!');
    expect(n).toBe(3);
    const sent = JSON.parse(bodies[0]!);
    expect(sent.tools[0].function.parameters).toBeUndefined(); // инструмент без параметров
    expect(JSON.stringify(sent.tools)).not.toContain('additionalProperties');
  });

  it('постоянный 503: честная причина от сервиса, а не просто «недоступен»; 400 и 429 тоже с причиной', async () => {
    const f = (async () => new Response(JSON.stringify([{ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }]), { status: 503 })) as unknown as typeof fetch;
    const err = await run(f).catch((e: unknown) => e as ProviderHttpError);
    const msg = describeProviderHttp(err as ProviderHttpError);
    expect(msg).toMatch(/перегружен/);
    expect(msg).toContain('The model is overloaded');
    expect(describeProviderHttp(new ProviderHttpError(400, JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "x" key AIzaSyABCDEFGH123' } }), 'gemini'))).toMatch(/Invalid JSON payload.*\[ключ\]/);
    expect(describeProviderHttp(new ProviderHttpError(500, 'oops', 'gemini'))).toMatch(/недоступен \(500\)/);
  });
});

import { netMessage } from '../src/core/providers/openai';
describe('Сбои сети и закрытые для страны сервисы', () => {
  it('сообщение называет адрес и причину и подсказывает выход; 403 объясняет возможную блокировку по стране', () => {
    const m = netMessage('https://generativelanguage.googleapis.com/v1beta/openai', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }));
    expect(m).toContain('generativelanguage.googleapis.com');
    expect(m).toContain('ETIMEDOUT');
    expect(m).toMatch(/VPN/);
    expect(netMessage('https://x.y/v1', Object.assign(new TypeError('x'), { cause: { code: 'ENOTFOUND' } }))).toMatch(/адрес не найден/);
    expect(describeProviderHttp(new ProviderHttpError(403, 'Access denied', 'groq'))).toMatch(/закрыт для вашей страны/);
  });
});

describe('402: закончились деньги у сервиса', () => {
  it('Gemini — как создать ключ на бесплатном тарифе; DeepSeek — пополнить', () => {
    expect(describeProviderHttp(new ProviderHttpError(402, '{"error":{"message":"Your prepayment credits are depleted"}}', 'gemini'))).toMatch(/новом проекте/);
    expect(describeProviderHttp(new ProviderHttpError(402, 'Insufficient Balance', 'deepseek'))).toMatch(/Пополните баланс/);
  });
});
