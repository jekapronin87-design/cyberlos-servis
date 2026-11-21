// Типы, общие для главного процесса, preload и рендерера.
// Не должны импортировать ничего из Node/Electron.

export type Role = 'owner' | 'manager' | 'employee' | 'viewer';

/** Уровень риска действия. critical — запрещено по умолчанию. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Разделение данных: учебные и производственные. */
export type DataDomain = 'local' | 'training' | 'production';

export type ProviderChoice = 'auto' | 'demo' | 'anthropic';
export type ThemeChoice = 'dark' | 'light' | 'system';
/** push — по нажатию на микрофон; wake — постоянное прослушивание слова «Джарвис». */
export type VoiceMode = 'push' | 'wake';
/** off — молчит; system — голоса Windows (без ключа); api — облачный синтез речи. */
export type TtsMode = 'off' | 'system' | 'api';

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
  /** Главный выключатель микрофона. Пока false — доступ к микрофону запрещён на уровне приложения. */
  micEnabled: boolean;
  voiceMode: VoiceMode;
  ttsMode: TtsMode;
  /** OpenAI-совместимый API распознавания/синтеза речи. */
  voiceBaseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  /** Стиль голоса для облачного синтеза (поддерживает gpt-4o-mini-tts). */
  ttsInstructions: string;
  /** Скорость речи Джарвиса (1 — как сгенерировано; 1.15 — живее). */
  ttsSpeed: number;
  /** Использовать досье о пользователе в ответах. */
  profileEnabled: boolean;
  /** Голос Windows для режима «system» ('' — подобрать лучший русский автоматически). */
  systemVoice: string;
  /** Главный выключатель камеры. Пока false — доступа к камере нет на уровне приложения. */
  cameraEnabled: boolean;
  /** Как обращаться к пользователю. */
  userName: string;
  /** Включать прослушивание слова «Джарвис» сразу при запуске (нужны micEnabled и режим wake). */
  autoListen: boolean;
  /** Запускать JARVIS при входе в Windows. */
  launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'auto',
  model: 'claude-sonnet-5-5',
  theme: 'dark',
  customInstructions: '',
  confirmFrom: 'medium',
  memoryEnabled: true,
  allowProductionWrites: false,
  micEnabled: false,
  voiceMode: 'push',
  ttsMode: 'system',
  voiceBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'gpt-4o-mini-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'onyx',
  ttsInstructions:
    'Говори по-русски как Джарвис — уверенный, остроумный, вежливый ИИ-дворецкий. Темп живой, как в обычной беседе двух занятых людей: без растягивания слов и без долгих пауз между фразами. Интонация выразительная и тёплая, с лёгкой сдержанной иронией; низкий ровный тембр, чёткая дикция.',
  ttsSpeed: 1.15,
  profileEnabled: true,
  systemVoice: '',
  cameraEnabled: false,
  userName: '',
  autoListen: false,
  launchAtLogin: false,
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
      /** Вложения (снимки экрана) — хранятся отдельно, в БД только ссылки. */
      imageIds?: number[];
      /** Только в памяти при отправке модели: подгруженные изображения. */
      images?: { mime: string; base64: string }[];
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
  /** Задан ключ API для распознавания/синтеза речи. */
  hasVoiceKey: boolean;
  /** Секреты шифруются средствами ОС (DPAPI/Keychain/libsecret). */
  secretsEncrypted: boolean;
  role: Role;
}

// ---------- Доступ к компьютеру (этап 3) ----------

export interface AllowedApp {
  name: string;
  path: string;
  builtin?: boolean;
}

export interface ComputerAccess {
  /** Папки, с которыми ассистенту разрешено работать. Добавляет только пользователь через окно выбора. */
  folders: string[];
  apps: AllowedApp[];
  /** Дополнительные «внутренние» адреса (localhost, тестовый CRM), которые браузеру ассистента можно открывать. */
  browserHosts: string[];
}

// ---------- Досье о пользователе ----------

export type ProfileSectionId = 'about' | 'work' | 'people' | 'goals' | 'routine' | 'style' | 'avoid';

export interface ProfileSection {
  id: ProfileSectionId;
  title: string;
  hint: string;
  body: string;
  updatedAt: string | null;
}

export const PROFILE_SECTIONS: { id: ProfileSectionId; title: string; hint: string }[] = [
  { id: 'about', title: 'Обо мне', hint: 'Имя, возраст, город, семья, интересы, увлечения, что для вас важно.' },
  { id: 'work', title: 'Работа и бизнес', hint: 'Компании, проекты, роли, продукты, клиенты, команда, чем занимаетесь.' },
  { id: 'people', title: 'Близкие и коллеги', hint: 'Кто есть кто: имена, роли, важные детали («Анна — жена», «Игорь — менеджер по продажам»).' },
  { id: 'goals', title: 'Цели и планы', hint: 'Что хотите достичь: на год, на квартал, ближайшие дела.' },
  { id: 'routine', title: 'Распорядок и привычки', hint: 'Когда встаёте, работаете, отдыхаете; как любите проводить день.' },
  { id: 'style', title: 'Как со мной общаться', hint: 'Тон, длина ответов, обращение, юмор, что объяснять подробно, а что кратко.' },
  { id: 'avoid', title: 'Чего не делать', hint: 'О чём не напоминать и не говорить, что раздражает, какие решения нельзя принимать без вас.' },
];
