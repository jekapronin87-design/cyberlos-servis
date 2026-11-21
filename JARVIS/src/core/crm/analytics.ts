import { CrmError, type CrmClient } from './client';
import { personName, type CrmDeal, type CrmInventoryItem, type CrmMe, type CrmPipeline, type CrmProductionOrder, type CrmStage, type CrmTask, type CrmTeamMember } from './types';

export interface CrmSnapshot {
  now: Date;
  pipelines: CrmPipeline[];
  deals: CrmDeal[];
  tasks: CrmTask[];
  team: CrmTeamMember[];
  production: CrmProductionOrder[];
  inventory: CrmInventoryItem[];
  /** Разделы, недоступные из-за прав учётной записи. */
  missing: string[];
  truncated: boolean;
}

const MAX_DEALS = 5000;
const HOUR = 3_600_000;

/** Загружает срез данных CRM (только чтение). Недоступные по правам разделы пропускает и перечисляет. */
export async function loadSnapshot(client: CrmClient, now = new Date()): Promise<CrmSnapshot> {
  const missing: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CrmError && (e.status === 403 || e.status === 404)) {
        missing.push(label);
        return fallback;
      }
      throw e;
    }
  };
  const pipelines = await safe('воронки', () => client.get<CrmPipeline[]>('/crm/pipelines'), []);
  let deals: CrmDeal[] = [];
  let truncated = false;
  for (const p of pipelines) {
    const list = await safe(`сделки «${p.name}»`, () => client.get<CrmDeal[]>(`/crm/pipelines/${p.id}/deals`), []);
    for (const d of list) {
      if (deals.length >= MAX_DEALS) {
        truncated = true;
        break;
      }
      deals.push(d);
    }
  }
  // stage в сделке уже есть, но подстрахуемся справочником воронок
  const stageById = new Map<string, CrmStage>(pipelines.flatMap((p) => p.stages.map((s) => [s.id, s] as const)));
  deals = deals.map((d) => ({ ...d, stage: d.stage ?? stageById.get(d.stageId) }));
  const [tasks, team, production, inventory] = await Promise.all([
    safe('задачи', () => client.get<CrmTask[]>('/crm/tasks'), []),
    safe('команда', () => client.get<CrmTeamMember[]>('/crm/team'), []),
    safe('производство', () => client.get<CrmProductionOrder[]>('/crm/production-orders'), []),
    safe('склад', () => client.get<CrmInventoryItem[]>('/crm/inventory'), []),
  ]);
  return { now, pipelines, deals, tasks, team, production, inventory, missing, truncated };
}

export async function whoAmI(client: CrmClient): Promise<CrmMe> {
  return client.get<CrmMe>('/auth/me');
}

// ---------- вычисления ----------

const ageHours = (iso: string, now: Date): number => (now.getTime() - new Date(iso).getTime()) / HOUR;
export const isOpen = (d: CrmDeal): boolean => d.status === 'open' && !d.stage?.isWonStage && !d.stage?.isLostStage;
export const assigneeNames = (d: CrmDeal): string[] => (d.assignees ?? []).map((a) => personName(a.user));
const pipelineName = (s: CrmSnapshot, id: string): string => s.pipelines.find((p) => p.id === id)?.name ?? id;

export interface StuckDeal {
  deal: CrmDeal;
  hoursInStage: number;
  slaHours: number;
}

/**
 * Сделки, простаивающие дольше SLA стадии. Время простоя считается по updatedAt сделки —
 * это приближение (оно обновляется и при правке карточки); точное время — в истории сделки.
 */
export function stuckDeals(s: CrmSnapshot): StuckDeal[] {
  return s.deals
    .filter(isOpen)
    .map((deal) => ({ deal, hoursInStage: ageHours(deal.updatedAt, s.now), slaHours: deal.stage?.slaHours ?? 0 }))
    .filter((x) => x.slaHours > 0 && x.hoursInStage > x.slaHours)
    .sort((a, b) => b.hoursInStage / b.slaHours - a.hoursInStage / a.slaHours);
}

export const isOverdueTask = (t: CrmTask, now: Date): boolean => (t.status === 'open' || t.status === 'in_progress') && !!t.dueAt && new Date(t.dueAt) < now;

