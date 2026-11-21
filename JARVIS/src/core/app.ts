import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AppInfo,
  AuditEntry,
  ChatEvent,
  ChatMessage,
  Conversation,
  MemoryItem,
  MemoryKind,
  ComputerAccess,
  Role,
  Settings,
} from '../shared/types';
import { ChatOrchestrator } from './chat/orchestrator';
import { openDatabase, type Db } from './db/database';
import { AttachmentRepo, ConversationRepo, MemoryRepo, SettingsRepo } from './db/repositories';
import { ComputerAccessRepo } from './computer/access';
import { registerAppTools } from './computer/apps';
import { BrowserController, registerBrowserTools, type BrowserOptions } from './computer/browser';
import { registerFileTools } from './computer/files';
import type { HostServices } from './computer/host';
import { registerScreenTool } from './computer/screen';
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
  confirmTimeoutMs?: number;
  /** Службы ОС (корзина, запуск программ, снимок экрана). Без них соответствующие инструменты не регистрируются. */
  host?: HostServices;
  /** Для тестов: настройки браузера ассистента (путь к Chromium, headless). */
  browser?: Partial<BrowserOptions>;
  home?: string;
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
  readonly computer: ComputerAccessRepo;
  readonly browser: BrowserController;
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
    this.computer = new ComputerAccessRepo(this.db, { dataDir: opts.dataDir, home: opts.home });
    this.tools = registerBuiltinTools(new ToolRegistry(), this.memory);
    const host = opts.host ?? {};
    this.browser = new BrowserController({
      userDataDir: join(opts.dataDir, 'browser-profile'),
      getAccess: () => this.computer.get(),
      ...opts.browser,
    });
    registerFileTools(this.tools, this.computer, host);
    registerAppTools(this.tools, this.computer, host);
    registerBrowserTools(this.tools, this.browser);
    registerScreenTool(this.tools, host);
    this.confirm = new ConfirmationBroker(opts.confirmUi, opts.confirmTimeoutMs);
    this.providers = new ProviderManager(opts.secrets, opts.env ?? process.env, opts.demoProvider);
    this.orchestrator = new ChatOrchestrator({
      conversations: this.conversations,
      attachments: this.attachments,
      computer: () => this.computer.get(),
      memory: this.memory,
      settings: this.settings,
      tools: this.tools,
      audit: this.audit,
      confirm: this.confirm,
      providers: this.providers,
      role: this.role,
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

  /** «Стоп»: прервать все запуски и отклонить ожидающие подтверждения. */
  stopAll(): void {
    if (this.runs.size > 0 || this.confirm.pendingCount > 0) {
      this.audit.record({ actor: 'user', action: 'agent.stop_requested', decision: 'info', details: { runs: this.runs.size } });
    }
    for (const c of this.runs.values()) c.abort();
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
    this.stopAll();
    await this.browser.close();
    this.db.close();
  }
}
