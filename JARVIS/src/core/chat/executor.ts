import type { ContentBlock, Role } from '../../shared/types';
import type { AttachmentRepo, SettingsRepo } from '../db/repositories';
import type { AuditLog } from '../security/audit';
import type { ConfirmationBroker } from '../security/confirmation';
import { wrapUntrusted } from '../security/injection';
import { decide, RISK_ORDER } from '../security/policy';
import type { ToolDefinition, ToolRegistry } from '../tools/registry';

export const MAX_TOOL_RESULT_CHARS = 20_000;

export type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;
export type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

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
    if (s.type === 'array' && !Array.isArray(v)) return `«${key}» должен быть списком`;
    if (s.enum && !s.enum.includes(v)) return `«${key}» имеет недопустимое значение`;
  }
  return null;
}

export interface ExecutorDeps {
  tools: ToolRegistry;
  settings: SettingsRepo;
  audit: AuditLog;
  confirm: ConfirmationBroker;
  attachments: AttachmentRepo;
  role: Role;
}

export interface ExecContext {
  runId: string;
  conversationId: number;
  signal: AbortSignal;
  /** Кто вызывает: 'assistant' или 'agent:<роль>'. Попадает в журнал. */
  actor: string;
  /** Белый список инструментов (для субагентов). Остальные — отказ. */
  allowedTools?: ReadonlySet<string>;
}

/**
 * Единственный путь выполнения инструмента: проверка аргументов → политика → подтверждение →
 * выполнение → защита от инъекций → журнал. Им пользуются и основной ассистент, и субагенты —
 * поэтому у субагентов нет «обходных» прав.
 */
export class ToolExecutor {
  constructor(private d: ExecutorDeps) {}

  async execute(use: ToolUseBlock, ctx: ExecContext): Promise<ToolResultBlock> {
    const { signal, conversationId, actor } = ctx;
    const base = { type: 'tool_result' as const, toolUseId: use.id, name: use.name };
    const fail = (content: string, denied = false): ToolResultBlock => ({ ...base, content, isError: true, denied });

    const tool = this.d.tools.get(use.name);
    if (!tool || (ctx.allowedTools && !ctx.allowedTools.has(use.name))) {
      this.d.audit.record({ actor, action: 'tool.unknown', target: use.name, decision: 'denied' });
      return fail(`Инструмент «${use.name}» недоступен.`);
    }
    const invalid = validateToolInput(tool, use.input);
    if (invalid) {
      this.d.audit.record({ actor, action: 'tool.invalid_input', target: tool.name, decision: 'error', details: { invalid } });
      return fail(`Неверные аргументы: ${invalid}`);
    }

    // Динамическая оценка риска по конкретным аргументам: может только повысить риск.
    let risk = tool.risk;
    let warning = '';
    try {
      const a = tool.assess?.(use.input);
      if (a?.risk && RISK_ORDER.indexOf(a.risk) > RISK_ORDER.indexOf(risk)) risk = a.risk;
      if (a?.warning) warning = a.warning;
    } catch {
      /* оценка не должна ломать вызов */
    }

    const settings = this.d.settings.get();
    const policy = decide({ ...tool, risk }, this.d.role, settings);
    const audit = (decision: 'allowed' | 'confirmed' | 'denied' | 'rejected' | 'error', extra: Record<string, unknown> = {}): void =>
      this.d.audit.record({
        actor,
        action: 'tool.execute',
        target: tool.name,
        risk,
        decision,
        details: { input: use.input, domain: tool.domain, reason: policy.reason, conversationId, ...extra },
      });

    if (policy.decision === 'deny') {
      audit('denied');
      return fail(policy.reason, true);
    }
    if (policy.decision === 'confirm') {
      let description = tool.describe(use.input);
      if (actor !== 'assistant') description = `[${actor.replace('agent:', 'агент: ')}] ${description}`;
      if (warning) description += `\n⚠ ${warning}`;
      const approved = await this.d.confirm.request(
        { runId: ctx.runId, toolName: tool.name, description, risk, input: use.input, reason: policy.reason },
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
      const raw = await tool.execute(use.input, { conversationId, signal, runId: ctx.runId });
      const images = typeof raw === 'string' ? [] : (raw.images ?? []);
      let output = typeof raw === 'string' ? raw : raw.text;
      if (output.length > MAX_TOOL_RESULT_CHARS) output = output.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[обрезано]';
      if (tool.external) {
        const { wrapped, scan } = wrapUntrusted(`tool:${tool.name}`, output);
        if (scan.suspicious) {
          this.d.audit.record({ actor: 'system', action: 'injection.suspected', target: tool.name, decision: 'info', details: { matches: scan.matches } });
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