export function overdueProduction(s: CrmSnapshot): CrmProductionOrder[] {
  return s.production.filter((o) => !o.completedAt && o.plannedReadyAt && new Date(o.plannedReadyAt) < s.now);
}

export function lowStock(s: CrmSnapshot, threshold = 3): CrmInventoryItem[] {
  return s.inventory.filter((i) => i.stockQty <= threshold).sort((a, b) => a.stockQty - b.stockQty);
}

export interface Overview {
  pipelines: { name: string; slug: string; open: number; won: number; lost: number; byStage: { name: string; open: number; breaches: number }[] }[];
  newLast24h: number;
  newBySource: Record<string, number>;
  unassignedOpen: number;
  stuck: number;
  tasksOpen: number;
  tasksOverdue: number;
  productionOpen: number;
  productionOverdue: number;
  awaitingPrepayment: number;
  lowStock: number;
}

export function overview(s: CrmSnapshot): Overview {
  const stuck = stuckDeals(s);
  const stuckIds = new Set(stuck.map((x) => x.deal.id));
  const day = s.now.getTime() - 24 * HOUR;
  const fresh = s.deals.filter((d) => new Date(d.createdAt).getTime() >= day);
  const bySource: Record<string, number> = {};
  for (const d of fresh) bySource[d.leadSource ?? 'не указан'] = (bySource[d.leadSource ?? 'не указан'] ?? 0) + 1;
  return {
    pipelines: s.pipelines.map((p) => {
      const ds = s.deals.filter((d) => d.pipelineId === p.id);
      return {
        name: p.name,
        slug: p.slug,
        open: ds.filter(isOpen).length,
        won: ds.filter((d) => d.status === 'won').length,
        lost: ds.filter((d) => d.status === 'lost').length,
        byStage: p.stages
          .filter((st) => !st.isWonStage && !st.isLostStage)
          .map((st) => {
            const inStage = ds.filter((d) => d.stageId === st.id && isOpen(d));
            return { name: st.name, open: inStage.length, breaches: inStage.filter((d) => stuckIds.has(d.id)).length };
          }),
      };
    }),
    newLast24h: fresh.length,
    newBySource: bySource,
    unassignedOpen: s.deals.filter((d) => isOpen(d) && (d.assignees ?? []).length === 0).length,
    stuck: stuck.length,
    tasksOpen: s.tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').length,
    tasksOverdue: s.tasks.filter((t) => isOverdueTask(t, s.now)).length,
    productionOpen: s.production.filter((o) => !o.completedAt).length,
    productionOverdue: overdueProduction(s).length,
    awaitingPrepayment: s.production.filter((o) => !o.completedAt && o.requiresPrepayment && !o.paidAt).length,
    lowStock: lowStock(s).length,
  };
}

export interface ManagerRow {
  name: string;
  email: string;
  role: string;
  openDeals: number;
  stuckDeals: number;
  tasksOpen: number;
  tasksOverdue: number;
  doneOnTime: number;
  doneLate: number;
}

export function managerLoad(s: CrmSnapshot): ManagerRow[] {
  const stuckIds = new Set(stuckDeals(s).map((x) => x.deal.id));
  const rows = new Map<string, ManagerRow>();
  const row = (id: string, name: string, email: string, role = ''): ManagerRow => {
    let r = rows.get(id);
    if (!r) {
      r = { name, email, role, openDeals: 0, stuckDeals: 0, tasksOpen: 0, tasksOverdue: 0, doneOnTime: 0, doneLate: 0 };
      rows.set(id, r);
    }
    return r;
  };
  for (const m of s.team) if (m.isActive && !m.terminatedAt) row(m.id, m.profile?.fullName || m.email, m.email, m.role?.name ?? '');
  for (const d of s.deals.filter(isOpen)) {
    for (const a of d.assignees ?? []) {
      const r = row(a.user.id, personName(a.user), a.user.email);
      r.openDeals++;
      if (stuckIds.has(d.id)) r.stuckDeals++;
    }
  }
  for (const t of s.tasks) {
    if (!t.assignee) continue;
    const r = row(t.assignee.id, personName(t.assignee), t.assignee.email);
    if (t.status === 'open' || t.status === 'in_progress') {
      r.tasksOpen++;
      if (isOverdueTask(t, s.now)) r.tasksOverdue++;
    } else if (t.status === 'done' && t.dueAt && t.completedAt) {
      if (new Date(t.completedAt) <= new Date(t.dueAt)) r.doneOnTime++;
      else r.doneLate++;
    }
  }
  return [...rows.values()].sort((a, b) => b.stuckDeals + b.tasksOverdue - (a.stuckDeals + a.tasksOverdue));
}

