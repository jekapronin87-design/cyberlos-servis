import type {
  AppInfo,
  ComputerAccess,
  ProfileSection,
  UpdateProgress,
  UpdateStatus,
  CrmStatusDto,
  JobDto,
  KbDocDto,
  LessonDto,
  LessonProgressDto,
  CourseDto,
  EmployeeRowDto,
  JobInputDto,
  JobResultDto,
  CrmTestDto,
  GatewayStatusDto,
  GatewayDeviceDto,
  FreeProviderId,
  TelegramStatusDto,
  AgentDto,
  AgentInputDto,
  AgentRunDto,
  AgentTemplateDto,
  TelegramChatDto,
  TelegramMessageDto,
  ProviderStatusDto,
  ConsentDto,
  CallDto,
  CallStateDto,
  CrmDashboardDto,
  AuditEntry,
  ChatEvent,
  ChatMessage,
  ConfirmRequest,
  Conversation,
  MemoryItem,
  MemoryKind,
  Settings,
} from './types';

/** Имена IPC-каналов. Единственный источник правды для main и preload. */
export const IPC = {
  appInfo: 'app:info',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  apiKeySet: 'secrets:api-key:set',
  apiKeyClear: 'secrets:api-key:clear',
  voiceKeySet: 'voice:key:set',
  voiceKeyClear: 'voice:key:clear',
  voiceTranscribe: 'voice:transcribe',
  voiceSpeak: 'voice:speak',
  computerGet: 'computer:get',
  computerAddFolder: 'computer:folder:add',
  computerRemoveFolder: 'computer:folder:remove',
  computerAddApp: 'computer:app:add',
  computerRemoveApp: 'computer:app:remove',
  computerAddHost: 'computer:host:add',
  computerRemoveHost: 'computer:host:remove',
  attachmentGet: 'attachment:get',
  kbList: 'kb:list',
  kbSave: 'kb:save',
  kbApprove: 'kb:approve',
  kbRemove: 'kb:remove',
  kbImport: 'kb:import',
  mentorCourses: 'mentor:courses',
  mentorLesson: 'mentor:lesson',
  mentorAnswer: 'mentor:answer',
  mentorVerify: 'mentor:verify',
  mentorShow: 'mentor:show',
  mentorAssign: 'mentor:assign',
  mentorUnassign: 'mentor:unassign',
  mentorAssignments: 'mentor:assignments',
  mentorCabinet: 'mentor:cabinet',
  jobsList: 'jobs:list',
  jobsCreate: 'jobs:create',
  jobsToggle: 'jobs:toggle',
  jobsDelete: 'jobs:delete',
  jobsRunNow: 'jobs:run-now',
  jobsRuns: 'jobs:runs',
  evtJob: 'evt:job',
  appsStartMenu: 'apps:startmenu',
  appsSetStartMenu: 'apps:startmenu:set',
  appsLaunch: 'apps:launch',
  agentsList: 'agents:list',
  agentsTemplates: 'agents:templates',
  agentsSave: 'agents:save',
  agentsDelete: 'agents:delete',
  agentsRun: 'agents:run',
  agentsStop: 'agents:stop',
  agentsRuns: 'agents:runs',
  agentsClearNotes: 'agents:clear-notes',
  evtAgent: 'evt:agent',
  tgStatus: 'tg:status',
  tgConnect: 'tg:connect',
  tgDisconnect: 'tg:disconnect',
  tgPairCode: 'tg:pair-code',
  tgUnlink: 'tg:unlink',
  tgChats: 'tg:chats',
  tgMessages: 'tg:messages',
  tgSend: 'tg:send',
  tgAutoReply: 'tg:autoreply',
  tgResolve: 'tg:resolve',
  evtTelegram: 'evt:telegram',
  modelsList: 'models:list',
  modelsSetKey: 'models:key:set',
  modelsClearKey: 'models:key:clear',
  modelsTest: 'models:test',
  telStatus: 'tel:status',
  telConsents: 'tel:consents',
  telGrant: 'tel:grant',
  telRevoke: 'tel:revoke',
  telCanCall: 'tel:can-call',
  telStart: 'tel:start',
  telState: 'tel:state',
  telReply: 'tel:reply',
  telHangup: 'tel:hangup',
  telCalls: 'tel:calls',
  telTranscript: 'tel:transcript',
  telDeleteTranscript: 'tel:transcript-delete',
  gatewayStatus: 'gateway:status',
  gatewayCode: 'gateway:code',
  gatewayDevices: 'gateway:devices',
  gatewayRevoke: 'gateway:revoke',
  crmGet: 'crm:get',
  crmSave: 'crm:save',
  crmDisconnect: 'crm:disconnect',
  crmTest: 'crm:test',
  crmDashboard: 'crm:dashboard',
  updateCheck: 'update:check',
  updateApply: 'update:apply',
  updateRestart: 'update:restart',
  evtUpdate: 'evt:update',
  profileGet: 'profile:get',
  profileSet: 'profile:set',
  profileClear: 'profile:clear',
  profileImport: 'profile:import',
  convList: 'conv:list',
  convCreate: 'conv:create',
  convRename: 'conv:rename',
  convDelete: 'conv:delete',
  convMessages: 'conv:messages',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  confirmRespond: 'confirm:respond',
  memoryList: 'memory:list',
  memoryAdd: 'memory:add',
  memoryDelete: 'memory:delete',
  auditList: 'audit:list',
  auditVerify: 'audit:verify',
  // события main -> renderer
  cameraFrame: 'camera:frame',
  evtCameraCapture: 'evt:camera-capture',
  evtChat: 'evt:chat',
  evtConfirm: 'evt:confirm',
  evtConfirmClosed: 'evt:confirm-closed',
} as const;

