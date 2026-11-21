import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import type { SecretStore } from '../security/secrets';
import type { ToolRegistry } from '../tools/registry';
import { assigneeNames, bottlenecks, isOpen, ISSUE_TITLE, loadSnapshot, lowStock, managerLoad, overdueProduction, overview, qualityIssues, stuckDeals, trainingNeeds, whoAmI, type CrmSnapshot } from './analytics';
import { CrmClient, CrmError, READ_PERMISSIONS, SECRET_CRM_PASSWORD, validateCrmBaseUrl, WRITE_LIKE_PERMISSIONS, type CrmConfig } from './client';
import { maskEmail, maskFreeText, maskKnownNames, maskName, maskPhone } from './mask';
import { personName, type CrmDeal } from './types';

const KEY = (k: string): string => `crm.${k}`;
const CACHE_MS = 60_000;

export interface CrmStatus {
  configured: boolean;
  baseUrl: string;
  environment: 'test' | 'production';
  email: string;
  hasPassword: boolean;
  maskPii: boolean;
}

export interface CrmTestResult {
  ok: boolean;
  error?: string;
  user?: { email: string; role: string; roleName: string | null };
  permissions?: string[];
  missingRead: string[];
  writeLike: string[];
  fullAdmin: boolean;
  /** Учётная запись пригодна для «только чтение» без оговорок. */
  readOnlySafe: boolean;
}

export class CrmService {
  readonly client: CrmClient;
  private cache: { at: number; snap: CrmSnapshot } | null = null;

  constructor(
    private db: Db,
    private secrets: SecretStore,
    private audit: AuditLog,
    fetchImpl?: typeof fetch,
    private now: () => Date = () => new Date(),
  ) {
    this.client = new CrmClient(() => this.getConfig(), secrets, fetchImpl);
  }

  private read<T>(key: string, def: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY(key)) as { value: string } | undefined;
    if (!r) return def;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return def;
    }
  }
  private write(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(KEY(key), JSON.stringify(value), nowIso());
  }

  getConfig(): CrmConfig | null {
    const baseUrl = this.read('baseUrl', '');
    const email = this.read('email', '');
    if (!baseUrl || !email) return null;
    return { baseUrl, email, environment: this.read<'test' | 'production'>('environment', 'test'), maskPii: this.read('maskPii', true) };
  }

  status(): CrmStatus {
    return {
      configured: this.client.configured(),
      baseUrl: this.read('baseUrl', ''),
      environment: this.read('environment', 'test'),
      email: this.read('email', ''),
      hasPassword: this.secrets.has(SECRET_CRM_PASSWORD),
      maskPii: this.read('maskPii', true),
    };
  }

  save(cfg: { baseUrl: string; environment: 'test' | 'production'; email: string; maskPii: boolean }, password?: string): void {
    const baseUrl = validateCrmBaseUrl(cfg.baseUrl);
    if (cfg.environment !== 'test' && cfg.environment !== 'production') throw new Error('Окружение: test или production');
    const email = String(cfg.email).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Некорректный email учётной записи');
    this.write('baseUrl', baseUrl);
    this.write('environment', cfg.environment);
    this.write('email', email);
    this.write('maskPii', cfg.maskPii !== false);
    if (password !== undefined && password !== '') {
      if (password.length > 300) throw new Error('Слишком длинный пароль');
      this.secrets.set(SECRET_CRM_PASSWORD, password);
    }
    this.client.resetSession();
    this.cache = null;
    this.audit.record({ actor: 'user', action: 'crm.configured', risk: 'high', decision: 'info', details: { baseUrl, environment: cfg.environment, email, maskPii: cfg.maskPii !== false } });
  }

  disconnect(): void {
    for (const k of ['baseUrl', 'email']) this.write(k, '');
    this.secrets.delete(SECRET_CRM_PASSWORD);
    this.client.resetSession();
    this.cache = null;
    this.audit.record({ actor: 'user', action: 'crm.disconnected', decision: 'info' });
  }

  /** Проверка подключения и пригодности учётной записи для режима «только чтение». */
  async test(): Promise<CrmTestResult> {
    try {
      this.client.resetSession();
      const me = await whoAmI(this.client);
      const perms = me.permissions;
      const fullAdmin = me.role === 'admin' && !me.roleRef;
      const have = new Set(perms ?? []);
      const missingRead = fullAdmin ? [] : READ_PERMISSIONS.filter((p) => !have.has(p));
      const writeLike = fullAdmin ? ['полный доступ администратора'] : WRITE_LIKE_PERMISSIONS.filter((p) => have.has(p));
      this.audit.record({ actor: 'user', action: 'crm.test', decision: 'info', details: { ok: true, role: me.roleRef?.key ?? me.role } });
      return {
        ok: true,
        user: { email: me.email, role: me.role, roleName: me.roleRef?.name ?? null },
        permissions: perms,
        missingRead,
        writeLike,
        fullAdmin,
        readOnlySafe: writeLike.length === 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка подключения';
      this.audit.record({ actor: 'user', action: 'crm.test', decision: 'error', details: { error: msg } });
      return { ok: false, error: msg, missingRead: [], writeLike: [], fullAdmin: false, readOnlySafe: false };
    }
  }

  async snapshot(force = false): Promise<CrmSnapshot> {
    if (!this.client.configured()) throw new CrmError('CRM не подключена. Откройте Настройки → CRM.');
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.snap;
    const snap = await loadSnapshot(this.client, this.now());
    this.cache = { at: Date.now(), snap };
    return snap;
  }

  /** Структурированная сводка для экрана «CRM». */
  async dashboard(): Promise<{
    overview: ReturnType<typeof overview>;
    managers: ReturnType<typeof managerLoad>;
    issues: ReturnType<typeof qualityIssues>;
    needs: ReturnType<typeof trainingNeeds>;
    missing: string[];
    truncated: boolean;
    at: string;
  }> {
    const s = await this.snapshot(true);
    const issues = qualityIssues(s);
    return { overview: overview(s), managers: managerLoad(s), issues: issues.slice(0, 200), needs: trainingNeeds(issues), missing: s.missing, truncated: s.truncated, at: s.now.toISOString() };
  }

  maskPii(): boolean {
    return this.read('maskPii', true);
  }
}

