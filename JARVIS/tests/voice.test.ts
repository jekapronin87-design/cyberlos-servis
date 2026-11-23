import { describe, expect, it } from 'vitest';
import { validateVoiceBaseUrl } from '../src/core/db/repositories';
import { MAX_AUDIO_BYTES, OpenAiCompatibleStt, OpenAiCompatibleTts, SECRET_VOICE_KEY } from '../src/core/voice/service';
import { isPromptLeak, isEchoOfSpeech, isEndPhrase, isJunkTranscript, parseAppIntent, parseNavIntent, isStopPhrase, isWakeWord, parseVoiceCommand, textForSpeech } from '../src/shared/voice';
import { makeCore } from './helpers';

describe('разбор голосовых команд', () => {
  it('слово «Джарвис» и его искажения', () => {
    for (const w of ['Джарвис', 'джарвис,', 'Жарвис', 'Джарвиз', 'Jarvis', 'ДЖАРВИС!']) expect(isWakeWord(w)).toBe(true);
    for (const w of ['привет', 'дартвейдер', 'сервис', '']) expect(isWakeWord(w)).toBe(false);
  });
  it('команда после слова-обращения', () => {
    expect(parseVoiceCommand('Джарвис, который час?', { requireWake: true })).toEqual({ kind: 'wake', text: 'который час?' });
    expect(parseVoiceCommand('Джарвис', { requireWake: true })).toEqual({ kind: 'wake', text: '' });
    expect(parseVoiceCommand('Эй, Джарвис, привет', { requireWake: true })).toEqual({ kind: 'wake', text: 'привет' });
    expect(parseVoiceCommand('Я думаю, Джарвис это хорошее имя', { requireWake: true })).toEqual({ kind: 'ignore' });
  });
  it('чужой разговор без обращения игнорируется в режиме ожидания', () => {
    expect(parseVoiceCommand('Купи хлеба и молока', { requireWake: true })).toEqual({ kind: 'ignore' });
    expect(parseVoiceCommand('', { requireWake: true })).toEqual({ kind: 'ignore' });
  });
  it('в режиме по кнопке обращение не нужно', () => {
    expect(parseVoiceCommand('Запомни мой email', { requireWake: false })).toEqual({ kind: 'wake', text: 'Запомни мой email' });
  });
  it('стоп работает с обращением и без', () => {
    for (const t of ['Стоп', 'стоп!', 'Джарвис, стоп', 'остановись', 'Джарвис остановись', 'Отмена']) {
      expect(isStopPhrase(t)).toBe(true);
      expect(parseVoiceCommand(t, { requireWake: true })).toEqual({ kind: 'stop' });
    }
    expect(isStopPhrase('Джарвис, остановись на втором пункте и расскажи подробнее')).toBe(false);
    expect(isStopPhrase('стоп кран это что')).toBe(false);
  });
  it('подготовка текста к озвучке', () => {
    expect(textForSpeech('**Привет**\n\n```js\nalert(1)\n```\nготово')).toBe('Привет (фрагмент кода пропущен) готово');
    expect(textForSpeech('<untrusted_data>секрет</untrusted_data>ок')).toBe('ок');
    expect(textForSpeech('Слово. '.repeat(300), 300).length).toBeLessThan(310);
  });
});

