// Формы данных API CRM «Сайберлос» (backend/src/routes/*): только поля, которые использует JARVIS.

export interface CrmUserRef {
  id: string;
  email: string;
  employeeProfile?: { fullName?: string | null } | null;
}

export interface CrmStage {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  slaHours: number | null;
  isWonStage: boolean;
  isLostStage: boolean;
}

export interface CrmPipelineField {
  id: string;
  label: string;
  type: string;
  required: boolean;
}

export interface CrmPipeline {
  id: string;
  slug: string;
  name: string;
  stages: CrmStage[];
  fields: CrmPipelineField[];
  dealsCount?: number;
}

export interface CrmDeal {
  id: string;
  pipelineId: string;
  stageId: string;
  title: string;
  status: 'open' | 'won' | 'lost' | string;
  lostReason: string | null;
  leadName: string | null;
  leadPhone: string | null;
  leadEmail: string | null;
  leadSource: string | null;
  customFields: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  stage?: CrmStage;
  assignees?: { user: CrmUserRef }[];
  dealerOrg?: { id: string; name: string } | null;
  productionOrder?: CrmProductionOrder | null;
}

export interface CrmTask {
  id: string;
  title: string;
  dealId: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled' | string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignee?: CrmUserRef;
  deal?: { id: string; title: string } | null;
}

export interface CrmProductionOrder {
  id: string;
  dealId: string;
  kind: string;
  quantity: number;
  plannedReadyAt: string | null;
  requiresPrepayment: boolean;
  paidAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  deal?: { id: string; title: string; stage?: CrmStage; dealerOrg?: { name: string } | null };
  shopProductVariant?: { label: string; product?: { name: string } } | null;
  responsibleUser?: CrmUserRef | null;
}

export interface CrmTeamMember {
  id: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  terminatedAt: string | null;
  role: { key: string; name: string } | null;
  profile?: { fullName?: string | null } | null;
}

export interface CrmInventoryItem {
  id: string;
  productName: string;
  categoryName: string;
  label: string;
  stockQty: number;
}

export interface CrmMe {
  id: string;
  email: string;
  role: string;
  roleRef: { key: string; name: string } | null;
  permissions?: string[];
}

export interface DealHistoryItem {
  id: string;
  kind: 'comment' | 'stage_change';
  fromStageName: string | null;
  toStageName: string | null;
  note: string | null;
  changedBy?: CrmUserRef | null;
  createdAt: string;
}

export const personName = (u?: CrmUserRef | null): string => (u ? u.employeeProfile?.fullName || u.email : '—');
