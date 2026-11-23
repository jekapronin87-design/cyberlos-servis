// Типы, общие для главного процесса, preload и рендерера.
// Не должны импортировать ничего из Node/Electron.

export type Role = 'owner' | 'manager' | 'employee' | 'viewer';

/** Уровень риска действия. critical — запрещено по умолчанию. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Разделение данных: учебные и производственные. */
export type DataDomain = 'local' | 'training' | 'production';

/** Модули JARVIS: каждый можно отключить целиком (инструменты, вкладки). */
export type ModuleId = 'computer' | 'dev' | 'crm' | 'mentor' | 'scheduler' | 'telephony' | 'gateway' | 'telegram' | 'agents' | 'youtube' | 'video';
export const MODULES: { id: ModuleId; title: string; description: string }[] = [
  { id: 'computer', title: 'Управление компьютером', description: 'Файлы, программы, браузер, снимок экрана, камера' },
  { id: 'dev', title: 'ИИ-программист', description: 'Проекты, правка кода, тесты, Git, субагенты' },
  { id: 'crm', title: 'CRM', description: 'Чтение CRM, отчёты, аналитика' },
  { id: 'mentor', title: 'ИИ-наставник', description: 'База знаний, уроки, кабинет руководителя' },
  { id: 'scheduler', title: 'Задачи по расписанию', description: 'Фоновые поручения и уведомления' },
  { id: 'telephony', title: 'Телефония', description: 'Голосовое обучение по телефону (с согласиями)' },
  { id: 'gateway', title: 'Доступ с телефона', description: 'Управление JARVIS с мобильного' },
  { id: 'telegram', title: 'Telegram', description: 'Бот: переписка, автоответчик, управление из Telegram' },
  { id: 'agents', title: 'Агенты', description: 'Свои ИИ-агенты: роль, права, расписание, отчёты' },
  { id: 'youtube', title: 'YouTube', description: 'Поиск, каналы, видео, комментарии (только чтение, по API-ключу)' },
  { id: 'video', title: 'Видео-студия', description: 'Монтаж роликов, субтитры, обложки, оформление канала' },
];