export interface JarvisApi {
  app: { info(): Promise<AppInfo> };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  secrets: {
    setApiKey(key: string): Promise<void>;
    clearApiKey(): Promise<void>;
  };
  voice: {
    setKey(key: string): Promise<void>;
    clearKey(): Promise<void>;
    /** Распознать речь (аудио уходит выбранному API). Работает только при включённом микрофоне. */
    transcribe(audio: Uint8Array, mime: string): Promise<string>;
    /** Облачный синтез речи (режим «api»). */
    speak(text: string): Promise<{ mime: string; data: Uint8Array }>;
  };
  computer: {
    get(): Promise<ComputerAccess>;
    /** Открывает окно выбора папки Windows; null — пользователь отменил. */
    addFolder(): Promise<ComputerAccess | null>;
    removeFolder(path: string): Promise<ComputerAccess>;
    /** Открывает окно выбора программы (.exe); null — отмена. */
    addApp(): Promise<ComputerAccess | null>;
    removeApp(name: string): Promise<ComputerAccess>;
    addBrowserHost(host: string): Promise<ComputerAccess>;
    removeBrowserHost(host: string): Promise<ComputerAccess>;
  };
  camera: {
    /** Главный процесс просит снять кадр (по просьбе ассистента, если камера включена пользователем). */
    onCaptureRequest(cb: (requestId: string) => void): () => void;
    /** Ответ на запрос кадра; null — камера выключена или недоступна. */
    sendFrame(requestId: string, frame: { mime: string; base64: string; width: number; height: number } | null): Promise<void>;
  };
  kb: {
    list(): Promise<KbDocDto[]>;
    save(doc: { id?: number; title: string; category: string; body: string; source?: string }): Promise<KbDocDto>;
    approve(id: number, approved: boolean): Promise<KbDocDto>;
    remove(id: number): Promise<void>;
    /** Выбор текстового файла (txt/md) → текст для нового черновика. */
    importFile(): Promise<{ name: string; text: string } | null>;
  };
  mentor: {
    courses(): Promise<CourseDto[]>;
    lesson(email: string, courseId: string, lessonId: string): Promise<LessonDto>;
    answer(email: string, courseId: string, lessonId: string, stepIdx: number, choice: number): Promise<{ correct: boolean; explain: string; correctIndex: number; progress: LessonProgressDto }>;
    verify(email: string, courseId: string, lessonId: string, stepIdx: number, selfConfirmed: boolean): Promise<{ ok: boolean; message: string; progress: LessonProgressDto }>;
    show(courseId: string, lessonId: string, stepIdx: number): Promise<string>;
    assign(email: string, name: string, courseId: string, dueAt?: string | null): Promise<void>;
    unassign(email: string, courseId: string): Promise<void>;
    assignments(email: string): Promise<{ courseId: string; dueAt: string | null }[]>;
    cabinet(): Promise<{ employees: EmployeeRowDto[]; crmConnected: boolean; note: string }>;
  };
  jobs: {
    list(): Promise<JobDto[]>;
    create(input: JobInputDto): Promise<JobDto>;
    setEnabled(id: number, enabled: boolean): Promise<JobDto>;
    remove(id: number): Promise<void>;
    runNow(id: number): Promise<JobResultDto>;
    runs(id: number): Promise<{ startedAt: string; status: string; summary: string | null }[]>;
    /** Задача по расписанию завершилась (не приходит, если итог «всё спокойно»). */
    onResult(cb: (r: JobResultDto) => void): () => void;
  };
  apps: {
    /** Названия программ из меню Пуск (если разрешено). */
    startMenu(): Promise<string[]>;
    setStartMenu(on: boolean): Promise<ComputerAccess>;
    /** Голосовая команда «открой …»: matched=false — не нашли, пусть разбирается модель. */
    launch(query: string): Promise<{ matched: boolean; ok: boolean; message: string }>;
  };
  agents: {
    list(): Promise<AgentDto[]>;
    templates(): Promise<AgentTemplateDto[]>;
    save(input: AgentInputDto): Promise<AgentDto>;
    remove(id: number): Promise<void>;
    /** Запустить агента (идёт в фоне; состояние — через list/runs). Подтверждения действий — на экране. */
    run(id: number, task: string): Promise<void>;
    stop(id: number): Promise<void>;
    runs(id: number): Promise<AgentRunDto[]>;
    clearNotes(id: number): Promise<void>;
    /** Агент закончил работу по расписанию (не приходит, если итог «OK»). */
    onResult(cb: (e: { agent: AgentDto; run: AgentRunDto }) => void): () => void;
  };
  telegram: {
    status(): Promise<TelegramStatusDto>;
    connect(token: string): Promise<TelegramStatusDto>;
    disconnect(): Promise<TelegramStatusDto>;
    pairCode(): Promise<{ code: string; expiresAt: string }>;
    unlink(): Promise<TelegramStatusDto>;
    chats(): Promise<TelegramChatDto[]>;
    messages(chatId: number): Promise<TelegramMessageDto[]>;
    send(chatId: number, text: string): Promise<TelegramMessageDto[]>;
    setAutoReply(chatId: number, on: boolean): Promise<TelegramChatDto[]>;
    resolveHuman(chatId: number): Promise<TelegramChatDto[]>;
    /** Новое сообщение, запрос «позовите человека» или ошибка Telegram. */
    onEvent(cb: (e: { kind: 'incoming' | 'handoff' | 'error'; chatId: number; name: string; text: string }) => void): () => void;
  };
  models: {
    list(): Promise<ProviderStatusDto[]>;
    setKey(id: FreeProviderId, key: string): Promise<ProviderStatusDto[]>;
    clearKey(id: FreeProviderId): Promise<ProviderStatusDto[]>;
    /** Проверка связи: короткий запрос к модели; возвращает её ответ. */
    test(id: FreeProviderId): Promise<string>;
  };
  telephony: {
    status(): Promise<{ provider: string; real: boolean; note: string }>;
    consents(): Promise<ConsentDto[]>;
    grant(i: { phone: string; name: string; email?: string; recording?: boolean; source?: string; confirmed: boolean }): Promise<ConsentDto[]>;
    revoke(phone: string): Promise<ConsentDto[]>;
    canCall(phone: string): Promise<{ ok: boolean; reason?: string }>;
    start(i: { phone: string; courseId: string; lessonId: string }): Promise<{ callId: number }>;
    state(id: number): Promise<CallStateDto>;
    reply(id: number, text: string): Promise<void>;
    hangup(id: number): Promise<void>;
    calls(): Promise<CallDto[]>;
    transcript(id: number): Promise<string | null>;
    deleteTranscript(id: number): Promise<void>;
  };
  gateway: {
    status(): Promise<GatewayStatusDto>;
    /** Одноразовый код подключения телефона (действует 5 минут). */
    pairCode(): Promise<{ code: string; expiresAt: string }>;
    devices(): Promise<GatewayDeviceDto[]>;
    revoke(id: number): Promise<GatewayDeviceDto[]>;
  };
  crm: {
    get(): Promise<CrmStatusDto>;
    save(cfg: { baseUrl: string; environment: 'test' | 'production'; email: string; maskPii: boolean; frontendUrl?: string }, password?: string): Promise<CrmStatusDto>;
    disconnect(): Promise<CrmStatusDto>;
    test(): Promise<CrmTestDto>;
    dashboard(): Promise<CrmDashboardDto>;
  };
  update: {
    check(): Promise<UpdateStatus>;
    /** Скачать и установить обновление (по кнопке). После успеха вызовите restart(). */
    apply(): Promise<{ sha: string; files: number }>;
    restart(): Promise<void>;
    onProgress(cb: (p: UpdateProgress) => void): () => void;
  };
  profile: {
    get(): Promise<ProfileSection[]>;
    set(section: string, text: string): Promise<ProfileSection[]>;
    clear(): Promise<ProfileSection[]>;
    /** Окно выбора текстового файла (txt/md/json, до 20 000 символов) для импорта сведений о себе; null — отмена. */
    importFile(): Promise<{ name: string; text: string; truncated: boolean } | null>;
  };
  attachments: {
    get(id: number): Promise<{ mime: string; base64: string } | null>;
  };
  conversations: {
    list(): Promise<Conversation[]>;
    create(title?: string): Promise<Conversation>;
    rename(id: number, title: string): Promise<void>;
    remove(id: number): Promise<void>;
    messages(id: number): Promise<ChatMessage[]>;
  };
  chat: {
    send(conversationId: number, text: string): Promise<{ runId: string }>;
    /** Кнопка «Стоп»: прерывает все активные запуски и закрывает запросы подтверждения. */
    stop(): Promise<void>;
    onEvent(cb: (e: ChatEvent) => void): () => void;
  };
  confirm: {
    respond(id: string, approve: boolean): Promise<void>;
    onRequest(cb: (r: ConfirmRequest) => void): () => void;
    onClosed(cb: (id: string) => void): () => void;
  };
  memory: {
    list(): Promise<MemoryItem[]>;
    add(kind: MemoryKind, content: string): Promise<MemoryItem>;
    remove(id: number): Promise<void>;
  };
  audit: {
    list(limit?: number): Promise<AuditEntry[]>;
    verify(): Promise<{ ok: boolean; checked: number; brokenAtId?: number }>;
  };
}

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}
