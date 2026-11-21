import type { DataDomain, RiskLevel } from '../../shared/types';
import type { ToolPolicyInfo } from '../security/policy';

export interface ToolContext {
  conversationId: number;
  signal: AbortSignal;
}

/**
 * Описание инструмента. Каждый инструмент объявляет уровень риска, затрагиваемый домен данных
 * и человекочитаемое описание действия для окна подтверждения.
 * Новые модули (файлы, браузер, CRM, обучение) подключаются через ToolRegistry.register().
 */
export interface ToolDefinition<I extends Record<string, unknown> = Record<string, unknown>> extends ToolPolicyInfo {
  description: string;
  /** JSON Schema входных данных (передаётся модели). */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Что именно будет сделано — показывается пользователю при подтверждении. */
  describe(input: I): string;
  /** Результат содержит внешние данные и должен пройти защиту от инъекций. */
  external?: boolean;
  execute(input: I, ctx: ToolContext): Promise<string> | string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<I extends Record<string, unknown>>(tool: ToolDefinition<I>): this {
    if (this.tools.has(tool.name)) throw new Error(`Инструмент уже зарегистрирован: ${tool.name}`);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool.name)) throw new Error(`Некорректное имя инструмента: ${tool.name}`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  list(): { name: string; risk: RiskLevel; domain: DataDomain; mutates: boolean }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, risk: t.risk, domain: t.domain, mutates: t.mutates }));
  }
}
