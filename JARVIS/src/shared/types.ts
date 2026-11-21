// Типы, общие для главного процесса, preload и рендерера.
// Не должны импортировать ничего из Node/Electron.

export type Role = 'owner' | 'manager' | 'employee' | 'viewer';

/** Уровень риска действия. critical — запрещено по умолчанию. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Разделение данных: учебные и производственные. */
export type DataDomain = 'local' | 'training' | 'production';

/** Модули JARVIS: каждый можно отключить целиком (инструменты, вкладки). */
export type ModuleId = 'computer' | 'dev' | 'crm' | 'mentor' | 'scheduler' | 'telephony' | 'gateway';
export const MODULES: { id: ModuleId; title: string; description: string }[] = [
  { id: 'computer', title: 'Управление компьютером', description: 'Файлы, программы, браузер, снимок экрана, камера' },
  { id: 'dev', title: 'ИИ-программист', description: 'Проекты, правка кода, тесты, Git, субагенты' },
  { id: 'crm', title: 'CRM', description: 'Чтение CRM, отчёты, аналитика' },
  { id: 'mentor', title: 'ИИ-наставник', description: 'База знаний, уроки, кабинет руководителя' },
  { id: 'scheduler', title: 'Задачи по расписанию', description: 'Фоновые поручения и уведомления' },
  { id: 'telephony', title: 'Телефония', description: 'Голосовое обучение по телефону (с согласиями)' },
  { id: 'gateway', title: 'Доступ с телефона', description: 'Управление JARVIS с мобильного' },
];

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
  /** Ветка GitHub, из которой приложение берёт обновления. */
  updateBranch: string;
  /** Отключённые модули (для установок в других компаниях или чтобы убрать лишнее). */
  disabledModules: ModuleId[];
  /** Разрешить телефону просить подтверждение действий на этом компьютере (иначе с телефона — только чтение/анализ). */
  gatewayAllowActions: boolean;
  /** Доступ с телефона: off — выключен; localhost — только этот компьютер (для проверки); lan — по домашней сети Wi‑Fi. */
  gatewayMode: 'off' | 'localhost' | 'lan';
  /** Телефония: окно допустимого времени звонков (местное время), лимиты. */
  callWindowFrom: string;
  callWindowTo: string;
  callMaxPerDay: number;
  callMaxPerNumberPerDay: number;
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
  updateBranch: 'claude/jarvis-personal-ai-assistant-wbsf6v',
  disabledModules: [],
  gatewayAllowActions: false,
  gatewayMode: 'off',
  callWindowFrom: '09:00',
  callWindowTo: '20:00',
  callMaxPerDay: 10,
  callMaxPerNumberPerDay: 2,
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

// ---------- Обновление приложения ----------

export interface UpdateStatus {
  /** Самообновление возможно (не упакованная установка из папки). */
  canUpdate: boolean;
  reason?: string;
  installedSha: string | null;
  latest: { sha: string; message: string; date: string } | null;
  /** null — неизвестно (первое обновление: текущая версия не отслеживалась). */
  upToDate: boolean | null;
  branch: string;
}

export interface UpdateProgress {
  step: 'check' | 'download' | 'extract' | 'install' | 'done' | 'error';
  message: string;
}

// ---------- CRM (только чтение) ----------

export interface CrmStatusDto {
  configured: boolean;
  baseUrl: string;
  environment: 'test' | 'production';
  email: string;
  hasPassword: boolean;
  maskPii: boolean;
  frontendUrl: string;
}

export interface CrmTestDto {
  ok: boolean;
  error?: string;
  user?: { email: string; role: string; roleName: string | null };
  missingRead: string[];
  writeLike: string[];
  fullAdmin: boolean;
  readOnlySafe: boolean;
}

