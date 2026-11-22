type Fetch = typeof fetch;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}
export interface TgMemberUpdate {
  chat: TgChat;
  from?: TgUser;
  new_chat_member?: { status: string; user?: TgUser };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  /** Пост в канале, где бот — администратор. */
  channel_post?: TgMessage;
  /** Бота добавили в канал/группу или убрали из неё. */
  my_chat_member?: TgMemberUpdate;
}

export class TelegramApiError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Клиент официального Telegram Bot API. Токен бота входит в адрес запроса — поэтому он никогда не попадает в ошибки и журналы.
 */
export class TelegramApi {
  constructor(
    private token: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (signal?.aborted) throw new TelegramApiError(0, 'aborted');
      throw new TelegramApiError(0, 'Нет связи с Telegram. Проверьте интернет.');
    }
    const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!j?.ok) {
      const code = j?.error_code ?? res.status;
      const desc = (j?.description ?? '').replace(/bot\d+:[\w-]+/g, 'bot***');
      if (code === 401) throw new TelegramApiError(401, 'Токен бота не подошёл. Проверьте его у @BotFather.');
      if (code === 403) throw new TelegramApiError(403, 'Telegram не разрешает писать этому человеку (он не начинал диалог с ботом или заблокировал его).');
      if (code === 409) throw new TelegramApiError(409, 'Этот бот уже опрашивается другой программой. Остановите её.');
      if (code === 429) throw new TelegramApiError(429, 'Telegram просит подождать (слишком много запросов).');
      throw new TelegramApiError(code, `Ошибка Telegram (${code}): ${desc.slice(0, 120)}`);
    }
    return j.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  /** Длинный опрос: ждёт новые сообщения до timeoutSec секунд. */
  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'channel_post', 'my_chat_member'] }, signal, (timeoutSec + 15) * 1000);
  }

  sendMessage(chatId: number, text: string): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true });
  }

  sendChatAction(chatId: number): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
}

export const displayName = (c: TgChat, from?: TgUser): string => {
  if (c.type !== 'private') return c.title ?? 'Группа';
  const n = [c.first_name ?? from?.first_name, c.last_name ?? from?.last_name].filter(Boolean).join(' ');
  return n || c.username || String(c.id);
};
