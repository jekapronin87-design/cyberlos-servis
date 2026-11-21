// Типы, общие для главного процесса, preload и рендерера.
// Не должны импортировать ничего из Node/Electron.

export type Role = 'owner' | 'manager' | 'employee' | 'viewer';

/** Уровень риска действия. critical — запрещено по умолчанию. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Разделение данных: учебные и производственные. */
export type DataDomain = 'local' | 'training' | 'production';

export type ProviderChoice = 'auto' | 'demo' | 'anthropic';
export type ThemeChoice = 'dark' | 'light' | 'system';

export interface Settings {
  provider: ProviderChoice;
  model: string;
  theme: ThemeChoice;
  /** Дополнительные инструкции пользователя к системному промпту. */
  customInstructions: string;
  /** С какого уровня риска запрашивать подтверждение (high и выше — всегда). */
  confirmFrom: 'low' | 'medium';
  /** Использовать долговременную память в ответах. */
  memoryEnabled: boolean;
  /** Разрешить изменение ПРОИЗВОДСТВЕННЫХ данных CRM (по умолчанию выключено навсегда до этапа 5). */
  allowProductionWrites: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'auto',
  model: 'claude-sonnet-5-5',
  theme: 'dark',
  customInstructions: '',
  confirmFrom: 'medium',
  memoryEnabled: true,
  allowProductionWrites: false,
};

// ---------- Контент сообщений ----------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolUseId: string;
      name: string;
      content: string;
      isError?: boolean;
      /** Результат был отклонён политикой или пользователем. */
      denied?: boolean;
    };

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: MessageRole;
  content: ContentBlock[];
  createdAt: string;
  provider?: string | null;
  model?: string | null;
}

export interface Conversation {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- Память ----------

export type MemoryKind = 'preference' | 'project' | 'task' | 'fact';

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  content: string;
  source: 'user' | 'assistant';
  createdAt: string;
}

// ---------- Журнал ----------

export type AuditDecision = 'allowed' | 'confirmed' | 'denied' | 'rejected' | 'error' | 'info';

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  risk: RiskLevel | null;
  decision: AuditDecision;
  details: Record<string, unknown> | null;
  hash: string;
}

// ---------- События чата (main -> renderer) ----------

export type ChatEvent =
  | { type: 'run_started'; runId: string; conversationId: number }
  | { type: 'message'; runId: string; message: ChatMessage }
  | { type: 'delta'; runId: string; conversationId: number; text: string }
  | { type: 'run_finished'; runId: string; conversationId: number; status: 'done' | 'stopped' | 'error'; error?: string };

export interface ConfirmRequest {
  id: string;
  runId: string;
  toolName: string;
  description: string;
  risk: RiskLevel;
  input: Record<string, unknown>;
  reason: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  /** Режим, в котором работает ассистент прямо сейчас. */
  mode: 'demo' | 'live';
  providerName: string;
  model: string;
  dataDir: string;
  hasApiKey: boolean;
  /** Секреты шифруются средствами ОС (DPAPI/Keychain/libsecret). */
  secretsEncrypted: boolean;
  role: Role;
}