export type IssueKind =
  | 'missing_required_field'
  | 'no_next_action'
  | 'no_assignee'
  | 'stuck'
  | 'lost_without_reason'
  | 'status_stage_mismatch'
  | 'lead_without_contact'
  | 'production_unpaid_in_work'
  | 'production_overdue';

export const ISSUE_TITLE: Record<IssueKind, string> = {
  missing_required_field: 'Не заполнены обязательные поля',
  no_next_action: 'Не назначено следующее действие',
  no_assignee: 'Нет ответственного',
  stuck: 'Сделка простаивает дольше срока стадии',
  lost_without_reason: 'Отказ без указанной причины',
  status_stage_mismatch: 'Статус сделки не соответствует стадии',
  lead_without_contact: 'У заявки нет контактов',
  production_unpaid_in_work: 'Производство начато без предоплаты',
  production_overdue: 'Просрочен плановый срок производства',
};

/** Тема обучения для каждого типа ошибки (используется ИИ-наставником). */
export const ISSUE_TOPIC: Record<IssueKind, string> = {
  missing_required_field: 'Заполнение карточки сделки и обязательных полей',
  no_next_action: 'Постановка следующего действия (задачи) по сделке',
  no_assignee: 'Назначение ответственных и взятие заявки в работу',
  stuck: 'Работа со сроками стадий (SLA) и приоритизация',
  lost_without_reason: 'Фиксация причины отказа',
  status_stage_mismatch: 'Правильный выбор этапа воронки и закрытие сделки',
  lead_without_contact: 'Сбор контактов клиента',
  production_unpaid_in_work: 'Регламент предоплаты и запуск производства',
  production_overdue: 'Планирование сроков производства и переносы',
};

export interface Issue {
  kind: IssueKind;
  dealId: string;
  title: string;
  pipeline: string;
  stage: string;
  who: string[];
  detail: string;
  /** Имя клиента из карточки — нужно, чтобы вырезать его из названий при маскировании. */
  leadName?: string | null;
}

/**
 * Ошибки в работе с CRM. Это не оценка сотрудника, а повод предложить обучение: наставник объясняет ошибку
 * и даёт задание, ничего не наказывает.
 */
export function qualityIssues(s: CrmSnapshot): Issue[] {
  const out: Issue[] = [];
  const openTaskDealIds = new Set(s.tasks.filter((t) => t.status === 'open' || t.status === 'in_progress').map((t) => t.dealId).filter(Boolean) as string[]);
  const stuckIds = new Set(stuckDeals(s).map((x) => x.deal.id));
  const push = (kind: IssueKind, d: CrmDeal, detail: string): void => {
    out.push({ kind, dealId: d.id, title: d.title, pipeline: pipelineName(s, d.pipelineId), stage: d.stage?.name ?? '', who: assigneeNames(d), detail, leadName: d.leadName });
  };
  for (const d of s.deals) {
    const p = s.pipelines.find((x) => x.id === d.pipelineId);
    const open = isOpen(d);
    if (open && p) {
      const missing = p.fields.filter((f) => f.required && (d.customFields?.[f.id] === undefined || d.customFields?.[f.id] === null || d.customFields?.[f.id] === ''));
      if (missing.length) push('missing_required_field', d, `Не заполнено: ${missing.map((m) => m.label).join(', ')}`);
    }
    if (open && !openTaskDealIds.has(d.id)) push('no_next_action', d, 'По сделке нет ни одной открытой задачи');
    if (open && (d.assignees ?? []).length === 0) push('no_assignee', d, 'Сделка никому не назначена');
    if (open && stuckIds.has(d.id)) push('stuck', d, `Простой дольше SLA стадии «${d.stage?.name}» (${d.stage?.slaHours} ч)`);
    if (d.status === 'lost' && !d.lostReason) push('lost_without_reason', d, 'Статус «отказ», причина не указана');
    if ((d.stage?.isWonStage && d.status !== 'won') || (d.stage?.isLostStage && d.status !== 'lost') || (d.status === 'won' && !d.stage?.isWonStage) || (d.status === 'lost' && !d.stage?.isLostStage)) {
      push('status_stage_mismatch', d, `Статус «${d.status}», стадия «${d.stage?.name}»`);
    }
    if (open && p?.slug === 'cold_leads' && !d.leadPhone && !d.leadEmail) push('lead_without_contact', d, 'Нет ни телефона, ни почты');
  }
  for (const o of s.production.filter((x) => !x.completedAt)) {
    const dealStub = s.deals.find((d) => d.id === o.dealId);
    const stageKey = o.deal?.stage?.key ?? dealStub?.stage?.key;
    const base = dealStub ?? ({ id: o.dealId, title: o.deal?.title ?? 'Заказ', pipelineId: '', stageId: '', status: 'open', assignees: [], stage: o.deal?.stage } as unknown as CrmDeal);
    if (o.requiresPrepayment && !o.paidAt && (stageKey === 'in_production' || stageKey === 'ready')) push('production_unpaid_in_work', { ...base, pipelineId: base.pipelineId }, 'Заказ требует предоплаты, оплата не отмечена');
    if (o.plannedReadyAt && new Date(o.plannedReadyAt) < s.now) push('production_overdue', base, `Плановая готовность: ${o.plannedReadyAt.slice(0, 10)}`);
  }
  return out;
}

