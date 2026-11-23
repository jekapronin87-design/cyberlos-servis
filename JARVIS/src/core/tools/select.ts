import type { ToolSpec } from './registry';

/**
 * Какие инструменты отправлять модели. Каждый инструмент — это описание на сотни токенов, и все ~80 уходят в КАЖДОМ запросе
 * (≈ 9 500 токенов до того, как пользователь что-то написал) — это главная статья расходов. Поэтому отправляем только те группы,
 * о которых речь в сообщении, а также те, что уже использовались в этом диалоге. Если нужного нет — модель вызывает tools_more.
 */
export const TOPICS: { id: string; title: string; match: RegExp; tools: RegExp }[] = [
  { id: 'crm', title: 'CRM: заявки, сделки, задачи, производство, склад', match: /crm|црм|сделк|заявк|воронк|лид|менеджер|производств|склад|клиент|аналитик|отч[её]т|стади|аквамастер|показател|цифр|статист|бизнес|продаж|монтаж|замер|сервис|холодн|дилер|сотрудник/i, tools: /^crm_/ },
  { id: 'video', title: 'видео: монтаж, субтитры, обложки, оформление канала, загрузка на YouTube', match: /видео|ролик|монтаж|субтитр|обложк|shorts|reels|youtube|ютуб|шапк|аватар|студи|канал|публикац/i, tools: /^video_/ },
  { id: 'youtube', title: 'YouTube: поиск и статистика (чтение)', match: /youtube|ютуб|канал|видео|ролик/i, tools: /^youtube_/ },
  { id: 'telegram', title: 'Telegram', match: /telegram|телеграм|телега|\bтг\b|бот|канал|чат/i, tools: /^telegram_/ },
  { id: 'files', title: 'файлы и папки', match: /файл|папк|документ|\.(txt|pdf|docx?|xlsx?|csv|md)\b|прочитай|сохрани|диск|рабочий стол|загрузк/i, tools: /^fs_/ },
  { id: 'web', title: 'интернет и браузер', match: /сайт|браузер|интернет|найди|поищи|погугли|загугли|страниц|ссылк|https?:|www\.|\.(ru|com|org)\b|поиск|новости|погода|курс/i, tools: /^browser_/ },
  { id: 'apps', title: 'запуск программ', match: /открой|запусти|программ|приложен|блокнот|калькулятор|chrome|хром|word|excel/i, tools: /^app_/ },
  { id: 'code', title: 'программирование: проекты, код, тесты, Git', match: /код|проект|скрипт|git|npm|тест|функци|баг|ошибк|репозитор|разработ|верстк|программ|напиши|исправь/i, tools: /^(project_|code_|run_script$|npm_install$|git_|delegate_task$)/ },
  { id: 'knowledge', title: 'база знаний, уроки, наставник', match: /база знаний|регламент|урок|курс|обуч|наставник|скрипт продаж|правил/i, tools: /^(kb_|mentor_|lesson_)/ },
  { id: 'schedule', title: 'задачи по расписанию', match: /кажд|расписан|напомни|ежедневн|еженедельн|утром|вечером|через \d+|по времени|автоматическ/i, tools: /^schedule_/ },
  { id: 'agents', title: 'агенты', match: /агент|поручи|субагент|ассистент.*для/i, tools: /^agent_/ },
  { id: 'calls', title: 'звонки', match: /звон|позвон|телефон|набери|вызов/i, tools: /^(call_|telephony_)/ },
  { id: 'screen', title: 'экран и камера', match: /экран|скриншот|камер|посмотри на|что на (экране|фото)|вижу/i, tools: /^(screen_|camera_)/ },
  { id: 'images', title: 'создание картинок', match: /картинк|нарисуй|изображен|иллюстрац|логотип|баннер|постер|фото/i, tools: /^image_generate$/ },
  { id: 'profile', title: 'досье о пользователе', match: /досье|обо мне|про меня|знакомимся|расскажу о себе|давай знакомиться/i, tools: /^profile_/ },
  { id: 'show', title: 'показ на экране: презентации, графики', match: /покажи|визуализ|статист|график|презентац|сравни|выведи на экран|диаграмм|покажи на экране/i, tools: /^show_/ },
];

/** Всегда доступно: время, память и «получить больше инструментов». */
const CORE = /^(get_datetime|list_memory|remember|forget_memory|tools_more)$/;

export interface SelectCtx {
  /** Текст текущего сообщения пользователя. */
  text: string;
  /** Несколько последних сообщений диалога (текст) — чтобы продолжение разговора не теряло инструменты. */
  recentText?: string;
  /** Имена инструментов, которые уже вызывались в последних сообщениях. */
  recentTools?: string[];
  /** Темы, добавленные моделью через tools_more в этом запуске. */
  extra?: ReadonlySet<string>;
}

export function selectTools(all: ToolSpec[], c: SelectCtx): { tools: ToolSpec[]; topics: string[] } {
  const hay = `${c.text}\n${c.recentText ?? ''}`;
  const on = new Set<string>();
  for (const t of TOPICS) if (t.match.test(c.text) || (c.extra?.has(t.id) ?? false)) on.add(t.id);
  // продолжение разговора: темы последних сообщений остаются
  if (c.recentText) for (const t of TOPICS) if (t.match.test(hay)) on.add(t.id);
  const used = new Set(c.recentTools ?? []);
  const topicOf = (name: string): string | null => TOPICS.find((t) => t.tools.test(name))?.id ?? null;
  const out = all.filter((s) => {
    if (CORE.test(s.name)) return true;
    const topic = topicOf(s.name);
    if (!topic) return true; // инструмент без темы (ядро) — всегда
    if (on.has(topic)) return true;
    if (used.has(s.name)) return true;
    return false;
  });
  return { tools: out, topics: [...on] };
}
