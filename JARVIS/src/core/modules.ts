import type { ModuleId } from '../shared/types';

/** К какому модулю относится инструмент (по имени). Не перечисленные — ядро: они доступны всегда. */
const PREFIX: [RegExp, ModuleId][] = [
  [/^(fs_|app_|browser_|screen_|camera_|lesson_show$)/, 'computer'],
  [/^(project_|code_|run_script$|npm_install$|git_|delegate_task$)/, 'dev'],
  [/^crm_/, 'crm'],
  [/^(kb_|mentor_)/, 'mentor'],
  [/^schedule_/, 'scheduler'],
  [/^(call_|telephony_)/, 'telephony'],
  [/^telegram_/, 'telegram'],
  [/^agent_/, 'agents'],
  [/^youtube_/, 'youtube'],
  [/^video_/, 'video'],
];

export function moduleOfTool(name: string): ModuleId | null {
  return PREFIX.find(([re]) => re.test(name))?.[1] ?? null;
}

export function isToolEnabled(name: string, disabled: readonly ModuleId[]): boolean {
  const m = moduleOfTool(name);
  return !m || !disabled.includes(m);
}
