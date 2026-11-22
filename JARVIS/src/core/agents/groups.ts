import type { AgentGroupId } from '../../shared/types';
import type { ToolRegistry } from '../tools/registry';

/** Какие инструменты входят в группу прав. Агент получает ТОЛЬКО инструменты выбранных групп (плюс безобидные «время» и «чтение памяти»). */
const GROUP_TOOLS: Record<AgentGroupId, RegExp> = {
  youtube: /^youtube_/,
  web: /^(browser_(open|search|read|scroll|back|click|type|press|screenshot|close))$/,
  files: /^fs_/,
  apps: /^app_/,
  crm: /^crm_/,
  dev: /^(project_|code_|run_script$|npm_install$|git_)/,
  telegram: /^telegram_/,
  knowledge: /^(kb_|mentor_)/,
  images: /^image_generate$/,
  screen: /^(screen_capture|camera_)/,
};

/** Всегда доступно агенту: узнать время и прочитать память пользователя. */
const BASE = /^(get_datetime|list_memory)$/;

/** Никогда не доступно агентам: рекурсия (агенты, субагенты, расписание), изменение памяти/досье, обучение и всё, что меняет настройки. */
const NEVER = /^(agent_|delegate_task$|schedule_|remember$|forget_memory$|profile_|lesson_show$|call_)/;

/** Тратят деньги или запускают программы, хотя формально ничего не «меняют»: в режиме «только чтение» не даются. */
const READ_EXCLUDE = /^(image_generate|app_open)$/;

export function toolsForAgent(groups: AgentGroupId[], mode: 'read' | 'act', registry: ToolRegistry): Set<string> {
  const info = registry.list();
  const allowed = new Set<string>();
  for (const t of info) {
    if (NEVER.test(t.name)) continue;
    const inGroup = BASE.test(t.name) || groups.some((g) => GROUP_TOOLS[g].test(t.name));
    if (!inGroup) continue;
    // «Только чтение»: инструменты, меняющие что-либо, агенту не даются вовсе (а не просто «спросят подтверждение»)
    if (mode === 'read' && (t.mutates || READ_EXCLUDE.test(t.name))) continue;
    allowed.add(t.name);
  }
  return allowed;
}
