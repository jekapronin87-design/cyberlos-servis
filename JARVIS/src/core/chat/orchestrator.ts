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
import { buildSystemPrompt } from './prompt';

export const MAX_USER_TEXT = 20_000;
const MAX_TOOL_STEPS = 12;
const MAX_HISTORY_MESSAGES = 60;
const MAX_TOOL_RESULT_CHARS = 20_000;

export interface OrchestratorDeps {
  conversations: ConversationRepo;
  attachments: AttachmentRepo;
  computer: () => ComputerAccess;
  memory: MemoryRepo;
  settings: SettingsRepo;
  tools: ToolRegistry;
  audit: AuditLog;
  confirm: ConfirmationBroker;
  providers: ProviderManager;
  role: Role;
}

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

/** Простая проверка входа инструмента по его JSON-схеме (обязательные поля и базовые типы). */
export function validateToolInput(tool: ToolDefinition, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Аргументы должны быть объектом';
  const obj = input as Record<string, unknown>;
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in obj)) return `Не хватает аргумента «${key}»`;
  }
  for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
    if (!(key in obj)) continue;
    const s = spec as { type?: string; enum?: unknown[] };
    const v = obj[key];
    if (s.type === 'string' && typeof v !== 'string') return `«${key}» должен быть строкой`;
    if (s.type === 'integer' && !Number.isInteger(v)) return `«${key}» должен быть целым числом`;
    if (s.type === 'boolean' && typeof v !== 'boolean') return `«${key}» должен быть логическим`;
    if (s.enum && !s.enum.includes(v)) return `«${key}» имеет недопустимое значение`;
  }
  return null;
}

export class ChatOrchestrator {
  constructor(private d: OrchestratorDeps) {}

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
          results.push(await this.executeTool(use, runId, conversationId, signal));
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

  private async executeTool(
    use: ToolUseBlock,
    runId: string,
    conversationId: number,
    signal: AbortSignal,
  ): Promise<ToolResultBlock> {
    const base = { type: 'tool_result' as const, toolUseId: use.id, name: use.name };
    const fail = (content: string, denied = false): ToolResultBlock => ({ ...base, content, isError: true, denied });

    const tool = this.d.tools.get(use.name);
    if (!tool) {
      this.d.audit.record({ actor: 'assistant', action: 'tool.unknown', target: use.name, decision: 'denied' });
      return fail(`Инструмент «${use.name}» не существует.`);
    }
    const invalid = validateToolInput(tool, use.input);
    if (invalid) {
      this.d.audit.record({ actor: 'assistant', action: 'tool.invalid_input', target: tool.name, decision: 'error', details: { invalid } });
      return fail(`Неверные аргументы: ${invalid}`);
    }

    const settings = this.d.settings.get();
    const policy = decide(tool, this.d.role, settings);
    const audit = (decision: 'allowed' | 'confirmed' | 'denied' | 'rejected' | 'error', extra: Record<string, unknown> = {}): void =>
      this.d.audit.record({
        actor: 'assistant',
        action: 'tool.execute',
        target: tool.name,
        risk: tool.risk,
        decision,
        details: { input: use.input, domain: tool.domain, reason: policy.reason, conversationId, ...extra },
      });

    if (policy.decision === 'deny') {
      audit('denied');
      return fail(policy.reason, true);
    }
    if (policy.decision === 'confirm') {
      const approved = await this.d.confirm.request(
        {
          runId,
          toolName: tool.name,
          description: tool.describe(use.input),
          risk: tool.risk,
          input: use.input,
          reason: policy.reason,
        },
        signal,
      );
      if (!approved) {
        audit('rejected');
        return fail('Пользователь отклонил действие (или запуск был остановлен). Действие не выполнено.', true);
      }
      audit('confirmed');
    } else {
      audit('allowed');
    }

    if (signal.aborted) return fail('Запуск остановлен.', true);
    try {
      const raw = await tool.execute(use.input, { conversationId, signal });
      const images = typeof raw === 'string' ? [] : (raw.images ?? []);
      let output = typeof raw === 'string' ? raw : raw.text;
      if (output.length > MAX_TOOL_RESULT_CHARS) output = output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[обрезано]';
      if (tool.external) {
        const { wrapped, scan } = wrapUntrusted(`tool:${tool.name}`, output);
        if (scan.suspicious) {
          this.d.audit.record({
            actor: 'system',
            action: 'injection.suspected',
            target: tool.name,
            decision: 'info',
            details: { matches: scan.matches },
          });
        }
        output = wrapped;
      }
      const imageIds = images.map((im) => this.d.attachments.add(im.mime, im.base64));
      return { ...base, content: output, ...(imageIds.length ? { imageIds } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit('error', { error: message });
      return fail(`Ошибка выполнения: ${message}`);
    }
  }
}
