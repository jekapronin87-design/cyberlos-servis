import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AppInfo,
  AuditEntry,
  FreeProviderId,
  ProviderStatusDto,
  ChatEvent,
  ChatMessage,
  Conversation,
  MemoryItem,
  MemoryKind,
  ComputerAccess,
  ProfileSection,
  Role,
  Settings,
  UpdateProgress,
  UpdateStatus,
} from '../shared/types';
import { FREE_PROVIDER_PRESETS } from '../shared/types';
import { ProfileRepo, isSectionId, registerProfileTools } from './profile';
import { MentorService, registerMentorTools } from './mentor/service';
import { JobRepo, type Job, type JobInput } from './scheduler/jobs';
import { Scheduler, type JobResultEvent } from './scheduler/runner';
import { DeviceRepo, PairingCodes, type Device } from './gateway/devices';
import { Gateway } from './gateway/server';
import { registerImageTool } from './media/images';
import { TelegramService, type TelegramEvent } from './telegram/service';
import { AgentService, AGENT_TEMPLATES, type AgentEvent } from './agents/service';
import { YoutubeService, SECRET_YOUTUBE_KEY } from './youtube/service';
import { TelephonyService } from './telephony/service';
import { ProviderHttpError } from './providers/types';
import { describeProviderHttp } from './providers/openai';
import { AquaService, type AquaStatus } from './aqua/service';
import { CrmService, registerCrmTools, type CrmStatus, type CrmTestResult } from './crm/service';
import { DEFAULT_SOURCE, downloadZip, extractUpdate, fetchLatest, installAndBuild, makeBackupDir, readInstalled, writeInstalled } from './update/updater';
import { ChatOrchestrator } from './chat/orchestrator';
import { ToolExecutor } from './chat/executor';
import { openDatabase, type Db } from './db/database';
import { AttachmentRepo, ConversationRepo, MemoryRepo, SettingsRepo } from './db/repositories';
import { ComputerAccessRepo } from './computer/access';
import { AppCatalog, registerAppTools } from './computer/apps';
import { resolveApp } from './computer/startmenu';
import { BrowserController, registerBrowserTools, type BrowserOptions } from './computer/browser';
import { registerFileTools } from './computer/files';
import type { HostServices } from './computer/host';
import { registerCameraTool, registerScreenTool } from './computer/screen';
import { AgentRunner, ROLES, type AgentId } from './dev/agents';
import { registerGitTools } from './dev/git';
import { registerProjectTools } from './dev/projects';
import { registerRunTools } from './dev/run';
import { resolveAllowed } from './computer/pathguard';
import { ProviderManager } from './providers/manager';
import type { ChatProvider } from './providers/types';
import { AuditLog } from './security/audit';
import { ConfirmationBroker, type ConfirmationUi } from './security/confirmation';
import { SECRET_ANTHROPIC_KEY, validateApiKey, type SecretStore } from './security/secrets';
import { SECRET_VOICE_KEY, VoiceService } from './voice/service';
import { registerBuiltinTools } from './tools/builtin';
import { ToolRegistry } from './tools/registry';

export interface CoreOptions {
  dbPath: string;
  dataDir: string;
  version: string;
  platform: string;
  secrets: SecretStore;
  confirmUi: ConfirmationUi;
  role?: Role;
  env?: Record<string, string | undefined>;
  demoProvider?: ChatProvider;
  /** Для тестов: «облачный» провайдер-заглушка (требует заданного ключа). */
  liveProvider?: ChatProvider;
  confirmTimeoutMs?: number;
  /** Службы ОС (корзина, запуск программ, снимок экрана). Без них соответствующие инструменты не регистрируются. */
  host?: HostServices;
  /** Для тестов: настройки браузера ассистента (путь к Chromium, headless). */
  browser?: Partial<BrowserOptions>;
  home?: string;
  /** Каталог приложения (папка с package.json), если самообновление разрешено. */
  installDir?: string;
  /** Результат задачи по расписанию (в Electron — системное уведомление и сообщение окну). */
  onJobResult?: (e: JobResultEvent) => void;
  /** Подмена часов планировщика (тесты). */
  schedulerNow?: () => Date;
  schedulerTimeoutMs?: number;
  /** Результат запуска агента по расписанию (в Electron — системное уведомление и сообщение окну). */
  onAgent?: (e: AgentEvent) => void;
  /** Для тестов: подмена сети YouTube. */
  youtubeFetch?: typeof fetch;
  /** Событие Telegram (входящее, передача человеку, ошибка) — для уведомлений. */
  onTelegram?: (e: TelegramEvent) => void;
  /** Для тестов: подмена сети Telegram. */
  telegramFetch?: typeof fetch;
  /** false — без фонового опроса Telegram (тесты). */
  telegramPolling?: boolean;
  /** Подмена часов и ожидания ответа в телефонии (тесты). */
  telephonyNow?: () => Date;
  telephonyHearTimeoutMs?: number;
  /** Порт шлюза для телефона (по умолчанию 8787; 0 — любой свободный, для тестов). */
  gatewayPort?: number;
  /** Подмена сети и времени для CRM (тесты). */
  crmFetch?: typeof fetch;
  crmNow?: () => Date;
  /** Подмена сети для обновлений (тесты). */
  updateFetch?: typeof fetch;
  /** Для тестов: пропустить npm install/build. */
  skipBuild?: boolean;
  /** Для тестов: подмена сети бесплатных моделей. */
  modelFetch?: typeof fetch;
  /** Для тестов: подмена сетевого клиента голосовых API. */
  fetchImpl?: typeof fetch;
}