describe('адрес API голоса', () => {
  it('только https или localhost', () => {
    expect(validateVoiceBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(validateVoiceBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(() => validateVoiceBaseUrl('http://evil.example.com/v1')).toThrow();
    expect(() => validateVoiceBaseUrl('https://user:pw@api.example.com')).toThrow();
    expect(() => validateVoiceBaseUrl('ftp://x')).toThrow();
    expect(() => validateVoiceBaseUrl('не адрес')).toThrow();
  });
});

const okFetch = (calls: { url: string; init: RequestInit }[], body: unknown, status = 200): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('клиенты STT/TTS', () => {
  it('STT: «зачитанная» подсказка на тишине даёт пустой результат, настоящий зов по имени — нет', async () => {
    const mk = (text: string) => new OpenAiCompatibleStt({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', hint: 'Системно, Джарвис.' }, okFetch([], { text }));
    expect(await mk('Системно, Джарвис.').transcribe(new Uint8Array([1]), 'audio/wav')).toBe('');
    expect(await mk('Системно.').transcribe(new Uint8Array([1]), 'audio/wav')).toBe('Системно.');
  });

  it('STT: отправляет файл с ключом и возвращает текст', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const stt = new OpenAiCompatibleStt({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, okFetch(calls, { text: ' привет ' }));
    expect(await stt.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm')).toBe('привет');
    expect(calls[0]!.url).toBe('https://x/v1/audio/transcriptions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });
  it('понятные ошибки API без утечки ключа', async () => {
    const mk = (s: number) => new OpenAiCompatibleStt({ baseUrl: 'https://x', apiKey: 'sk-secret-key-value-1234', model: 'm' }, okFetch([], '{}', s));
    await expect(mk(401).transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/Неверный ключ/);
    await expect(mk(429).transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/лимит/);
    await expect(mk(500).transcribe(new Uint8Array([1]), 'audio/webm')).rejects.not.toThrow(/sk-secret/);
  });
  it('TTS: возвращает аудио', async () => {
    const tts = new OpenAiCompatibleTts({ baseUrl: 'https://x', apiKey: 'k', model: 'm', voice: 'v' }, okFetch([], 'AUDIO'));
    const out = await tts.synthesize('привет');
    expect(out.mime).toBe('audio/mpeg');
    expect(out.data.byteLength).toBe(5);
  });
});

describe('VoiceService в ядре', () => {
  const audio = new Uint8Array([1, 2, 3, 4]);
  it('главный выключатель микрофона блокирует распознавание', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const h = makeCore({ fetchImpl: okFetch(calls, { text: 'привет' }) });
    h.secrets.set(SECRET_VOICE_KEY, 'sk-voice-key-1234567890abc');
    await expect(h.core.voice.transcribe(audio, 'audio/webm')).rejects.toThrow(/Микрофон выключен/);
    expect(calls).toHaveLength(0); // аудио никуда не ушло
    h.core.updateSettings({ micEnabled: true });
    expect(await h.core.voice.transcribe(audio, 'audio/webm')).toBe('привет');
    expect(calls).toHaveLength(1);
  });
  it('нужен ключ, проверяются размер и формат', async () => {
    const h = makeCore({ fetchImpl: okFetch([], { text: 'x' }) });
    h.core.updateSettings({ micEnabled: true });
    await expect(h.core.voice.transcribe(audio, 'audio/webm')).rejects.toThrow(/ключ/);
    h.core.setVoiceKey('sk-voice-key-1234567890abc');
    expect(h.core.info().hasVoiceKey).toBe(true);
    await expect(h.core.voice.transcribe(new Uint8Array(0), 'audio/webm')).rejects.toThrow(/Пустая/);
    await expect(h.core.voice.transcribe(new Uint8Array(MAX_AUDIO_BYTES + 1), 'audio/webm')).rejects.toThrow(/длинная/);
    await expect(h.core.voice.transcribe(audio, 'text/html')).rejects.toThrow(/формат/);
    await expect(h.core.voice.transcribe('str' as never, 'audio/webm')).rejects.toThrow();
  });
  it('журнал фиксирует включение микрофона и распознавание, но не текст речи; ключ не светится', async () => {
    const h = makeCore({ fetchImpl: okFetch([], { text: 'мой секретный разговор' }) });
    h.core.setVoiceKey('sk-voice-key-1234567890abc');
    h.core.updateSettings({ micEnabled: true });
    await h.core.voice.transcribe(audio, 'audio/webm');
    h.core.updateSettings({ micEnabled: false });
    const log = JSON.stringify(h.core.listAudit());
    expect(log).toContain('voice.mic_enabled');
    expect(log).toContain('voice.mic_disabled');
    expect(log).toContain('voice.transcribe');
    expect(log).not.toContain('секретный разговор');
    expect(log).not.toContain('sk-voice-key');
  });
  it('облачная озвучка работает только в режиме api', async () => {
    const h = makeCore({ fetchImpl: okFetch([], 'AUDIO') });
    h.core.setVoiceKey('sk-voice-key-1234567890abc');
    await expect(h.core.voice.speak('привет')).rejects.toThrow(/выключена/);
    h.core.updateSettings({ ttsMode: 'api' });
    expect((await h.core.voice.speak('привет')).data.byteLength).toBe(5);
    await expect(h.core.voice.speak('x'.repeat(4001))).rejects.toThrow(/длинный/);
  });
});

import { isLikelyEcho } from '../src/shared/voice';

describe('эхо собственной речи', () => {
  const idle = { speakingSince: null, lastSpokeEnd: 0 };
  it('короткие фразы (возможное «стоп») пропускаются всегда', () => {
    expect(isLikelyEcho({ startedAt: 1000, endedAt: 2800 }, { speakingSince: 500, lastSpokeEnd: 0 })).toBe(false);
  });
  it('длинная фраза во время речи Джарвиса — эхо', () => {
    expect(isLikelyEcho({ startedAt: 1000, endedAt: 6000 }, { speakingSince: 500, lastSpokeEnd: 0 })).toBe(true);
  });
  it('длинная фраза, начавшаяся сразу после окончания его речи, — эхо «хвоста»; позже — нет', () => {
    expect(isLikelyEcho({ startedAt: 5100, endedAt: 9000 }, { speakingSince: null, lastSpokeEnd: 5000 })).toBe(true);
    expect(isLikelyEcho({ startedAt: 8000, endedAt: 12000 }, { speakingSince: null, lastSpokeEnd: 5000 })).toBe(false);
    expect(isLikelyEcho({ startedAt: 1000, endedAt: 6000 }, idle)).toBe(false);
  });
});

describe('сбои сети голосового API — понятные сообщения', () => {
  it('таймаут и обрыв связи', async () => {
    const timeout = (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as unknown as typeof fetch;
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(new OpenAiCompatibleStt({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, timeout).transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/не ответил вовремя/);
    await expect(new OpenAiCompatibleStt({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, offline).transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(/Нет связи/);
    await expect(new OpenAiCompatibleTts({ baseUrl: 'https://x', apiKey: 'k', model: 'm', voice: 'v' }, offline).synthesize('привет')).rejects.toThrow(/Нет связи/);
  });
});

describe('имя «Системно»', () => {
  it('узнаётся с ошибками распознавания и разрывом слова', () => {
    for (const w of ['Системно', 'системно,', 'Систэмно', 'Систем но'.replace(' ', ''), 'Cистемно']) expect(isWakeWord(w)).toBe(true);
    expect(parseVoiceCommand('Системно, открой аналитику', { requireWake: true })).toEqual({ kind: 'wake', text: 'открой аналитику' });
    expect(parseVoiceCommand('Систем но открой Хром', { requireWake: true })).toEqual({ kind: 'wake', text: 'открой Хром' });
    expect(parseVoiceCommand('Эй, Системно!', { requireWake: true })).toEqual({ kind: 'wake', text: '' });
    expect(parseVoiceCommand('Системно, стоп', { requireWake: true })).toEqual({ kind: 'stop' });
    expect(parseVoiceCommand('Работает системно и без сбоев', { requireWake: true })).toEqual({ kind: 'ignore' });
  });
  it('своё имя из настроек работает наравне', () => {
    expect(parseVoiceCommand('Орион, который час', { requireWake: true, names: ['Орион'] })).toEqual({ kind: 'wake', text: 'который час' });
    expect(parseVoiceCommand('Орион, который час', { requireWake: true })).toEqual({ kind: 'ignore' });
  });
});

describe('голосовая навигация', () => {
  it('распознаёт переходы', () => {
    expect(parseNavIntent('Открой аналитику')).toBe('analytics');
    expect(parseNavIntent('покажи статистику по продажам')).toBe('analytics');
    expect(parseNavIntent('давай посмотрим, что у нас с бизнесом')).toBe('city');
    expect(parseNavIntent('покажи наш город')).toBe('city');
    expect(parseNavIntent('Открой мой город')).toBe('city');
    expect(parseNavIntent('вернись')).toBe('home');
    expect(parseNavIntent('открой агентов')).toBe('agents');
    expect(parseNavIntent('запусти агента аналитик')).toBeNull();
    expect(parseNavIntent('закрой аналитику')).toBe('home');
  });
  it('обычные фразы и длинные просьбы не перехватываются', () => {
    expect(parseNavIntent('Расскажи про аналитику в целом подробно и с примерами для нашей компании')).toBeNull();
    expect(parseNavIntent('Который час?')).toBeNull();
    expect(parseNavIntent('напиши письмо про город')).toBeNull();
    expect(parseNavIntent('что ты умеешь')).toBeNull();
  });
});

describe('голосовой запуск программ', () => {
  it('выделяет название программы', () => {
    expect(parseAppIntent('Открой хром')).toBe('хром');
    expect(parseAppIntent('запусти блокнот, пожалуйста')).toBe('блокнот пожалуйста');
    expect(parseAppIntent('Включи телеграм')).toBe('телеграм');
    expect(parseAppIntent('давай запустим эксель')).toBe('эксель');
  });
  it('сайты, файлы, настройки и длинные просьбы уходят модели', () => {
    for (const t of ['открой сайт яндекса', 'открой google.com', 'открой файл отчёт', 'открой папку проекты', 'открой настройки', 'открой аналитику', 'открой мне все отчёты за прошлый месяц', 'какой хром лучше', 'открой https://ya.ru']) expect(parseAppIntent(t), t).toBeNull();
  });
});

describe('беседа: конец разговора и мусор распознавания', () => {
  it('фразы завершения', () => {
    for (const t of ['Пока', 'Отбой', 'Всё, спасибо', 'Ладно, пока', 'Системно, отбой', 'До свидания', 'на сегодня всё', 'спасибо, пока']) expect(isEndPhrase(t), t).toBe(true);
    for (const t of ['пока не знаю что выбрать', 'расскажи про отбой в футболе', 'спасибо, а теперь открой аналитику', 'который час']) expect(isEndPhrase(t), t).toBe(false);
  });
  it('выдумки модели распознавания на тишине отбрасываются, обычные фразы — нет', () => {
    for (const t of ['Продолжение следует...', 'Субтитры сделал DimaTorzok', 'Спасибо за просмотр!', 'Редактор субтитров А.Семкин', 'да да да да да', 'а', '']) expect(isJunkTranscript(t), t).toBe(true);
    for (const t of ['Доброе утро', 'Который час?', 'Открой аналитику', 'Спасибо, это то, что нужно']) expect(isJunkTranscript(t), t).toBe(false);
  });
});

describe('эхо колонок по смыслу', () => {
  const said = 'Да, Евгений, я здесь. Если надо, спросите — я отвечу на ваш вопрос.';
  it('слова самого ассистента — эхо; ваша речь — нет', () => {
    expect(isEchoOfSpeech('Евгений я здесь если надо спросите я отвечу', said)).toBe(true);
    expect(isEchoOfSpeech('Системно открой мне аналитику по заявкам', said)).toBe(false);
    expect(isEchoOfSpeech('какая сегодня погода в Москве', said)).toBe(false);
    expect(isEchoOfSpeech('Евгений, я здесь', said)).toBe(true); // обрывок его же фразы — то самое «да, я здесь» по кругу
    expect(isEchoOfSpeech('если надо спросите', said)).toBe(true);
    expect(isEchoOfSpeech('да давайте', said)).toBe(false); // ваш короткий ответ, которого он не говорил
    expect(isEchoOfSpeech('да', said)).toBe(false);
    expect(isEchoOfSpeech('что-то длинное и совсем другое', '')).toBe(false);
  });
});

describe('подсказка-словарь не становится командой', () => {
  it('«зачитанная» подсказка на тишине отбрасывается, а зов по одному имени — нет', () => {
    const hint = 'Системно, Джарвис.';
    expect(isPromptLeak('Системно, Джарвис.', hint)).toBe(true);
    expect(isPromptLeak('Джарвис, Системно', hint)).toBe(true);
    expect(isPromptLeak('Системно', hint)).toBe(false);
    expect(isPromptLeak('Системно, открой аналитику', hint)).toBe(false);
  });
  it('два зова по имени подряд — не команда «Джарвис»', () => {
    expect(parseVoiceCommand('Системно, Джарвис.', { requireWake: true })).toEqual({ kind: 'wake', text: '' });
    expect(parseVoiceCommand('Системно, Джарвис, который час?', { requireWake: true })).toEqual({ kind: 'wake', text: 'Джарвис, который час?' });
  });
});

import { parseSectionIntent } from '../src/shared/voice';
describe('Голосовые разделы CRM', () => {
  it('«покажи, что у нас в производстве» и подобные → раздел', () => {
    expect(parseSectionIntent('Покажи, что у нас сейчас в производстве')).toMatchObject({ kind: 'production' });
    expect(parseSectionIntent('открой производство')).toMatchObject({ kind: 'production' });
    expect(parseSectionIntent('покажи просроченные задачи')).toMatchObject({ kind: 'tasks' });
    expect(parseSectionIntent('что у нас с застрявшими сделками')).toMatchObject({ kind: 'stuck' });
    expect(parseSectionIntent('покажи сделки без ответственного')).toMatchObject({ kind: 'unassigned' });
    expect(parseSectionIntent('покажи остатки на складе')).toMatchObject({ kind: 'lowstock' });
    expect(parseSectionIntent('покажи монтаж')).toMatchObject({ kind: 'stage', pipelineLike: 'монтаж' });
    expect(parseSectionIntent('открой холодные лиды')).toMatchObject({ kind: 'stage', pipelineLike: 'холодн' });
    expect(parseSectionIntent('покажи продажи')).toMatchObject({ kind: 'stage', pipelineLike: 'продаж' });
  });
  it('не перехватывает чужое: агенты, сайты, программы, длинные фразы, обычные вопросы', () => {
    expect(parseSectionIntent('запусти агента по производству')).toBeNull();
    expect(parseSectionIntent('открой сайт про производство')).toBeNull();
    expect(parseSectionIntent('покажи погоду')).toBeNull();
    expect(parseSectionIntent('расскажи анекдот')).toBeNull();
    expect(parseSectionIntent('Проанализируй раздел CRM «производство»: прочитай данные')).toBeNull();
    expect(parseSectionIntent('какая сегодня погода в производстве одежды в китае и как это влияет на цены на рынке')).toBeNull();
  });
});

describe('Длинная речь', () => {
  it('«спасибо за внимание» внутри длинной фразы — не мусор; короткая выдуманная фраза — мусор', () => {
    expect(isJunkTranscript('Спасибо за внимание')).toBe(true);
    expect(isJunkTranscript('Продолжение следует')).toBe(true);
    expect(isJunkTranscript('Смотри, мы вчера обсудили с клиентом сроки по септику, он сказал спасибо за внимание к деталям, и теперь нужно подготовить договор и график монтажа')).toBe(false);
  });
});
