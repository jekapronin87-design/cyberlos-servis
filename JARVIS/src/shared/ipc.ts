import type {
  AppInfo,
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