// ---------- инструменты ----------

const h = (n: number): string => (n < 48 ? `${Math.round(n)} ч` : `${Math.round(n / 24)} дн`);
const MAX_ROWS = 50;

export function registerCrmTools(registry: ToolRegistry, crm: CrmService): void {
  const mk = () => {
    const mask = crm.maskPii();
    return {
      text: (t: string | null | undefined): string => (mask ? maskFreeText(t ?? '') : (t ?? '')),
      /** Текст про конкретную сделку: вырезает имя клиента из карточки + телефоны и почту. */
      deal: (t: string | null | undefined, leadName?: string | null): string => (mask ? maskFreeText(maskKnownNames(t ?? '', leadName)) : (t ?? '')),
      name: (t: string | null | undefined): string => (mask ? maskName(t) : (t ?? '')),
      phone: (t: string | null | undefined): string => (mask ? maskPhone(t) : (t ?? '')),
      email: (t: string | null | undefined): string => (mask ? maskEmail(t) : (t ?? '')),
    };
  };
  const common = { risk: 'low' as const, mutates: false, domain: 'production' as const, external: true };
  const missingNote = (s: CrmSnapshot): string => (s.missing.length ? `\n(Нет доступа к разделам: ${s.missing.join(', ')} — добавьте учётной записи JARVIS права «просмотр».)` : '') + (s.truncated ? '\n(Показаны не все сделки: достигнут лимит 5000.)' : '');

  registry.register({
    ...common,
    name: 'crm_status',
    description: 'Проверяет, подключена ли CRM «Сайберлос», в каком окружении (тест/рабочая) и под какой учётной записью. CRM доступна JARVIS только для чтения.',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Проверить подключение к CRM',
    execute: () => {
      const s = crm.status();
      if (!s.configured) return 'CRM не подключена. Пользователю нужно открыть «Настройки → CRM» и указать адрес и учётную запись только для чтения.';
      return `CRM подключена: ${s.baseUrl}, окружение: ${s.environment === 'test' ? 'ТЕСТОВОЕ' : 'РАБОЧЕЕ'}, учётная запись: ${s.email}. Режим: только чтение. Персональные данные клиентов ${s.maskPii ? 'маскируются' : 'передаются без маскирования'}.`;
    },
  });

  registry.register({
    ...common,
    name: 'crm_overview',
    description: 'Сводка по CRM: воронки и стадии, новые заявки за сутки, сделки без ответственного, просрочки SLA, задачи, производство, склад. Начинай анализ с неё.',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Получить сводку по CRM (только чтение)',
    execute: async () => {
      const s = await crm.snapshot();
      const o = overview(s);
      const lines = [`Срез на ${s.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
      for (const p of o.pipelines) {
        lines.push(`▸ ${p.name}: открыто ${p.open}, выиграно ${p.won}, отказов ${p.lost}`);
        for (const st of p.byStage.filter((x) => x.open)) lines.push(`    ${st.name}: ${st.open}${st.breaches ? ` (просрочено по SLA: ${st.breaches})` : ''}`);
      }
      lines.push('', `Новых за 24 ч: ${o.newLast24h}${Object.keys(o.newBySource).length ? ' (' + Object.entries(o.newBySource).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : ''}`);
      lines.push(`Открытых сделок без ответственного: ${o.unassignedOpen}`, `Сделок с просрочкой SLA: ${o.stuck}`);
      lines.push(`Задачи: открытых ${o.tasksOpen}, просроченных ${o.tasksOverdue}`);
      lines.push(`Производство: в работе ${o.productionOpen}, просрочено ${o.productionOverdue}, ждут предоплаты ${o.awaitingPrepayment}; позиций склада на исходе: ${o.lowStock}`);
      return lines.join('\n') + missingNote(s);
    },
  });

  registry.register<{ pipeline?: string; stage?: string; status?: string; assignee?: string; stuck?: boolean; limit?: number }>({
    ...common,
    name: 'crm_deals',
    description: 'Список сделок/заявок с фильтрами: pipeline (slug: cold_leads, dealer_acquisition, dealer_sales, production), stage (название или ключ), status (open/won/lost), assignee (часть имени), stuck=true (только просроченные по SLA). До 50 строк.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'string' },
        stage: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost'] },
        assignee: { type: 'string' },
        stuck: { type: 'boolean' },
        limit: { type: 'integer' },
      },
    },
    describe: (i) => `Список сделок CRM (${[i.pipeline, i.stage, i.status].filter(Boolean).join(', ') || 'все'})`,
    execute: async (i) => {
      const s = await crm.snapshot();
      const m = mk();
      let ds: CrmDeal[] = s.deals;
      if (i.pipeline) {
        const p = s.pipelines.find((x) => x.slug === i.pipeline || x.name.toLowerCase().includes(String(i.pipeline).toLowerCase()));
        if (!p) throw new Error(`Воронка «${i.pipeline}» не найдена. Доступные: ${s.pipelines.map((x) => x.slug).join(', ')}`);
        ds = ds.filter((d) => d.pipelineId === p.id);
      }
      if (i.stage) ds = ds.filter((d) => d.stage?.key === i.stage || d.stage?.name.toLowerCase().includes(String(i.stage).toLowerCase()));
      if (i.status) ds = ds.filter((d) => d.status === i.status);
      if (i.assignee) ds = ds.filter((d) => assigneeNames(d).some((n) => n.toLowerCase().includes(String(i.assignee).toLowerCase())));
      const stuckMap = new Map(stuckDeals(s).map((x) => [x.deal.id, x]));
      if (i.stuck) ds = ds.filter((d) => stuckMap.has(d.id));
      const limit = Math.min(Math.max(Number(i.limit) || 30, 1), MAX_ROWS);
      const rows = ds.slice(0, limit).map((d) => {
        const st = stuckMap.get(d.id);
        return `• ${m.deal(d.title, d.leadName)} [${d.stage?.name ?? '?'}] ${d.status}; ответственные: ${assigneeNames(d).join(', ') || 'нет'}; клиент: ${[m.name(d.leadName), m.phone(d.leadPhone)].filter(Boolean).join(', ') || '—'}; источник: ${d.leadSource ?? '—'}; обновлено ${h((s.now.getTime() - new Date(d.updatedAt).getTime()) / 3_600_000)} назад${st ? ` ⚠ просрочка SLA (${h(st.hoursInStage)} при норме ${st.slaHours} ч)` : ''}; id ${d.id}`;
      });
      return `Найдено сделок: ${ds.length}${ds.length > limit ? ` (показано ${limit})` : ''}\n${rows.join('\n') || '—'}${missingNote(s)}`;
    },
  });

  registry.register<{ dealId: string }>({
    ...common,
    name: 'crm_deal_history',
    description: 'История сделки: переходы между стадиями и комментарии (кто и когда).',
    inputSchema: { type: 'object', properties: { dealId: { type: 'string' } }, required: ['dealId'] },
    describe: (i) => `Прочитать историю сделки ${i.dealId}`,
    execute: async (i) => {
      if (!/^[\w-]{1,40}$/.test(String(i.dealId))) throw new Error('Некорректный id сделки');
      const m = mk();
      const lead = (await crm.snapshot()).deals.find((d) => d.id === i.dealId)?.leadName;
      const hist = await crm.client.get<import('./types').DealHistoryItem[]>(`/crm/pipelines/deals/${i.dealId}/history`);
      return hist.slice(-40).map((e) => `${e.createdAt.slice(0, 16).replace('T', ' ')} ${personName(e.changedBy)}: ${e.kind === 'comment' ? 'комментарий — ' + m.deal(e.note, lead) : `${e.fromStageName ?? '—'} → ${e.toStageName}${e.note ? ' (' + m.deal(e.note, lead) + ')' : ''}`}`).join('\n') || 'История пуста.';
    },
  });

  registry.register<{ assignee?: string; overdue?: boolean; status?: string }>({
    ...common,
    name: 'crm_tasks',
    description: 'Задачи сотрудников CRM: фильтры assignee (часть имени), overdue=true (просроченные), status.',
    inputSchema: { type: 'object', properties: { assignee: { type: 'string' }, overdue: { type: 'boolean' }, status: { type: 'string' } } },
    describe: () => 'Список задач CRM',
    execute: async (i) => {
      const s = await crm.snapshot();
      let ts = s.tasks;
      if (i.assignee) ts = ts.filter((t) => personName(t.assignee).toLowerCase().includes(String(i.assignee).toLowerCase()));
      if (i.status) ts = ts.filter((t) => t.status === i.status);
      if (i.overdue) ts = ts.filter((t) => (t.status === 'open' || t.status === 'in_progress') && t.dueAt && new Date(t.dueAt) < s.now);
      const m = mk();
      const lead = (id: string | null | undefined): string | null | undefined => s.deals.find((d) => d.id === id)?.leadName;
      return `Задач: ${ts.length}\n` + ts.slice(0, MAX_ROWS).map((t) => `• ${m.deal(t.title, lead(t.dealId))} — ${personName(t.assignee)}; ${t.status}; срок ${t.dueAt?.slice(0, 16).replace('T', ' ') ?? '—'}${t.deal ? '; сделка: ' + m.deal(t.deal.title, lead(t.dealId)) : ''}`).join('\n') + missingNote(s);
    },
  });

  registry.register({
    ...common,
    name: 'crm_team',
    description: 'Сотрудники CRM: роли, активность.',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Список сотрудников CRM',
    execute: async () => {
      const s = await crm.snapshot();
      const m = mk();
      return s.team.map((t) => `• ${t.profile?.fullName || t.email} — ${t.role?.name ?? 'без роли'}${t.isActive && !t.terminatedAt ? '' : ' (не работает)'}; ${m.email(t.email)}`).join('\n') + missingNote(s);
    },
  });

  registry.register({
    ...common,
    name: 'crm_production',
    description: 'Производство: заказы в работе, просроченные сроки, ожидающие предоплаты, позиции склада на исходе.',
    inputSchema: { type: 'object', properties: { stockThreshold: { type: 'integer', description: 'Порог остатка (по умолчанию 3)' } } },
    describe: () => 'Производство и склад CRM',
    execute: async (i: { stockThreshold?: number }) => {
      const s = await crm.snapshot();
      const m = mk();
      const lead = (id: string): string | null | undefined => s.deals.find((d) => d.id === id)?.leadName;
      const open = s.production.filter((o) => !o.completedAt);
      const late = new Set(overdueProduction(s).map((o) => o.id));
      const lines = [`Заказов в работе: ${open.length}, просрочено: ${late.size}`];
      for (const o of open.slice(0, MAX_ROWS)) {
        lines.push(`• ${m.deal(o.deal?.title ?? o.dealId, lead(o.dealId))} — ${o.shopProductVariant?.product?.name ?? ''} ${o.shopProductVariant?.label ?? ''} ×${o.quantity}; ${o.kind}; стадия ${o.deal?.stage?.name ?? '?'}; план ${o.plannedReadyAt?.slice(0, 10) ?? 'не задан'}${late.has(o.id) ? ' ⚠ ПРОСРОЧЕНО' : ''}${o.requiresPrepayment && !o.paidAt ? ' ⚠ ждёт предоплаты' : ''}`);
      }
      const low = lowStock(s, Number.isInteger(i?.stockThreshold) ? i.stockThreshold : 3);
      lines.push('', `Склад на исходе (≤ ${Number.isInteger(i?.stockThreshold) ? i.stockThreshold : 3}): ${low.length}`);
      for (const it of low.slice(0, MAX_ROWS)) lines.push(`• ${it.productName} ${it.label}: ${it.stockQty}`);
      return lines.join('\n') + missingNote(s);
    },
  });

  registry.register<{ kind: string }>({
    ...common,
    name: 'crm_report',
    description:
      'Аналитический отчёт: kind = daily (утренняя сводка с главным), managers (нагрузка и дисциплина менеджеров), bottlenecks (узкие места воронок, причины отказов, конверсия), ' +
      'quality (ошибки в работе с CRM: незаполненные поля, нет следующего действия, не тот этап…), training (какие темы обучения нужны каждому сотруднику). ' +
      'После отчёта сформулируй выводы и конкретные предложения по улучшению; ничего не наказывай — ошибки это повод для обучения.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['daily', 'managers', 'bottlenecks', 'quality', 'training'] } }, required: ['kind'] },
    describe: (i) => `Подготовить отчёт CRM: ${i.kind}`,
    execute: async (i) => {
      const s = await crm.snapshot();
      const m = mk();
      if (i.kind === 'managers') {
        const rows = managerLoad(s);
        return rows.map((r) => `• ${r.name} (${r.role || '—'}): открытых сделок ${r.openDeals}, из них просрочено ${r.stuckDeals}; задач ${r.tasksOpen}, просрочено ${r.tasksOverdue}; закрыто в срок ${r.doneOnTime}, с опозданием ${r.doneLate}`).join('\n') + missingNote(s);
      }
      if (i.kind === 'bottlenecks') {
        const b = bottlenecks(s);
        return [
          'Узкие места (стадии по доле просроченных):',
          ...b.stages.slice(0, 10).map((x) => `• ${x.pipeline} / ${x.stage}: открыто ${x.open}, просрочено ${x.breaches}, средний простой ${h(x.avgAgeHours)}`),
          '', 'Причины отказов:', ...(b.lostReasons.slice(0, 8).map(([r, n]) => `• ${m.text(r)}: ${n}`) || ['—']),
          '', 'Конверсия (выиграно / закрыто):', ...b.conversion.map((c) => `• ${c.pipeline}: ${c.won} из ${c.won + c.lost}${c.rate !== null ? ` (${Math.round(c.rate * 100)}%)` : ''}`),
        ].join('\n') + missingNote(s);
      }
      if (i.kind === 'quality' || i.kind === 'training') {
        const issues = qualityIssues(s);
        if (i.kind === 'training') {
          const needs = trainingNeeds(issues);
          return (needs.length ? needs.map((n) => `• ${n.employee} — ошибок: ${n.total}\n${n.topics.map((t) => `    – ${t.topic} (${t.count})`).join('\n')}`).join('\n') : 'Ошибок не найдено — дополнительное обучение не требуется.') + missingNote(s);
        }
        const byKind = new Map<string, number>();
        for (const x of issues) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + 1);
        return [
          `Найдено замечаний: ${issues.length}`,
          ...[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `• ${ISSUE_TITLE[k as keyof typeof ISSUE_TITLE]}: ${n}`),
          '', 'Примеры:',
          ...issues.slice(0, 20).map((x) => `• ${ISSUE_TITLE[x.kind]} — ${m.deal(x.title, x.leadName)} [${x.pipeline}/${x.stage}] ${x.who.join(', ') || 'без ответственного'}: ${m.deal(x.detail, x.leadName)}`),
        ].join('\n') + missingNote(s);
      }
      // daily
      const o = overview(s);
      const issues = qualityIssues(s);
      const mg = managerLoad(s).filter((r) => r.stuckDeals || r.tasksOverdue).slice(0, 5);
      return [
        `Новых за 24 ч: ${o.newLast24h}; без ответственного: ${o.unassignedOpen}; просрочено по SLA: ${o.stuck}; просроченных задач: ${o.tasksOverdue}; производство просрочено: ${o.productionOverdue}; ждут предоплаты: ${o.awaitingPrepayment}; склад на исходе: ${o.lowStock}.`,
        mg.length ? 'Требуют внимания:\n' + mg.map((r) => `• ${r.name}: просрочено сделок ${r.stuckDeals}, задач ${r.tasksOverdue}`).join('\n') : 'Критичных просрочек у менеджеров нет.',
        `Замечаний по работе с CRM: ${issues.length}.`,
      ].join('\n') + missingNote(s);
    },
  });
}