export interface CrmDashboardDto {
  overview: {
    pipelines: { name: string; slug: string; open: number; won: number; lost: number; byStage: { name: string; open: number; breaches: number }[] }[];
    newLast24h: number;
    unassignedOpen: number;
    stuck: number;
    tasksOpen: number;
    tasksOverdue: number;
    productionOpen: number;
    productionOverdue: number;
    awaitingPrepayment: number;
    lowStock: number;
  };
  managers: { name: string; role: string; openDeals: number; stuckDeals: number; tasksOpen: number; tasksOverdue: number; doneOnTime: number; doneLate: number }[];
  issues: { kind: string; dealId: string; title: string; pipeline: string; stage: string; who: string[]; detail: string }[];
  needs: { employee: string; total: number; topics: { topic: string; kind: string; count: number }[] }[];
  missing: string[];
  truncated: boolean;
  at: string;
}

// ---------- Задачи по расписанию ----------

export interface JobDto {
  id: number;
  title: string;
  prompt: string;
  kind: 'daily' | 'weekdays' | 'interval' | 'once';
  atTime: string | null;
  intervalMin: number | null;
  runAt: string | null;
  enabled: boolean;
  notify: boolean;
  speak: boolean;
  conversationId: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | 'stopped' | 'skipped' | null;
  lastSummary: string | null;
}

export interface JobInputDto {
  title: string;
  prompt: string;
  kind: JobDto['kind'];
  atTime?: string | null;
  intervalMin?: number | null;
  runAt?: string | null;
  notify?: boolean;
  speak?: boolean;
}

export interface JobResultDto {
  job: JobDto;
  status: JobDto['lastStatus'];
  summary: string;
  quiet: boolean;
}

// ---------- ИИ-наставник ----------

export interface KbDocDto {
  id: number;
  title: string;
  category: 'crm_guide' | 'regulation' | 'sales_script' | 'material' | 'faq';
  body: string;
  source: string;
  status: 'draft' | 'approved';
  version: number;
  builtin: boolean;
  approvedAt: string | null;
  updatedAt: string;
}

export interface LessonProgressDto {
  total: number;
  done: number;
  completed: boolean;
  score: number | null;
}

export interface LessonStepDto {
  kind: 'explain' | 'quiz' | 'task';
  text?: string;
  question?: string;
  options?: string[];
  kb?: { title: string; version: number } | null;
  verify?: 'self' | 'crm_training_deal';
  canShow?: boolean;
  done: boolean;
}

export interface LessonDto {
  courseId: string;
  id: string;
  title: string;
  goal: string;
  steps: LessonStepDto[];
  progress: LessonProgressDto;
}

export interface CourseDto {
  id: string;
  title: string;
  description: string;
  roles: string[];
  lessons: { id: string; title: string; goal: string }[];
}

export interface EmployeeRowDto {
  email: string;
  name: string;
  role: string;
  assignments: { courseId: string; title: string; dueAt: string | null; done: number; total: number; score: number | null }[];
  lastActivity: string | null;
  recommendations: { courseId: string; lessonId: string; title: string; reason: string; count: number }[];
  issues: number;
}

// ---------- Доступ с телефона ----------

export interface GatewayStatusDto {
  mode: 'off' | 'localhost' | 'lan';
  running: boolean;
  port: number;
  urls: string[];
  error?: string;
}

export interface GatewayDeviceDto {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

// ---------- Телефония (каркас) ----------

export interface ConsentDto {
  id: number;
  phone: string;
  name: string;
  email: string;
  training: boolean;
  recording: boolean;
  grantedAt: string;
  revokedAt: string | null;
  source: string;
}

export interface CallDto {
  id: number;
  phone: string;
  name: string;
  courseId: string;
  lessonId: string;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  correct: number;
  total: number;
  recorded: boolean;
  summary: string | null;
}

export interface CallStateDto {
  id: number;
  status: string;
  /** Реплики разговора (только в симуляторе и при согласии на запись). */
  lines: { who: 'jarvis' | 'employee' | 'system'; text: string }[];
  awaitingReply: boolean;
  finished: boolean;
}
