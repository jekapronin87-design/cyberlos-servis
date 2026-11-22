import type { Settings } from '../../shared/types';
import type { ExecContext, ToolExecutor, ToolResultBlock, ToolUseBlock } from '../chat/executor';
import type { ProviderManager } from '../providers/manager';
import type { ProviderMessage } from '../providers/types';
import type { AuditLog } from '../security/audit';
import type { ToolRegistry } from '../tools/registry';
import { buildAgentPrompt } from './agentPrompts';

export type AgentId = 'developer' | 'tester' | 'reviewer';

export interface AgentRole {
  id: AgentId;
  title: string;
  /** Инструменты, доступные роли. Всё остальное для неё не существует. */
  tools: string[];
  mission: string;
}

const READ = ['fs_list_allowed', 'fs_list', 'fs_search', 'fs_read', 'project_overview', 'code_search', 'git_status', 'git_diff', 'git_log'];

/**
 * Роли разделяют полномочия: разработчик пишет код, тестировщик запускает проверки и пишет тесты (но не правит рабочий код),
 * ревьюер только читает. Ни одна роль не может делегировать задачи дальше и не получает прав сверх основного ассистента —
 * каждое её действие проходит ту же политику и те же подтверждения.
 */
export const ROLES: Record<AgentId, AgentRole> = {
  developer: {
    id: 'developer',
    title: 'Разработчик',
    tools: [...READ, 'code_edit', 'fs_write', 'fs_mkdir', 'project_scaffold', 'project_templates', 'run_script', 'npm_install', 'git_init', 'git_branch', 'git_commit'],
    mission:
      'Ты пишешь и исправляешь код по задаче. Сначала изучи проект (project_overview, code_search, fs_read), затем вноси МИНИМАЛЬНЫЕ правки через code_edit; ' +
      'после правок запусти проверки (run_script: test/typecheck/lint/build) и исправляй ошибки, пока всё не заработает. Не меняй то, что не относится к задаче. ' +
      'Для новых проектов используй project_scaffold. Коммить только когда проверки проходят.',
  },
  tester: {
    id: 'tester',
    title: 'Тестировщик',
    tools: [...READ, 'fs_write', 'fs_mkdir', 'run_script'],
    mission:
      'Ты проверяешь качество. Запусти существующие проверки (run_script), найди непокрытые места и добавь НОВЫЕ тестовые файлы (fs_write). ' +
      'Рабочий код ты не правишь: если нашёл ошибку — опиши её точно (файл, строка, как воспроизвести, ожидаемое и фактическое поведение). ' +
      'Не подгоняй тесты под неверное поведение.',
  },
  reviewer: {
    id: 'reviewer',
    title: 'Ревьюер',
    tools: [...READ],
    mission:
      'Ты делаешь ревью кода только на чтение. Изучи изменения (git_status, git_diff) и связанный код. Найди: ошибки логики, граничные случаи, проблемы безопасности ' +
      '(инъекции, секреты в коде, небезопасная работа с файлами/сетью), нарушения стиля проекта, отсутствие тестов. Выведи список замечаний по убыванию важности с файлом и строкой; ' +
      'если замечаний нет — так и скажи. Ничего не меняй.',
  },
};

export const MAX_AGENT_STEPS = 15;

export interface AgentRunDeps {
  providers: ProviderManager;
  getSettings: () => Settings;
  tools: ToolRegistry;
  executor: ToolExecutor;
  audit: AuditLog;
}

export interface AgentRunResult {
  report: string;
  steps: string[];
  stoppedByLimit: boolean;
}

/**
 * Запускает роль как отдельный цикл «модель → инструменты». Сообщения роли не пишутся в историю диалога
 * (в чат возвращается только итоговый отчёт и краткий ход работы), все вызовы инструментов — через ToolExecutor.
 */
export class AgentRunner {
  constructor(private d: AgentRunDeps) {}

  async run(id: AgentId, task: string, projectPath: string, ctx: Omit<ExecContext, 'actor' | 'allowedTools'>): Promise<AgentRunResult> {
    const role = ROLES[id];
    const allowed = new Set(role.tools.filter((t) => this.d.tools.get(t)));
    return this.runSpec({ actor: `agent:${id}`, system: buildAgentPrompt(role, projectPath), allowed, maxSteps: MAX_AGENT_STEPS, auditDetails: { project: projectPath, taskChars: task.length } }, task, ctx);
  }

  /** Общий цикл «модель → инструменты» для встроенных ролей и пользовательских агентов. Инструменты — только из `allowed`, всё через ToolExecutor. */
  async runSpec(
    spec: { actor: string; system: string; allowed: Set<string>; maxSteps: number; auditDetails?: Record<string, unknown> },
    task: string,
    ctx: Omit<ExecContext, 'actor' | 'allowedTools'>,
    onStep?: (line: string) => void,
  ): Promise<AgentRunResult> {
    const settings = this.d.getSettings();
    const resolved = this.d.providers.resolve(settings);
    if (resolved.mode === 'demo') {
      throw new Error('Агенты работают только с настоящей моделью. Подключите ключ Claude (или бесплатную модель) в «Настройках».');
    }
    const { actor, system, allowed } = spec;
    const MAX = spec.maxSteps;
    const specs = this.d.tools.specs().filter((s) => allowed.has(s.name));
    this.d.audit.record({ actor, action: 'agent.start', decision: 'info', details: spec.auditDetails ?? { taskChars: task.length } });
    const messages: ProviderMessage[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];
    const steps: string[] = [];
    let report = '';
    let stoppedByLimit = false;

    for (let step = 0; step <= MAX; step++) {
      if (ctx.signal.aborted) {
        report ||= 'Остановлено пользователем.';
        break;
      }
      const last = step === MAX;
      let text = '';
      const uses: ToolUseBlock[] = [];
      try {
        for await (const ev of resolved.provider.stream(
          { system, messages, tools: last ? [] : specs, model: settings.model, maxTokens: 4096 },
          ctx.signal,
        )) {
          if (ctx.signal.aborted) break;
          if (ev.type === 'text') text += ev.text;
          else if (ev.type === 'tool_use') uses.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        }
      } catch (e) {
        if (!ctx.signal.aborted) throw e;
      }
      if (ctx.signal.aborted) {
        report = text.trim() || 'Остановлено пользователем.';
        break;
      }
      if (uses.length === 0) {
        report = text.trim();
        break;
      }
      messages.push({ role: 'assistant', content: [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...uses] });
      const results: ToolResultBlock[] = [];
      for (const use of uses) {
        const r = await this.d.executor.execute(use, { ...ctx, actor, allowedTools: allowed });
        results.push(r);
        const line = `${r.denied ? '✗' : r.isError ? '!' : '✓'} ${use.name}${summarize(use.input)}`;
        steps.push(line);
        onStep?.(line);
      }
      messages.push({ role: 'tool', content: results });
      if (last) stoppedByLimit = true;
    }
    if (!report) {
      stoppedByLimit = true;
      report = 'Агент исчерпал лимит шагов, не завершив задачу. Промежуточный результат — в журнале шагов.';
    }
    this.d.audit.record({ actor, action: 'agent.finish', decision: 'info', details: { steps: steps.length, stoppedByLimit } });
    return { report, steps, stoppedByLimit };
  }
}

function summarize(input: Record<string, unknown>): string {
  const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
  return first ? ` (${first.length > 60 ? first.slice(0, 57) + '…' : first})` : '';
}