/**
 * Ядро JARVIS без зависимостей от Electron: всё приложение, кроме окна и IPC.
 * Так его можно тестировать целиком и позже использовать из других оболочек
 * (серверный режим, мобильный шлюз).
 */
export class JarvisCore {
  readonly db: Db;
  readonly settings: SettingsRepo;
  readonly conversations: ConversationRepo;
  readonly memory: MemoryRepo;
  readonly audit: AuditLog;
  readonly tools: ToolRegistry;
  readonly confirm: ConfirmationBroker;
  readonly providers: ProviderManager;
  readonly voice: VoiceService;
  readonly attachments: AttachmentRepo;
  readonly profile: ProfileRepo;
  readonly crm: CrmService;
  readonly aqua: AquaService;
  readonly mentor: MentorService;
  readonly jobs: JobRepo;
  readonly scheduler: Scheduler;
  readonly telephony: TelephonyService;
  readonly telegram: TelegramService;
  readonly agents: AgentService;
  readonly youtube: YoutubeService;
  readonly devices: DeviceRepo;
  readonly pairing: PairingCodes;
  readonly gateway: Gateway;
  readonly computer: ComputerAccessRepo;
  readonly apps: AppCatalog;
  readonly browser: BrowserController;
  readonly executor: ToolExecutor;
  private orchestrator: ChatOrchestrator;
  private runs = new Map<string, AbortController>();
  private role: Role;

