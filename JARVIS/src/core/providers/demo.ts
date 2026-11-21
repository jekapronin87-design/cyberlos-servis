import type { ContentBlock } from '../../shared/types';
import { stripUntrustedWrapper } from '../../shared/text';
import type { ChatProvider, ProviderEvent, ProviderMessage, ProviderRequest } from './types';

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const lastText = (m: ProviderMessage | undefined): string =>
  (m?.content ?? [])
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const HELP =
  'Я работаю в **демонстрационном режиме**: настоящей языковой модели сейчас нет, поэтому отвечаю по простым шаблонам.\n\n' +
  'Что можно попробовать:\n' +
  '• «Который час?» — вызов безопасного инструмента;\n' +
  '• «Запомни: я предпочитаю короткие ответы» — запись в память;\n' +
  '• «Что ты помнишь?» — чтение памяти;\n' +
  '• «Забудь 1» — удаление записи (потребуется ваше подтверждение);\n' +
  '• «Покажи папки», «Покажи файлы <путь>», «Прочитай файл <путь>», «Создай файл <путь> с текстом <текст>», «Открой сайт <адрес>» — работа с компьютером (после того как вы разрешите папки в настройках);\n\n' +
  'Чтобы подключить настоящий ИИ, откройте «Настройки» и введите API-ключ Anthropic.';

/**
 * Демонстрационный провайдер без сети и ключей. Нужен, чтобы приложение полностью работало
 * (чат, память, подтверждения, журнал) без API-ключа, и для детерминированных тестов.
 */
export class DemoProvider implements ChatProvider {
  readonly id = 'demo';
  readonly name = 'Демо-режим (без ИИ)';

  constructor(private chunkDelayMs = 12) {}

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const last = req.messages[req.messages.length - 1];

    // После результата инструмента — сформулировать ответ.
    if (last?.role === 'tool') {
      const results = last.content.filter((b) => b.type === 'tool_result');
      const text = results
        .map((r) => (r.type === 'tool_result' ? stripUntrustedWrapper(r.content) : ''))
        .join('\n');
      yield* this.say(text || 'Готово.', signal);
      return;
    }

    const text = lastText(last).trim();
    const lower = text.toLowerCase();
    const has = (name: string): boolean => req.tools.some((t) => t.name === name);

    let m: RegExpMatchArray | null;
    const call = (name: string, input: Record<string, unknown>): ProviderEvent => ({ type: 'tool_use', id: 'demo_' + Date.now(), name, input });
    // Команды демонстрации инструментов этапа 3 (в демо-режиме модели нет — понимаем только эти шаблоны).
    if (has('fs_list_allowed') && /^\s*покажи (мои )?(разрешённые )?папки/.test(lower)) {
      yield call('fs_list_allowed', {});
      return;
    }
    if (has('fs_list') && (m = text.match(/^\s*покажи файлы(?: в)?\s+(.+)$/is))) {
      yield call('fs_list', { path: m[1]!.trim() });
      return;
    }
    if (has('fs_read') && (m = text.match(/^\s*прочитай файл\s+(.+)$/is))) {
      yield call('fs_read', { path: m[1]!.trim() });
      return;
    }
    if (has('fs_write') && (m = text.match(/^\s*создай файл\s+(.+?)\s+с текстом\s+(.+)$/is))) {
      yield call('fs_write', { path: m[1]!.trim(), content: m[2]!.trim() });
      return;
    }
    if (has('fs_delete') && (m = text.match(/^\s*удали файл\s+(.+)$/is))) {
      yield call('fs_delete', { path: m[1]!.trim() });
      return;
    }
    if (has('app_open') && (m = text.match(/^\s*открой программу\s+(.+)$/is))) {
      yield call('app_open', { name: m[1]!.trim() });
      return;
    }
    if (has('browser_open') && (m = text.match(/^\s*открой сайт\s+(\S+)/is))) {
      yield call('browser_open', { url: m[1]!.trim() });
      return;
    }
    if (has('screen_capture') && /^\s*сделай снимок экрана/.test(lower)) {
      yield call('screen_capture', {});
      return;
    }
    if (has('remember') && (m = text.match(/^\s*запомни[:,\s]+(.+)$/is))) {
      yield* this.say('Сохраняю.\n', signal);
      yield { type: 'tool_use', id: 'demo_' + Date.now(), name: 'remember', input: { kind: 'preference', content: m[1]!.trim() } };
    } else if (has('forget_memory') && (m = lower.match(/^\s*забудь\s+#?(\d+)\s*$/))) {
      yield* this.say('Удаляю запись.\n', signal);
      yield { type: 'tool_use', id: 'demo_' + Date.now(), name: 'forget_memory', input: { id: Number(m[1]) } };
    } else if (has('list_memory') && /что (ты )?(помнишь|знаешь обо мне)|покажи память/.test(lower)) {
      yield { type: 'tool_use', id: 'demo_' + Date.now(), name: 'list_memory', input: {} };
    } else if (has('get_datetime') && /который час|сколько времени|какое (сегодня )?число|какая дата|время/.test(lower)) {
      yield { type: 'tool_use', id: 'demo_' + Date.now(), name: 'get_datetime', input: {} };
    } else if (/^(привет|здравствуй|добрый|джарвис)/.test(lower)) {
      yield* this.say('Здравствуйте! Я Джарвис. ' + HELP, signal);
    } else {
      yield* this.say(HELP, signal);
    }
  }

  private async *say(text: string, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const parts = text.match(/\S+\s*|\s+/g) ?? [];
    for (let i = 0; i < parts.length; i += 3) {
      if (signal.aborted) return;
      yield { type: 'text', text: parts.slice(i, i + 3).join('') };
      await sleep(this.chunkDelayMs, signal);
    }
  }
}
