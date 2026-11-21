import type { DataDomain, RiskLevel, Role, Settings } from '../../shared/types';

export const RISK_ORDER: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
const rank = (r: RiskLevel): number => RISK_ORDER.indexOf(r);

/** Максимальный уровень риска, который роль вообще может инициировать. */
const ROLE_MAX_RISK: Record<Role, RiskLevel> = {
  viewer: 'safe',
  employee: 'low',
  manager: 'medium',
  owner: 'high',
};

export interface ToolPolicyInfo {
  name: string;
  risk: RiskLevel;
  /** Меняет ли инструмент данные. */
  mutates: boolean;
  domain: DataDomain;
}

export type PolicyDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'confirm'; reason: string }
  | { decision: 'deny'; reason: string };

/**
 * Политика безопасности — единственное место, где решается, можно ли выполнить действие.
 * Решение принимает код, а не модель: никакой текст из документов или ответа ИИ его не меняет.
 *
 * Правила (по порядку):
 *  1. Запись в производственные данные запрещена, пока явно не разрешена в настройках — и даже тогда
 *     требует подтверждения каждый раз.
 *  2. critical запрещён всегда.
 *  3. Роль не может превышать свой потолок риска.
 *  4. high — всегда с подтверждением; medium/low — по порогу из настроек; safe — без подтверждения.
 */
export function decide(tool: ToolPolicyInfo, role: Role, settings: Pick<Settings, 'confirmFrom' | 'allowProductionWrites'>): PolicyDecision {
  if (tool.domain === 'production' && tool.mutates) {
    if (!settings.allowProductionWrites) {
      return { decision: 'deny', reason: 'Изменение производственных данных запрещено настройками безопасности' };
    }
    if (role !== 'owner') {
      return { decision: 'deny', reason: 'Изменять производственные данные может только владелец' };
    }
    return { decision: 'confirm', reason: 'Изменение производственных данных требует подтверждения' };
  }
  if (tool.risk === 'critical') {
    return { decision: 'deny', reason: 'Критически опасные действия запрещены' };
  }
  if (rank(tool.risk) > rank(ROLE_MAX_RISK[role])) {
    return { decision: 'deny', reason: `Роль «${role}» не может выполнять действия уровня «${tool.risk}»` };
  }
  if (tool.risk === 'high') {
    return { decision: 'confirm', reason: 'Опасное действие — всегда требует подтверждения' };
  }
  if (tool.risk === 'safe') {
    return { decision: 'allow', reason: 'Безопасное действие' };
  }
  if (rank(tool.risk) >= rank(settings.confirmFrom)) {
    return { decision: 'confirm', reason: `Действие уровня «${tool.risk}» требует подтверждения` };
  }
  return { decision: 'allow', reason: 'Разрешено политикой' };
}
