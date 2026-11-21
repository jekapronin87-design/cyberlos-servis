import { randomUUID } from 'node:crypto';
import type { ChatEvent, ChatMessage, ComputerAccess, ContentBlock, Role } from '../../shared/types';
import type { AttachmentRepo, ConversationRepo, MemoryRepo, SettingsRepo } from '../db/repositories';
import { describeApiError } from '../providers/anthropic';
import type { ProviderManager } from '../providers/manager';
import type { ProviderMessage } from '../providers/types';
import type { AuditLog } from '../security/audit';
import type { ConfirmationBroker } from '../security/confirmation';
import { wrapUntrusted } from '../security/injection';
import { decide } from '../security/policy';
import type { ToolDefinition, ToolRegistry } from '../tools/registry';
import { ToolExecutor, type ToolResultBlock, type ToolUseBlock } from './executor';
import { buildSystemPrompt } from './prompt';

export const MAX_USER_TEXT = 20_000;
const MAX_TOOL_STEPS = 12;
const MAX_HISTORY_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 20_000;

export interface OrchestratorDeps {
  conversations: ConversationRepo;
  attachments: AttachmentRepo;
  computer: () => ComputerAccess;
  profile: () => { title: string; body: string }[];
  crm: () => { environment: 'test' | 'production'; maskPii: boolean } | null;
  memory: MemoryRepo;
  settings: SettingsRepo;
  tools: ToolRegistry;
  audit: AuditLog;
  confirm: ConfirmationBroker;
  providers: ProviderManager;
  role: Role;
}

export { validateToolInput } from './executor';

export class ChatOrchestrator {
  constructor(
    private d: OrchestratorDeps,
    private exec: ToolExecutor,
  ) {}

  /**
   * Один запуск: сообщение пользователя -> (ответ модели -> инструменты)* -> финальный ответ.
   * Прерывается через signal («Стоп»). Никогда не бросает — итог сообщается событием run_finished.
   */
  async run(
    conversationId: number,
    userText: string,
    emit: (e: ChatEvent) => void,
    signal: AbortSignal,
    runId: string = randomUUID(),
  ): Promise<void> {
    const finish = (status: 'done' | 'stopped' | 'error', error?: string): void =>
      emit({ type: 'run_finished', runId, conversationId, status, ...(error ? { error } : {}) });

    try {
      const text = userText.trim();
      if (!text) throw new Error('Пустое сообщение');
      if (text.length > MAX_USER_TEXT) throw new Error(`Сообщение длиннее ${MAX_USER_TEXT} символов`);
      const conv = this.d.conversations.get(conversationId);
      if (!conv) throw new Error('Диалог не найден');

      emit({ type: 'run_started', runId, conversationId });
      const settings = this.d.settings.get();
      const resolved = this.d.providers.resolve(settings);

      const isFirst = this.d.conversations.messages(conversationId).length === 0;
      const userMsg = this.d.conversations.addMessage(conversationId, 'user', [{ type: 'text', text }]);
      emit({ type: 'message', runId, message: userMsg });
      if (isFirst && conv.title === 'Новый диалог') {
        this.d.conversations.rename(conversationId, text.replace(/\s+/g, ' ').slice(0, 60));
      }
      this.d.audit.record({
        actor: 'user',
        action: 'chat.run',
        decision: 'info',
        details: { conversationId, provider: resolved.provider.id, model: settings.model, chars: text.length },
      });

      const meta = { provider: resolved.provider.id, model: resolved.mode === 'live' ? settings.model : 'demo' };

      for (let step = 0; step < MAX_TOOL_STEPS + 1; step++) {
        if (signal.aborted) return this.stopped(runId, conversationId, finish);

        const history = this.buildHistory(conversationId);
        const system = buildSystemPrompt({
          settings,
          folders: this.d.computer().folders,
          profile: settings.profileEnabled ? this.d.profile() : undefined,
          crm: this.d.crm() ?? undefined,
          memory: settings.memoryEnabled ? this.d.memory.list().slice(0, 100) : [],
        });
        // На последнем шаге инструменты отключаются, чтобы цикл гарантированно завершился.
        const tools = step < MAX_TOOL_STEPS ? this.d.tools.specs() : [];

        let assistantText = '';
        const toolUses: ToolUseBlock[] = [];
        try {
          for await (const ev of resolved.provider.stream(
            { system, messages: history, tools, model: settings.model, maxTokens: 4096 },
            signal,
          )) {
            if (signal.aborted) break;
            if (ev.type === 'text') {
              assistantText += ev.text;
              emit({ type: 'delta', runId, conversationId, text: ev.text });
            } else {
              toolUses.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
            }
          }
        } catch (err) {
          if (!signal.aborted) throw err;
        }

        const aborted = signal.aborted;
        // При остановке не сохраняем незавершённые вызовы инструментов — иначе история станет невалидной.
        const blocks: ContentBlock[] = [];
        if (assistantText.trim()) blocks.push({ type: 'text', text: assistantText });
        if (!aborted) blocks.push(...toolUses);
        if (blocks.length) {
          const m = this.d.conversations.addMessage(conversationId, 'assistant', blocks, meta);
          emit({ type: 'message', runId, message: m });
        }
        if (aborted) return this.stopped(runId, conversationId, finish);
        if (toolUses.length === 0) return finish('done');

        const results: ToolResultBlock[] = [];
        for (const use of toolUses) {
          results.push(await this.exec.execute(use, { runId, conversationId, signal, actor: 'assistant' }));
        }
        const toolMsg = this.d.conversations.addMessage(conversationId, 'tool', results);
        emit({ type: 'message', runId, message: toolMsg });
        if (signal.aborted) return this.stopped(runId, conversationId, finish);
      }
      finish('done');
    } catch (err) {
      const message = describeApiError(err);
      this.d.audit.record({ actor: 'system', action: 'chat.error', decision: 'error', details: { message } });
      finish('error', message);
    }
  }

  private stopped(
    _runId: string,
    conversationId: number,
    finish: (s: 'done' | 'stopped' | 'error') => void,
  ): void {
    this.d.audit.record({ actor: 'user', action: 'chat.stopped', decision: 'info', details: { conversationId } });
    finish('stopped');
  }

  /** Последние сообщения диалога в формате провайдера; история всегда начинается с текста пользователя. */
  private buildHistory(conversationId: number): ProviderMessage[] {
    let msgs: ChatMessage[] = this.d.conversations.messages(conversationId);
    if (msgs.length > MAX_HISTORY_MESSAGES) msgs = msgs.slice(-MAX_HISTORY_MESSAGES);
    // Не начинать с «осиротевшего» результата инструмента или реплики ассистента.
    while (msgs.length && !(msgs[0]!.role === 'user' && msgs[0]!.content.some((b) => b.type === 'text'))) {
      msgs = msgs.slice(1);
    }
    // Изображения (снимки экрана) отправляем модели только из последнего результата инструментов:
    // экономит токены и не оставляет личные данные в контексте дольше нужного.
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool');
    return msgs.map((m) => ({
      role: m.role,
      content: m.content.map((b) => {
        if (b.type !== 'tool_result' || !b.imageIds?.length) return b;
        if (m !== lastTool) return { ...b, content: b.content + '\n[снимок экрана удалён из контекста]', imageIds: undefined };
        const images = b.imageIds.map((id) => this.d.attachments.get(id)).filter((x): x is { mime: string; base64: string } => x !== null);
        return { ...b, images };
      }),
    }));
  }
}