  constructor(private opts: CoreOptions) {
    this.role = opts.role ?? 'owner';
    this.db = openDatabase(opts.dbPath);
    this.settings = new SettingsRepo(this.db);
    this.conversations = new ConversationRepo(this.db);
    this.memory = new MemoryRepo(this.db);
    this.audit = new AuditLog(this.db);
    this.voice = new VoiceService({
      getSettings: () => this.settings.get(),
      secrets: opts.secrets,
      audit: this.audit,
      fetchImpl: opts.fetchImpl,
    });
    this.attachments = new AttachmentRepo(this.db);
    this.profile = new ProfileRepo(this.db);
    this.crm = new CrmService(this.db, opts.secrets, this.audit, opts.crmFetch, opts.crmNow);
    this.aqua = new AquaService(this.db, opts.secrets, this.audit, opts.crmFetch);
    this.computer = new ComputerAccessRepo(this.db, { dataDir: opts.dataDir, home: opts.home });
    this.tools = registerBuiltinTools(new ToolRegistry(), this.memory);
    const host = opts.host ?? {};
    this.browser = new BrowserController({
      userDataDir: join(opts.dataDir, 'browser-profile'),
      getAccess: () => this.computer.get(),
      getAutoApprove: () => this.settings.get().browserAutoApprove,
      ...opts.browser,
    });
    registerFileTools(this.tools, this.computer, host);
    this.apps = new AppCatalog(this.computer, host);
    registerAppTools(this.tools, this.apps, host);
    registerBrowserTools(this.tools, this.browser);
    registerScreenTool(this.tools, host);
    registerCameraTool(this.tools, host, () => this.settings.get());
    this.attachments.purgeKind('camera'); // кадры камеры живут только до перезапуска
    registerImageTool(this.tools, { getSettings: () => this.settings.get(), secrets: opts.secrets, audit: this.audit, dir: join(opts.dataDir, 'images'), fetchImpl: opts.fetchImpl });
    registerProfileTools(this.tools, this.profile);
    registerCrmTools(this.tools, this.crm);
    this.aqua.registerTools(this.tools);
    this.mentor = new MentorService(this.db, this.crm, this.audit, this.browser);
    registerMentorTools(this.tools, this.mentor);
    this.telephony = new TelephonyService(this.db, this.settings, this.audit, this.mentor, opts.telephonyNow, opts.telephonyHearTimeoutMs);
    this.telephony.registerTools(this.tools);
    registerProjectTools(this.tools, this.computer);
    registerRunTools(this.tools, this.computer);
    registerGitTools(this.tools, this.computer);
    this.confirm = new ConfirmationBroker(opts.confirmUi, opts.confirmTimeoutMs);
    this.providers = new ProviderManager(opts.secrets, opts.env ?? process.env, opts.demoProvider, opts.liveProvider, opts.modelFetch);
    this.executor = new ToolExecutor({
      tools: this.tools,
      settings: this.settings,
      audit: this.audit,
      confirm: this.confirm,
      attachments: this.attachments,
      role: this.role,
    });
    const runner = new AgentRunner({
      providers: this.providers,
      getSettings: () => this.settings.get(),
      tools: this.tools,
      executor: this.executor,
      audit: this.audit,
    });
    this.tools.register<{ agent: AgentId; task: string; project?: string }>({
      name: 'delegate_task',
      description:
        'Поручает задачу специализированному субагенту: developer (пишет/правит код и проверяет), tester (запускает проверки, пишет тесты, ищет ошибки), ' +
        'reviewer (ревью кода только на чтение). Для программных задач: сначала developer, затем tester и reviewer. Субагент работает с теми же ограничениями и подтверждениями. ' +
        'Опиши задачу подробно и самостоятельно — субагент не видит этот диалог.',
      risk: 'low',
      mutates: false,
      domain: 'local',
      external: true,
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: Object.keys(ROLES) },
          task: { type: 'string', description: 'Полное описание задачи, критерии готовности' },
          project: { type: 'string', description: 'Путь к папке проекта (в разрешённой папке)' },
        },
        required: ['agent', 'task'],
      },
      describe: (i) => `Поручить задачу агенту «${ROLES[i.agent]?.title ?? i.agent}»`,
      execute: async (i, ctx) => {
        if (String(i.task).length > 4000) throw new Error('Описание задачи длиннее 4000 символов');
        let project = '';
        if (i.project) {
          try {
            project = resolveAllowed(i.project, this.computer.get().folders).abs;
          } catch (e) {
            throw new Error(e instanceof Error ? e.message : 'Недопустимый путь проекта');
          }
        }
        const r = await runner.run(i.agent, String(i.task), project, { runId: ctx.runId, conversationId: ctx.conversationId, signal: ctx.signal });
        return `Агент «${ROLES[i.agent].title}» завершил работу${r.stoppedByLimit ? ' (достигнут лимит шагов)' : ''}.\n\nОтчёт:\n${r.report}\n\nХод работы (${r.steps.length} действий):\n${r.steps.join('\n') || '—'}`;
      },
    });
    this.orchestrator = new ChatOrchestrator(
      {
      conversations: this.conversations,
      attachments: this.attachments,
      computer: () => this.computer.get(),
      profile: () => this.profile.forPrompt(),
      crm: () => (this.crm.client.configured() ? { environment: this.crm.status().environment, maskPii: this.crm.maskPii() } : null),
      aqua: () => (this.aqua.status().configured ? { maskPii: this.aqua.status().maskPii } : null),
      memory: this.memory,
      settings: this.settings,
      tools: this.tools,
      audit: this.audit,
      confirm: this.confirm,
      providers: this.providers,
      role: this.role,
      },
      this.executor,
    );
    this.jobs = new JobRepo(this.db);
    this.scheduler = new Scheduler({
      jobs: this.jobs,
      conversations: this.conversations,
      settings: this.settings,
      providers: this.providers,
      audit: this.audit,
      run: (convId, text, emit, signal, o) => this.orchestrator.run(convId, text, emit, signal, randomUUID(), o),
      notify: (e) => opts.onJobResult?.(e),
      now: opts.schedulerNow,
      timeoutMs: opts.schedulerTimeoutMs,
    });
    this.youtube = new YoutubeService({ db: this.db, secrets: opts.secrets, audit: this.audit, getSettings: () => this.settings.get(), fetchImpl: opts.youtubeFetch, now: opts.schedulerNow });
    this.youtube.registerTools(this.tools);
    this.agents = new AgentService({
      db: this.db,
      runner,
      tools: this.tools,
      audit: this.audit,
      getSettings: () => this.settings.get(),
      notify: opts.onAgent,
      now: opts.schedulerNow,
      notReady: () => (this.providers.resolve(this.settings.get()).mode === 'demo' ? 'Агентам нужна настоящая модель: подключите ключ Claude или бесплатную модель в «Настройках».' : null),
    });
    this.agents.registerTools(this.tools);
    this.telegram = new TelegramService({
      db: this.db,
      secrets: opts.secrets,
      audit: this.audit,
      getSettings: () => this.settings.get(),
      providers: this.providers,
      runOwner: (convId, text, emit) => {
        const r = this.startRemoteChat({ id: -1, name: 'Telegram', conversationId: convId }, convId, text, emit);
        return { done: r.done, abort: r.abort };
      },
      createConversation: (title) => this.conversations.create(title).id,
      conversationExists: (id) => this.conversations.get(id) !== null,
      notify: opts.onTelegram,
      fetchImpl: opts.telegramFetch,
      polling: opts.telegramPolling,
    });
    this.telegram.registerTools(this.tools);
    this.devices = new DeviceRepo(this.db);
    this.pairing = new PairingCodes();
    this.gateway = new Gateway({
      devices: this.devices,
      codes: this.pairing,
      audit: this.audit,
      getSettings: () => this.settings.get(),
      mode: () => this.providers.resolve(this.settings.get()).mode,
      conversations: this.conversations,
      startRemoteChat: (device, convId, text, emit) => this.startRemoteChat(device, convId, text, emit),
      waitingForPc: () => this.confirm.pendingCount > 0,
      port: opts.gatewayPort,
    });
    this.tools.register<{ title: string; prompt: string; kind: string; time?: string; intervalMin?: number }>({
      name: 'schedule_create',
      description:
        'Создаёт задачу по расписанию (после подтверждения пользователя): ассистент будет сам выполнять её в фоне и присылать итог. kind: daily (каждый день в time, ЧЧ:ММ), weekdays (по будням), interval (каждые intervalMin минут, от 5). ' +
        'prompt — полный текст поручения (в фоне доступно только чтение и анализ). Пример: «Каждое утро в 9:00 присылай сводку по CRM».',
      risk: 'medium',
      mutates: true,
      domain: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          prompt: { type: 'string' },
          kind: { type: 'string', enum: ['daily', 'weekdays', 'interval'] },
          time: { type: 'string', description: 'ЧЧ:ММ для daily/weekdays' },
          intervalMin: { type: 'integer' },
        },
        required: ['title', 'prompt', 'kind'],
      },
      describe: (i) => `Создать задачу по расписанию «${i.title}»: ${i.kind === 'interval' ? `каждые ${i.intervalMin} мин` : `${i.kind === 'weekdays' ? 'по будням' : 'каждый день'} в ${i.time}`}\nПоручение: ${String(i.prompt).slice(0, 400)}`,
      execute: (i) => {
        const j = this.jobs.create({ title: i.title, prompt: i.prompt, kind: i.kind as JobInput['kind'], atTime: i.time, intervalMin: i.intervalMin, notify: true }, this.opts.schedulerNow?.());
        return `Задача создана (№${j.id}). Ближайший запуск: ${j.nextRunAt}.`;
      },
    });
    this.tools.register({
      name: 'schedule_list',
      description: 'Показывает задачи по расписанию.',
      risk: 'safe',
      mutates: false,
      domain: 'local',
      inputSchema: { type: 'object', properties: {} },
      describe: () => 'Показать задачи по расписанию',
      execute: () =>
        this.jobs.list().map((j) => `#${j.id} ${j.title} — ${j.enabled ? 'включена' : 'выключена'}; ближайший запуск ${j.nextRunAt ?? '—'}; последний результат: ${j.lastStatus ?? '—'}`).join('\n') || 'Задач по расписанию нет.',
    });
    this.tools.register<{ id: number }>({
      name: 'schedule_delete',
      description: 'Удаляет задачу по расписанию по номеру (после подтверждения).',
      risk: 'medium',
      mutates: true,
      domain: 'local',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      describe: (i) => `Удалить задачу по расписанию №${i.id}`,
      execute: (i) => {
        this.jobs.remove(Number(i.id));
        return `Задача №${i.id} удалена.`;
      },
    });
    this.audit.record({ actor: 'system', action: 'app.start', decision: 'info', details: { version: opts.version } });
  }

  info(): AppInfo {
    const s = this.settings.get();
    const r = this.providers.resolve(s);
    return {
      version: this.opts.version,
      platform: this.opts.platform,
      mode: r.mode,
      providerName: r.provider.name,
      model: r.mode === 'live' ? s.model : 'demo',
      dataDir: this.opts.dataDir,
      hasApiKey: this.providers.apiKey() !== null,
      hasVoiceKey: this.voice.hasKey(),
      secretsEncrypted: this.opts.secrets.encrypted,
      role: this.role,
    };
  }

  // ----- настройки и секреты -----
  getSettings(): Settings {
    return this.settings.get();
  }

  updateSettings(patch: unknown): Settings {
    const before = this.settings.get();
    const next = this.settings.update(patch);
    if (next.micEnabled !== before.micEnabled) {
      this.audit.record({ actor: 'user', action: next.micEnabled ? 'voice.mic_enabled' : 'voice.mic_disabled', decision: 'info' });
    }
    this.audit.record({
      actor: 'user',
      action: 'settings.update',
      decision: 'info',
      details: { keys: Object.keys(patch as object) },
    });
    if (next.gatewayMode !== before.gatewayMode || next.disabledModules.join() !== before.disabledModules.join()) void this.applyGateway();
    if (next.gatewayAllowActions !== before.gatewayAllowActions) {
      this.audit.record({ actor: 'user', action: next.gatewayAllowActions ? 'gateway.actions_enabled' : 'gateway.actions_disabled', risk: 'high', decision: 'info' });
    }
    if (next.telegramAutoReply !== before.telegramAutoReply) {
      this.audit.record({ actor: 'user', action: next.telegramAutoReply ? 'telegram.autoreply_enabled' : 'telegram.autoreply_disabled', risk: 'high', decision: 'info' });
    }
    if (next.disabledModules.includes('telegram')) this.telegram.stop();
    else if (before.disabledModules.includes('telegram')) this.telegram.start();
    if ((patch as Partial<Settings>).allowProductionWrites === true) {
      this.audit.record({ actor: 'user', action: 'security.production_writes_enabled', risk: 'high', decision: 'info' });
    }
    return next;
  }

  setApiKey(key: string): void {
    this.opts.secrets.set(SECRET_ANTHROPIC_KEY, validateApiKey(key));
    this.audit.record({ actor: 'user', action: 'secrets.api_key_set', decision: 'info' });
  }

  clearApiKey(): void {
    this.opts.secrets.delete(SECRET_ANTHROPIC_KEY);
    this.audit.record({ actor: 'user', action: 'secrets.api_key_cleared', decision: 'info' });
  }

  setVoiceKey(key: string): void {
    this.opts.secrets.set(SECRET_VOICE_KEY, validateApiKey(key));
    this.audit.record({ actor: 'user', action: 'secrets.voice_key_set', decision: 'info' });
  }

  // ----- бесплатные модели -----
  providerStatuses(): ProviderStatusDto[] {
    const st = this.settings.get();
    return FREE_PROVIDER_PRESETS.map((p) => {
      const c = st.freeProviders.find((x) => x.id === p.id) ?? { id: p.id, enabled: false, model: p.model, baseUrl: p.baseUrl };
      return { id: p.id, name: p.name, enabled: c.enabled, hasKey: this.providers.providerKey(p.id) !== null, needsKey: p.needsKey, local: p.local, model: c.model, baseUrl: c.baseUrl, help: p.help };
    });
  }
  setProviderKey(id: FreeProviderId, key: string): void {
    if (!FREE_PROVIDER_PRESETS.some((p) => p.id === id)) throw new Error('Неизвестная модель');
    this.opts.secrets.set(`provider.${id}.key`, validateApiKey(key));
    this.audit.record({ actor: 'user', action: 'secrets.provider_key_set', target: id, decision: 'info' });
  }
  clearProviderKey(id: FreeProviderId): void {
    this.opts.secrets.delete(`provider.${id}.key`);
    this.audit.record({ actor: 'user', action: 'secrets.provider_key_cleared', target: id, decision: 'info' });
  }
  /** Проверка связи с моделью (кнопка «Проверить»): короткий запрос «готов». */
  async testProvider(id: FreeProviderId): Promise<string> {
    const st = this.settings.get();
    const c = st.freeProviders.find((x) => x.id === id);
    const preset = FREE_PROVIDER_PRESETS.find((p) => p.id === id);
    if (!c || !preset) throw new Error('Неизвестная модель');
    if (preset.needsKey && !this.providers.providerKey(id)) throw new Error('Сначала сохраните ключ');
    const p = this.providers.freeProviders({ freeProviders: [{ ...c, enabled: true }] })[0];
    if (!p) throw new Error('Укажите название модели');
    try {
      return await p.ping();
    } catch (e) {
      throw new Error(e instanceof ProviderHttpError ? describeProviderHttp(e) : e instanceof Error ? e.message : 'Ошибка');
    }
  }

  clearVoiceKey(): void {
    this.opts.secrets.delete(SECRET_VOICE_KEY);
    this.audit.record({ actor: 'user', action: 'secrets.voice_key_cleared', decision: 'info' });
  }

  // ----- диалоги -----
  listConversations(): Conversation[] {
    return this.conversations.list();
  }
  createConversation(title?: string): Conversation {
    return this.conversations.create(title);
  }
  renameConversation(id: number, title: string): void {
    this.conversations.rename(id, title);
  }
  deleteConversation(id: number): void {
    this.conversations.remove(id);
    this.attachments.purgeOrphans();
    this.audit.record({ actor: 'user', action: 'conversation.delete', decision: 'info', details: { id } });
  }
  messages(id: number): ChatMessage[] {
    return this.conversations.messages(id);
  }

  // ----- чат -----
  /** Запускает обработку в фоне; события приходят через emit. Возвращает runId сразу. */
  startChat(conversationId: number, text: string, emit: (e: ChatEvent) => void): { runId: string; done: Promise<void> } {
    const ctrl = new AbortController();
    const handle = randomUUID();
    this.runs.set(handle, ctrl);
    const done = this.orchestrator
      .run(conversationId, text, emit, ctrl.signal, handle)
      .finally(() => this.runs.delete(handle));
    return { runId: handle, done };
  }

  /** Запрос с телефона: тот же чат, но действует удалённая политика (высокий риск запрещён; подтверждения — только если разрешено в настройках). */
  startRemoteChat(device: Device, conversationId: number, text: string, emit: (e: ChatEvent) => void): { runId: string; abort(): void; done: Promise<void> } {
    const ctrl = new AbortController();
    const handle = randomUUID();
    this.runs.set(handle, ctrl);
    const done = this.orchestrator
      .run(conversationId, text, emit, ctrl.signal, handle, { remoteDevice: device.name })
      .finally(() => this.runs.delete(handle));
    return { runId: handle, abort: () => ctrl.abort(), done };
  }

  /** «Стоп»: прервать все запуски и отклонить ожидающие подтверждения. */
  stopAll(): void {
    if (this.runs.size > 0 || this.confirm.pendingCount > 0) {
      this.audit.record({ actor: 'user', action: 'agent.stop_requested', decision: 'info', details: { runs: this.runs.size } });
    }
    for (const c of this.runs.values()) c.abort();
    this.scheduler.abort();
    this.agents.stopAll();
    this.confirm.rejectAll();
  }

  get activeRuns(): number {
    return this.runs.size;
  }

  // ----- доступ к компьютеру (этап 3) -----
  getComputerAccess(): ComputerAccess {
    return this.computer.get();
  }
  /** Путь выбран пользователем в окне Windows (вызывает только главный процесс). */
  addAllowedFolder(path: string): ComputerAccess {
    this.computer.addFolder(path);
    this.audit.record({ actor: 'user', action: 'computer.folder_added', risk: 'high', decision: 'info', details: { path } });
    return this.computer.get();
  }
  removeAllowedFolder(path: string): ComputerAccess {
    this.computer.removeFolder(path);
    this.audit.record({ actor: 'user', action: 'computer.folder_removed', decision: 'info', details: { path } });
    return this.computer.get();
  }
  addAllowedApp(path: string): ComputerAccess {
    this.computer.addApp(path);
    this.audit.record({ actor: 'user', action: 'computer.app_added', risk: 'high', decision: 'info', details: { path } });
    return this.computer.get();
  }
  removeAllowedApp(name: string): ComputerAccess {
    this.computer.removeApp(name);
    this.audit.record({ actor: 'user', action: 'computer.app_removed', decision: 'info', details: { name } });
    return this.computer.get();
  }
  addBrowserHost(host: string): ComputerAccess {
    this.computer.addBrowserHost(host);
    this.audit.record({ actor: 'user', action: 'computer.browser_host_added', risk: 'medium', decision: 'info', details: { host } });
    return this.computer.get();
  }
  removeBrowserHost(host: string): ComputerAccess {
    this.computer.removeBrowserHost(host);
    this.audit.record({ actor: 'user', action: 'computer.browser_host_removed', decision: 'info', details: { host } });
    return this.computer.get();
  }
  getAttachment(id: number): { mime: string; base64: string } | null {
    return this.attachments.get(id);
  }

  // ----- база знаний и наставник -----
  saveKbDoc(doc: { id?: number; title: string; category: string; body: string; source?: string }) {
    const d = this.mentor.kb.save(doc);
    this.audit.record({ actor: 'user', action: 'kb.save', target: String(d.id), decision: 'info', details: { title: d.title, version: d.version } });
    return d;
  }
  approveKbDoc(id: number, approved: boolean) {
    const d = this.mentor.kb.setApproved(id, approved);
    this.audit.record({ actor: 'user', action: approved ? 'kb.approve' : 'kb.unapprove', target: String(id), risk: 'medium', decision: 'info', details: { title: d.title, version: d.version } });
    return d;
  }
  removeKbDoc(id: number): void {
    this.mentor.kb.remove(id);
    this.audit.record({ actor: 'user', action: 'kb.delete', target: String(id), decision: 'info' });
  }

  // ----- доступ с телефона -----
  gatewayStatus() {
    return this.gateway.status();
  }
  /** Запустить/остановить шлюз по настройке (вызывается при старте и при смене режима). */
  applyGateway() {
    const s = this.settings.get();
    const off = s.gatewayMode === 'off' || s.disabledModules.includes('gateway');
    return this.gateway.apply(off ? 'off' : s.gatewayMode);
  }
  /** Код подключения телефона — показывается только в окне на компьютере. */
  gatewayPairingCode(): { code: string; expiresAt: string } {
    if (this.gateway.status().mode === 'off') throw new Error('Сначала включите доступ с телефона');
    this.audit.record({ actor: 'user', action: 'gateway.pair_code_issued', decision: 'info' });
    return this.pairing.issue();
  }
  listDevices() {
    return this.devices.list();
  }
  revokeDevice(id: number): void {
    this.devices.revoke(id);
    this.audit.record({ actor: 'user', action: 'gateway.device_revoked', target: String(id), decision: 'info' });
  }

  // ----- YouTube -----
  private youtubeOn(): YoutubeService {
    if (this.settings.get().disabledModules.includes('youtube')) throw new Error('Модуль «YouTube» отключён в настройках.');
    return this.youtube;
  }
  youtubeStatus() {
    return this.youtubeOn().status();
  }
  setYoutubeKey(key: string) {
    this.opts.secrets.set(SECRET_YOUTUBE_KEY, validateApiKey(key));
    this.audit.record({ actor: 'user', action: 'secrets.youtube_key_set', decision: 'info' });
    return this.youtubeOn().status();
  }
  clearYoutubeKey() {
    this.opts.secrets.delete(SECRET_YOUTUBE_KEY);
    this.audit.record({ actor: 'user', action: 'secrets.youtube_key_cleared', decision: 'info' });
    return this.youtubeOn().status();
  }
  testYoutube() {
    return this.youtubeOn().test();
  }

  // ----- агенты -----
  private agentsOn(): AgentService {
    if (this.settings.get().disabledModules.includes('agents')) throw new Error('Модуль «Агенты» отключён в настройках.');
    return this.agents;
  }
  startAgents(): void {
    this.agents.start();
  }
  listAgents() {
    return this.agentsOn().list();
  }
  agentTemplates() {
    return AGENT_TEMPLATES;
  }
  saveAgent(input: Parameters<AgentService['save']>[0]) {
    return this.agentsOn().save(input);
  }
  deleteAgent(id: number) {
    this.agentsOn().remove(id);
  }
  /** Запуск кнопкой: идёт в фоне, окно опрашивает состояние; подтверждения опасных действий — на экране. */
  startAgent(id: number, task: string) {
    const svc = this.agentsOn();
    svc.canRun(id);
    void svc.run(id, task, 'manual').catch(() => undefined);
  }
  stopAgent(id: number) {
    this.agentsOn().stop(id);
  }
  agentRuns(id: number) {
    return this.agentsOn().runs(id);
  }
  clearAgentNotes(id: number) {
    this.agentsOn().clearNotes(id);
  }

  // ----- Telegram -----
  private telegramOn(): TelegramService {
    if (this.settings.get().disabledModules.includes('telegram')) throw new Error('Модуль «Telegram» отключён в настройках.');
    return this.telegram;
  }
  startTelegram(): void {
    this.telegram.start();
  }
  telegramStatus() {
    return this.telegramOn().status();
  }
  async telegramConnect(token: string) {
    const st = await this.telegramOn().connect(token);
    this.settings.update({ telegramEnabled: true });
    this.telegram.start();
    return { ...st, running: true };
  }
  telegramDisconnect() {
    this.telegramOn().disconnect();
    this.settings.update({ telegramEnabled: false, telegramAutoReply: false });
    return this.telegram.status();
  }
  telegramPairCode() {
    return this.telegramOn().pairingCode();
  }
  telegramUnlink() {
    this.telegramOn().unlinkOwner();
  }
  telegramChats() {
    return this.telegramOn().listChats();
  }
  telegramMessages(chatId: number) {
    return this.telegramOn().messages(chatId);
  }
  telegramSend(chatId: number, text: string) {
    return this.telegramOn().send(chatId, text, { limited: false });
  }
  telegramSetAutoReply(chatId: number, on: boolean) {
    this.telegramOn().setAutoReply(chatId, on);
  }
  telegramResolveHuman(chatId: number) {
    this.telegramOn().resolveHuman(chatId);
  }

  // ----- телефония (каркас) -----
  private telephonyOn(): TelephonyService {
    if (this.settings.get().disabledModules.includes('telephony')) throw new Error('Модуль «Телефония» отключён в настройках.');
    return this.telephony;
  }
  telephonyStatus() {
    return this.telephonyOn().status();
  }
  listConsents() {
    return this.telephonyOn().listConsents();
  }
  grantConsent(i: Parameters<TelephonyService['grantConsent']>[0]) {
    return this.telephonyOn().grantConsent(i);
  }
  revokeConsent(phone: string) {
    this.telephonyOn().revokeConsent(phone);
  }
  canCall(phone: string) {
    return this.telephonyOn().canCall(phone);
  }
  startCall(i: { phone: string; courseId: string; lessonId: string }) {
    return this.telephonyOn().startCall(i);
  }
  callState(id: number) {
    return this.telephonyOn().state(id);
  }
  callReply(id: number, text: string) {
    this.telephonyOn().reply(id, text);
  }
  callHangup(id: number) {
    this.telephonyOn().hangup(id);
  }
  listCalls() {
    return this.telephonyOn().listCalls();
  }
  callTranscript(id: number) {
    return this.telephonyOn().transcript(id);
  }
  deleteCallTranscript(id: number) {
    this.telephonyOn().deleteTranscript(id);
  }

  // ----- запуск программ -----
  /** Пользователь разрешил/запретил запуск программ из меню Пуск (вызывается из окна настроек). */
  setStartMenuAccess(on: boolean): ComputerAccess {
    this.computer.setStartMenu(on);
    this.apps.invalidate();
    this.audit.record({ actor: 'user', action: on ? 'computer.startmenu_enabled' : 'computer.startmenu_disabled', risk: 'high', decision: 'info' });
    return this.computer.get();
  }
  async startMenuApps(): Promise<string[]> {
    return (await this.apps.list()).filter((a) => a.source === 'startmenu').map((a) => a.name);
  }
  /**
   * Голосовая/текстовая команда «открой …»: ищет программу по названию и запускает через общий исполнитель (политика, журнал).
   * matched=false — подходящей программы нет или их несколько: тогда решает модель.
   */
  async launchAppByName(query: string): Promise<{ matched: boolean; ok: boolean; message: string }> {
    if (this.settings.get().disabledModules.includes('computer')) return { matched: false, ok: false, message: '' };
    const all = await this.apps.list();
    const app = resolveApp(query, all);
    if (!app) return { matched: false, ok: false, message: '' };
    const r = await this.executor.execute(
      { type: 'tool_use', id: 'voice-launch', name: 'app_open', input: { name: app.name } },
      { runId: randomUUID(), conversationId: 0, signal: new AbortController().signal, actor: 'user' },
    );
    return { matched: true, ok: !r.isError && !r.denied, message: r.isError || r.denied ? r.content : `Запускаю ${app.name}.` };
  }

  // ----- расписание -----
  startScheduler(): void {
    this.scheduler.start();
  }
  listJobs(): Job[] {
    return this.jobs.list();
  }
  createJob(input: JobInput): Job {
    const j = this.jobs.create(input, this.opts.schedulerNow?.());
    this.audit.record({ actor: 'user', action: 'job.create', target: String(j.id), decision: 'info', details: { title: j.title, kind: j.kind } });
    return j;
  }
  setJobEnabled(id: number, enabled: boolean): Job {
    return this.jobs.setEnabled(id, enabled, this.opts.schedulerNow?.());
  }
  deleteJob(id: number): void {
    this.jobs.remove(id);
    this.audit.record({ actor: 'user', action: 'job.delete', target: String(id), decision: 'info' });
  }
  runJobNow(id: number): Promise<JobResultEvent> {
    return this.scheduler.runNow(id);
  }
  jobRuns(id: number) {
    return this.jobs.runs(id);
  }

  // ----- CRM «Аквамастер» (только чтение, по API-ключу) -----
  aquaStatus(): AquaStatus {
    return this.aqua.status();
  }
  aquaSave(cfg: { baseUrl?: string; maskPii?: boolean }, key?: string): AquaStatus {
    return this.aqua.save(cfg, key);
  }
  aquaDisconnect(): AquaStatus {
    return this.aqua.disconnect();
  }
  aquaDashboard() {
    return this.aqua.dashboard();
  }
  aquaSection(kind: Parameters<AquaService['section']>[0], arg: { pipeline?: string; stage?: string }) {
    return this.aqua.section(kind, arg);
  }
  aquaTest(): Promise<string> {
    return this.aqua.test();
  }

  // ----- CRM «Сайберлос» (только чтение) -----
  crmStatus(): CrmStatus {
    return this.crm.status();
  }
  crmSave(cfg: { baseUrl: string; environment: 'test' | 'production'; email: string; maskPii: boolean; frontendUrl?: string }, password?: string): CrmStatus {
    this.crm.save(cfg, password);
    return this.crm.status();
  }
  crmDisconnect(): CrmStatus {
    this.crm.disconnect();
    return this.crm.status();
  }
  crmTest(): Promise<CrmTestResult> {
    return this.crm.test();
  }
  crmDashboard() {
    return this.crm.dashboard();
  }

  // ----- обновление приложения -----
  private updating = false;

  async checkUpdate(): Promise<UpdateStatus> {
    const branch = this.settings.get().updateBranch;
    const installed = readInstalled(this.opts.dataDir);
    if (!this.opts.installDir) {
      return { canUpdate: false, reason: 'Обновление по кнопке доступно, когда JARVIS запущен из папки (start-jarvis.bat), а не из установщика.', installedSha: installed?.sha ?? null, latest: null, upToDate: null, branch };
    }
    const latest = await fetchLatest({ ...DEFAULT_SOURCE, branch }, this.opts.updateFetch);
    return { canUpdate: true, installedSha: installed?.sha ?? null, latest, upToDate: installed ? installed.sha === latest.sha : null, branch };
  }

  /** Скачивает и применяет обновление. После успеха нужен перезапуск. Вызывается только по кнопке пользователя. */
  async applyUpdate(progress: (p: UpdateProgress) => void): Promise<{ sha: string; files: number }> {
    if (!this.opts.installDir) throw new Error('Самообновление недоступно в этой установке');
    if (this.updating) throw new Error('Обновление уже выполняется');
    this.updating = true;
    const ctrl = new AbortController();
    try {
      const branch = this.settings.get().updateBranch;
      const src = { ...DEFAULT_SOURCE, branch };
      progress({ step: 'check', message: 'Проверяю последнюю версию…' });
      const latest = await fetchLatest(src, this.opts.updateFetch);
      progress({ step: 'download', message: 'Скачиваю обновление…' });
      const zip = await downloadZip(src, latest.sha, this.opts.updateFetch);
      progress({ step: 'extract', message: 'Устанавливаю файлы…' });
      const before = readInstalled(this.opts.dataDir);
      const backup = makeBackupDir(this.opts.dataDir, before?.sha ?? null);
      const r = extractUpdate(zip, this.opts.installDir, src, backup);
      if (!this.opts.skipBuild) {
        progress({ step: 'install', message: r.packageJsonChanged ? 'Устанавливаю новые компоненты и собираю приложение (несколько минут)…' : 'Собираю приложение…' });
        await installAndBuild(this.opts.installDir, r.packageJsonChanged, ctrl.signal);
      }
      writeInstalled(this.opts.dataDir, latest.sha);
      this.audit.record({ actor: 'user', action: 'update.applied', risk: 'high', decision: 'info', details: { from: before?.sha ?? null, to: latest.sha, files: r.written.length, branch } });
      progress({ step: 'done', message: `Готово: обновлено файлов — ${r.written.length}. Перезапустите JARVIS.` });
      return { sha: latest.sha, files: r.written.length };
    } catch (e) {
      progress({ step: 'error', message: e instanceof Error ? e.message : 'Ошибка обновления' });
      this.audit.record({ actor: 'system', action: 'update.failed', decision: 'error' });
      throw e;
    } finally {
      this.updating = false;
    }
  }

  // ----- досье -----
  getProfile(): ProfileSection[] {
    return this.profile.list();
  }
  setProfileSection(section: string, text: string): ProfileSection[] {
    if (!isSectionId(section)) throw new Error('Неизвестный раздел досье');
    this.profile.set(section, text);
    this.audit.record({ actor: 'user', action: 'profile.update', decision: 'info', details: { section, chars: text.length } });
    return this.profile.list();
  }
  clearProfile(): ProfileSection[] {
    this.profile.clear();
    this.audit.record({ actor: 'user', action: 'profile.clear', risk: 'medium', decision: 'info' });
    return this.profile.list();
  }

  // ----- память -----
  listMemory(): MemoryItem[] {
    return this.memory.list();
  }
  addMemory(kind: MemoryKind, content: string): MemoryItem {
    const item = this.memory.add(kind, content, 'user');
    this.audit.record({ actor: 'user', action: 'memory.add', decision: 'info', details: { id: item.id, kind } });
    return item;
  }
  removeMemory(id: number): void {
    this.memory.remove(id);
    this.audit.record({ actor: 'user', action: 'memory.delete', decision: 'info', details: { id } });
  }

  // ----- журнал -----
  listAudit(limit?: number): AuditEntry[] {
    return this.audit.list(limit);
  }
  verifyAudit(): { ok: boolean; checked: number; brokenAtId?: number } {
    return this.audit.verify();
  }

  async close(): Promise<void> {
    this.scheduler.stop();
    this.stopAll();
    this.telephony.stopAll();
    this.agents.close();
    await this.telegram.close();
    await this.gateway.stop();
    await this.browser.close();
    this.db.close();
  }
}