export interface TrainingNeed {
  employee: string;
  total: number;
  topics: { topic: string; kind: IssueKind; count: number }[];
}

/** Группировка ошибок по сотрудникам → рекомендуемые темы обучения. */
export function trainingNeeds(issues: Issue[]): TrainingNeed[] {
  const by = new Map<string, Map<IssueKind, number>>();
  for (const i of issues) {
    for (const who of i.who.length ? i.who : ['(без ответственного)']) {
      const m = by.get(who) ?? new Map<IssueKind, number>();
      m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
      by.set(who, m);
    }
  }
  return [...by.entries()]
    .map(([employee, m]) => ({
      employee,
      total: [...m.values()].reduce((a, b) => a + b, 0),
      topics: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ topic: ISSUE_TOPIC[kind], kind, count })),
    }))
    .sort((a, b) => b.total - a.total);
}

export interface Bottleneck {
  pipeline: string;
  stage: string;
  open: number;
  breaches: number;
  avgAgeHours: number;
}

export function bottlenecks(s: CrmSnapshot): { stages: Bottleneck[]; lostReasons: [string, number][]; conversion: { pipeline: string; won: number; lost: number; rate: number | null }[] } {
  const stuckIds = new Set(stuckDeals(s).map((x) => x.deal.id));
  const stages: Bottleneck[] = [];
  for (const p of s.pipelines) {
    for (const st of p.stages.filter((x) => !x.isWonStage && !x.isLostStage)) {
      const ds = s.deals.filter((d) => d.stageId === st.id && isOpen(d));
      if (!ds.length) continue;
      stages.push({
        pipeline: p.name,
        stage: st.name,
        open: ds.length,
        breaches: ds.filter((d) => stuckIds.has(d.id)).length,
        avgAgeHours: ds.reduce((a, d) => a + ageHours(d.updatedAt, s.now), 0) / ds.length,
      });
    }
  }
  stages.sort((a, b) => b.breaches / b.open - a.breaches / a.open || b.avgAgeHours - a.avgAgeHours);
  const lost = new Map<string, number>();
  for (const d of s.deals.filter((x) => x.status === 'lost')) lost.set(d.lostReason || 'не указана', (lost.get(d.lostReason || 'не указана') ?? 0) + 1);
  return {
    stages,
    lostReasons: [...lost.entries()].sort((a, b) => b[1] - a[1]),
    conversion: s.pipelines.map((p) => {
      const won = s.deals.filter((d) => d.pipelineId === p.id && d.status === 'won').length;
      const lostN = s.deals.filter((d) => d.pipelineId === p.id && d.status === 'lost').length;
      return { pipeline: p.name, won, lost: lostN, rate: won + lostN > 0 ? won / (won + lostN) : null };
    }),
  };
}