export type ProviderChoice = 'auto' | 'demo' | 'anthropic';
/** Бесплатные/дешёвые модели с OpenAI-совместимым интерфейсом. */
export type FreeProviderId = 'ollama' | 'openrouter' | 'groq' | 'gemini' | 'qwen' | 'custom';
export interface FreeProviderConfig {
  id: FreeProviderId;
  enabled: boolean;
  model: string;
  baseUrl: string;
}
/** smart — простое делают бесплатные модели, сложное — Claude; claude — только Claude; free — только бесплатные (платная не используется никогда). */
export type RoutingMode = 'smart' | 'claude' | 'free';
export const FREE_PROVIDER_PRESETS: { id: FreeProviderId; name: string; baseUrl: string; model: string; needsKey: boolean; local: boolean; help: string }[] = [
  { id: 'ollama', name: 'Ollama (Qwen на этом компьютере)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needsKey: false, local: true, help: 'Полностью бесплатно и приватно. Установите Ollama (ollama.com), затем в командной строке: ollama pull qwen2.5:7b' },
  { id: 'gemini', name: 'Google Gemini (бесплатный тариф)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', needsKey: true, local: false, help: 'Ключ бесплатно: aistudio.google.com → Get API key. Есть дневные лимиты.' },
  { id: 'groq', name: 'Groq (быстрый, бесплатный тариф)', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true, local: false, help: 'Ключ бесплатно: console.groq.com → API Keys. Есть лимиты запросов в минуту.' },
  { id: 'openrouter', name: 'OpenRouter (бесплатные модели «:free»)', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', needsKey: true, local: false, help: 'Ключ: openrouter.ai/keys. Бесплатные модели помечены «:free»; их список меняется — название можно поправить.' },
  { id: 'qwen', name: 'Qwen (Alibaba Cloud Model Studio)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true, local: false, help: 'Ключ: Alibaba Cloud Model Studio. Новым аккаунтам обычно дают бесплатную квоту; условия смотрите у них.' },
  { id: 'custom', name: 'Своя модель (любой OpenAI-совместимый адрес)', baseUrl: 'https://', model: '', needsKey: true, local: false, help: 'Например, LM Studio (http://127.0.0.1:1234/v1) или другой сервис.' },
];
export const DEFAULT_FREE_PROVIDERS: FreeProviderConfig[] = FREE_PROVIDER_PRESETS.map((p) => ({ id: p.id, enabled: false, model: p.model, baseUrl: p.baseUrl }));
export type ThemeChoice = 'dark' | 'light' | 'system';
/** push — по нажатию на микрофон; wake — постоянное прослушивание слова «Джарвис». */
export type VoiceMode = 'push' | 'wake';
/** off — молчит; system — голоса Windows (без ключа); api — облачный синтез речи. */
export type TtsMode = 'off' | 'system' | 'api';

export interface Settings {
  provider: ProviderChoice;
  routingMode: RoutingMode;
  freeProviders: FreeProviderConfig[];
  /** Модель для генерации картинок (ключ — тот же, что для голоса, OpenAI). */
  imageModel: string;
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
  /** Голосовой движок: classic — слово-имя + распознавание по фразам; realtime — «живой разговор» голос в голос (OpenAI Realtime). */
  voiceEngine: 'classic' | 'realtime';
  /** Я в наушниках: эхо колонок невозможно — не отсеивать «эхо» и разрешить перебивать ассистента. */
  voiceHeadphones: boolean;
  /** Терпение живого разговора к паузам: fast — отвечает быстрее, patient — дожидается конца длинной мысли. */
  realtimePatience: 'fast' | 'normal' | 'patient';
  /** Модель живого разговора (OpenAI Realtime). */
  realtimeModel: string;
  realtimeVoice: string;
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
  /** Telegram-бот включён (опрашивает сообщения). */
  telegramEnabled: boolean;
  /** Автоответчик: ИИ отвечает людям, написавшим боту (только текстом, по вашим инструкциям). */
  telegramAutoReply: boolean;
  /** Что можно рассказывать собеседникам (цены, график, контакты, FAQ). Автоответчик знает ТОЛЬКО это. */
  telegramReplyInstructions: string;
  /** Браузер ассистента: не спрашивать подтверждение на обычные клики и ввод (отправка, оплата, удаление — всегда спрашивать). */
  browserAutoApprove: boolean;
  /** Звуки интерфейса (клики, переключатели, пробуждение). */
  uiSounds: boolean;
  /** Громкость звуков интерфейса, 0–100. */
  uiVolume: number;
  /** Тихий фоновый «гул космоса». */
  uiAmbient: boolean;
  /** Сколько «единиц квоты» YouTube Data API разрешено тратить в сутки (у Google бесплатный лимит 10 000). */
  youtubeDailyUnits: number;
  /** Открывать на весь экран (F11 — переключить). */
  fullscreen: boolean;
  /** Имя ассистента (на него он откликается голосом; «Джарвис» остаётся запасным именем). */
  assistantName: string;
  /** Как обращаться к пользователю. */
  userName: string;
  /** Сколько секунд после обращения по имени ассистент продолжает слушать без слова-имени (беседа). */
  voiceSessionSec: number;
  /** Включать прослушивание слова «Джарвис» сразу при запуске (нужны micEnabled и режим wake). */
  autoListen: boolean;
  /** Запускать JARVIS при входе в Windows. */
  launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'auto',
  routingMode: 'smart',
  freeProviders: DEFAULT_FREE_PROVIDERS,
  imageModel: 'gpt-image-1',
  model: 'claude-sonnet-5-5',
  theme: 'dark',
  customInstructions: '',
  confirmFrom: 'medium',
  memoryEnabled: true,
  allowProductionWrites: false,
  micEnabled: false,
  voiceMode: 'push',
  ttsMode: 'system',
  voiceEngine: 'classic',
  voiceHeadphones: false,
  realtimePatience: 'patient',
  realtimeModel: 'gpt-realtime',
  realtimeVoice: 'cedar',
  voiceBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'gpt-4o-transcribe',
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
  fullscreen: true,
  youtubeDailyUnits: 3000,
  voiceSessionSec: 300,
  uiSounds: true,
  uiVolume: 70,
  uiAmbient: false,
  browserAutoApprove: false,
  telegramEnabled: false,
  telegramAutoReply: false,
  telegramReplyInstructions: '',
  assistantName: 'Системно',
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
  /** Разрешён запуск программ из меню Пуск (кроме оболочек, реестра, планировщика и т. п.). */
  startMenu?: boolean;
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
  /** Откуда данные: живая CRM «Аквамастер» (aqua) или CRM «Сайберлос» (по умолчанию). */
  source?: 'aqua';
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

export interface ProviderStatusDto {
  id: FreeProviderId;
  name: string;
  enabled: boolean;
  hasKey: boolean;
  needsKey: boolean;
  local: boolean;
  model: string;
  baseUrl: string;
  help: string;
}

// ---------- Telegram ----------

export interface TelegramStatusDto {
  connected: boolean;
  running: boolean;
  botName: string;
  botUsername: string;
  ownerLinked: boolean;
  ownerName: string;
  error?: string;
}

export interface TelegramChatDto {
  chatId: number;
  kind: string;
  name: string;
  username: string;
  isOwner: boolean;
  autoReply: boolean;
  needsHuman: boolean;
  lastAt: string | null;
  lastText: string;
  unread: number;
}

export interface TelegramMessageDto {
  id: number;
  dir: 'in' | 'out';
  text: string;
  at: string;
  auto: boolean;
}

// ---------- Агенты ----------

export type AgentGroupId = 'youtube' | 'web' | 'files' | 'apps' | 'crm' | 'dev' | 'telegram' | 'knowledge' | 'images' | 'screen' | 'video';

export const AGENT_GROUPS: { id: AgentGroupId; title: string; description: string; risky?: boolean }[] = [
  { id: 'video', title: 'Видео-студия', description: 'Монтаж из папки с исходниками, субтитры, обложки, пакет для публикации', risky: true },
  { id: 'web', title: 'Интернет (браузер)', description: 'Поиск, открыть сайт, прочитать, прокрутить, нажать, ввести текст' },
  { id: 'youtube', title: 'YouTube (только чтение)', description: 'Поиск видео и каналов, статистика, описания, комментарии' },
  { id: 'crm', title: 'CRM (только чтение)', description: 'Заявки, воронки, задачи, команда, производство, отчёты' },
  { id: 'knowledge', title: 'База знаний и обучение', description: 'Поиск по утверждённым документам, курсы, прогресс' },
  { id: 'telegram', title: 'Telegram', description: 'Читать переписку бота, отправлять сообщения (с подтверждением)', risky: true },
  { id: 'files', title: 'Файлы в разрешённых папках', description: 'Читать, создавать, менять файлы', risky: true },
  { id: 'apps', title: 'Запуск программ', description: 'Открывать программы по названию', risky: true },
  { id: 'dev', title: 'Программирование', description: 'Проекты, правка кода, тесты, Git', risky: true },
  { id: 'images', title: 'Картинки', description: 'Создание картинок (платно)', risky: true },
  { id: 'screen', title: 'Экран и камера', description: 'Снимок экрана, кадр с камеры', risky: true },
];

export interface AgentScheduleDto {
  kind: 'none' | 'daily' | 'weekdays' | 'interval';
  atTime: string | null;
  intervalMin: number | null;
}

export interface AgentInputDto {
  id?: number;
  name: string;
  description: string;
  instructions: string;
  groups: AgentGroupId[];
  /** read — только чтение и анализ; act — может предлагать действия (каждое — с вашим подтверждением на экране). */
  mode: 'read' | 'act';
  schedule: AgentScheduleDto;
  enabled: boolean;
}

export interface AgentDto extends AgentInputDto {
  id: number;
  notes: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | 'stopped' | null;
  lastSummary: string | null;
  running: boolean;
}

export interface AgentRunDto {
  id: number;
  agentId: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'error' | 'stopped';
  trigger: 'manual' | 'schedule' | 'assistant';
  task: string;
  report: string;
  steps: string[];
}

export interface AgentTemplateDto {
  key: string;
  input: AgentInputDto;
}

export interface AquaSectionDto {
  title: string;
  columns: string[];
  rows: string[][];
  total: number;
  note?: string;
}

export interface AquaStatusDto {
  configured: boolean;
  baseUrl: string;
  hasKey: boolean;
  maskPii: boolean;
}

export interface YoutubeStatusDto {
  hasKey: boolean;
  usedToday: number;
  limit: number;
}

// ---------- Видео-студия ----------

export type VideoLayout = 'talk' | 'reaction-split' | 'reaction-pip';
export type VideoSubStyle = 'bold' | 'neon' | 'clean';

export interface VideoFileDto {
  name: string;
  sizeMb: number;
  durationSec: number | null;
  /** Миниатюра (data URL), если уже снята. */
  thumb: string | null;
}

export interface VideoSpecDto {
  /** Ваше видео (лицо/рассказ) — имя файла из папки или часть названия. */
  face: string;
  /** Видео, которое вы показываете (для режимов реакции). */
  reference?: string;
  layout: VideoLayout;
  title?: string;
  subtitles: boolean;
  subStyle?: VideoSubStyle;
  cover?: boolean;
  /** Название папки результата. */
  name?: string;
}

export interface VideoStepDto {
  id: string;
  label: string;
  status: 'wait' | 'run' | 'done' | 'error' | 'skip';
  pct?: number;
}

export interface VideoClipDto {
  start: number;
  end: number;
  label: string;
  thumbs?: string[];
}

export interface VideoTrackDto {
  id: string;
  label: string;
  kind: 'ref' | 'face' | 'audio' | 'subs' | 'title';
  clips: VideoClipDto[];
}

/** Монтажный стол: что куда кладётся и как идёт работа (показывается на экране в космическом стиле). */
export interface VideoPlanDto {
  id: string;
  name: string;
  layout: VideoLayout;
  width: number;
  height: number;
  duration: number;
  /** Секунда, где «реакция» переходит в ваш рассказ (0 — без реакции). */
  split: number;
  tracks: VideoTrackDto[];
  steps: VideoStepDto[];
  warnings: string[];
  output?: { dir: string; video: string; cover?: string };
  error?: string;
  finished: boolean;
}

export interface VideoStatusDto {
  folder: string | null;
  /** Предложение папки (на рабочем столе), если она есть, но ещё не выбрана. */
  suggested: string | null;
  ffmpeg: boolean;
  hasVoiceKey: boolean;
  busy: boolean;
}

export interface VideoArtResultDto {
  dir: string;
  banner: string;
  avatar: string;
  bannerData: string;
  avatarData: string;
}

export interface YtUploadStatusDto {
  hasClient: boolean;
  connected: boolean;
  channel: string | null;
  channelId: string | null;
  handle: string | null;
  channelError: string | null;
  clientId: string;
}

export interface YtUploadResultDto {
  id: string;
  url: string;
  privacy: 'private' | 'unlisted' | 'public';
  warnings: string[];
  channel: string | null;
}

export interface VideoResultDto {
  name: string;
  dir: string;
  video: string | null;
  cover: string | null;
}
