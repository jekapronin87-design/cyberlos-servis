import type {
  AppInfo,
  ComputerAccess,
  ProfileSection,
  UpdateProgress,
  UpdateStatus,
  CrmStatusDto,
  JobDto,
  JobInputDto,
  JobResultDto,
  CrmTestDto,
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
  jobsList: 'jobs:list',
  jobsCreate: 'jobs:create',
  jobsToggle: 'jobs:toggle',
  jobsDelete: 'jobs:delete',
  jobsRunNow: 'jobs:run-now',
  jobsRuns: 'jobs:runs',
  evtJob: 'evt:job',
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
  crm: {
    get(): Promise<CrmStatusDto>;
    save(cfg: { baseUrl: string; environment: 'test' | 'production'; email: string; maskPii: boolean }, password?: string): Promise<CrmStatusDto>;
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
