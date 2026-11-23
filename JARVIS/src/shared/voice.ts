// Разбор голосовых команд. Чистые функции — работают и в рендерере, и в тестах.

export type VoiceCommand =
  | { kind: 'stop' }
  /** Слово-активатор («Системно»/«Джарвис») + команда (text может быть пустым — «Джарвис» без продолжения). */
  | { kind: 'wake'; text: string }
  | { kind: 'ignore' };

const BASE_WAKE = ['джарвис', 'джарвиз', 'жарвис', 'джервис', 'джарвес', 'джарвисе', 'jarvis', 'жарвиз', 'дарвис', 'системно', 'system', 'systemno', 'sistemno'];
const FILLERS = ['эй', 'привет', 'слушай', 'ну', 'алло', 'хей', 'окей', 'ок', 'так', 'слышишь', 'давай', 'а'];
const STOP_WORDS = ['стоп', 'остановись', 'остановите', 'отмена', 'отмени', 'хватит', 'замолчи', 'прекрати'];

export const DEFAULT_ASSISTANT_NAME = 'Системно';

export function normalizeSpeech(t: string): string {
  return t
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

/** Все слова-активаторы: имя ассистента и «Джарвис» (оставлен как второе имя). */
export function wakeWords(names: string[] = []): string[] {
  return [...new Set([...BASE_WAKE, ...names.map(normalizeSpeech).filter((n) => n.length >= 3 && !n.includes(' '))])];
}

/** Допуск на ошибки распознавания: чем длиннее слово, тем больше можно отличаться. */
const tolerance = (len: number): number => (len >= 8 ? 2 : len >= 6 ? 1 : 0);

export function isWakeWord(word: string, names: string[] = []): boolean {
  const w = normalizeSpeech(word);
  if (!w) return false;
  return wakeWords(names).some((v) => v === w || (w.length >= 6 && levenshtein(v, w) <= tolerance(v.length)));
}

/** Является ли фраза командой остановки: «стоп», «Джарвис, стоп», «остановись». */
export function isStopPhrase(text: string, names: string[] = []): boolean {
  const words = normalizeSpeech(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const rest = isWakeWord(words[0]!, names) ? words.slice(1) : words;
  return rest.length > 0 && rest.length <= 2 && STOP_WORDS.includes(rest[0]!);
}

/** Ищет слово-активатор в начале фразы (допускаются «эй», «привет» перед ним и разрыв слова «систем но»). Возвращает остаток фразы. */
function findWake(raw: string, names: string[]): { rest: string } | null {
  const words = [...raw.matchAll(/[\p{L}]+/gu)];
  const limit = Math.min(words.length, 3);
  for (let i = 0; i < limit; i++) {
    if (i > 0 && !words.slice(0, i).every((m) => FILLERS.includes(normalizeSpeech(m[0])))) break;
    const w = words[i]!;
    let end = w.index! + w[0].length;
    let hit = false;
    const nxt = words[i + 1];
    // Сначала склеенное («систем но» → «системно»), иначе «систем» засчитается как опечатка и «но» уйдёт в команду.
    if (nxt && isWakeWord(w[0] + nxt[0], names)) {
      hit = true;
      end = nxt.index! + nxt[0].length;
    } else hit = isWakeWord(w[0], names);
    if (hit) {
      let rest = raw.slice(end).replace(/^[\s,.!?:;\-–—]+/, '').trim();
      // «Системно, Джарвис.» — это два зова по имени подряд, а не команда «Джарвис»
      if (rest && normalizeSpeech(rest).split(' ').every((x) => isWakeWord(x, names))) rest = '';
      return { rest };
    }
  }
  return null;
}

/**
 * requireWake: реагируем только на фразы со словом-активатором в начале (или команду «стоп» без него).
 * Остальное — чужой разговор — отбрасывается.
 */
export function parseVoiceCommand(transcript: string, opts: { requireWake: boolean; names?: string[] }): VoiceCommand {
  const raw = transcript.trim();
  if (!raw) return { kind: 'ignore' };
  const names = opts.names ?? [];
  if (isStopPhrase(raw, names)) return { kind: 'stop' };

  const found = findWake(raw, names);
  if (found) return { kind: 'wake', text: found.rest };
  if (opts.requireWake) return { kind: 'ignore' };
  return { kind: 'wake', text: raw };
}

/**
 * Фразы, которые модели распознавания «выдумывают» на тишине и шуме («Продолжение следует…», «Субтитры сделал…»).
 * Такие результаты отбрасываются, иначе в режиме беседы они превратились бы в «команды».
 */
const JUNK = /продолжение следует|субтитры (сделал|создал|подготовил|делал)|редактор субтитров|корректор|спасибо за (просмотр|внимание)|подписывайтесь|ставьте лайки|dimatorzok|amara\.org|thanks for watching|subtitles by|до новых встреч/i;
export function isJunkTranscript(text: string): boolean {
  const t = normalizeSpeech(text);
  if (!t) return true;
  const words = t.split(' ');
  // «Выдуманные» фразы — всегда короткие; в длинной речи обычные слова вроде «спасибо за внимание» не делают её мусором
  if (words.length <= 8 && JUNK.test(text)) return true;
  if (t.length <= 2) return true; // «а», «э», «м»
  if (words.length >= 4 && new Set(words).size === 1) return true; // «да да да да»
  return false;
}

/** «Пока», «отбой», «всё, спасибо» — закончить беседу (ассистент перестаёт слушать без слова-имени). */
export function isEndPhrase(text: string): boolean {
  const t = normalizeSpeech(text);
  if (!t || t.split(' ').length > 6) return false;
  return /^((все|ну|ладно|хорошо|системно|джарвис)\s+)*(отбой|пока|до свидания|до связи|свободен|отдыхай|можешь отдыхать|спи|отключись|закончили|на сегодня все|спасибо пока|спасибо все|все спасибо)(\s+(спасибо|системно|джарвис|пока))*$/.test(t);
}

/**
 * Это распознано собственное слово ассистента (эхо колонок), а не ваша речь? Сравниваем слова с тем, что он говорил последние секунды:
 * если почти все слова фразы уже звучали из колонок — это эхо.
 */
export function isEchoOfSpeech(transcript: string, spokenRecently: string): boolean {
  const words = normalizeSpeech(transcript).split(' ').filter((w) => w.length >= 3);
  const spoken = new Set(normalizeSpeech(spokenRecently).split(' ').filter((w) => w.length >= 3));
  if (spoken.size === 0 || words.length === 0) return false;
  const hit = words.filter((w) => spoken.has(w)).length;
  // Длинная фраза: почти все слова уже звучали из колонок. Короткая («Евгений, я здесь»): ВСЕ её слова из его же недавней речи —
  // именно такие обрывки хвоста эха и запускали бесконечное «да, я здесь».
  if (words.length >= 4) return hit / words.length >= 0.75;
  return hit === words.length && words.join('').length >= 5;
}

/**
 * Модель распознавания на тишине и шуме иногда «зачитывает» подсказку-словарь, которую мы ей передали («Системно, Джарвис.»).
 * Такой результат — не речь, его отбрасываем. Одно слово («Системно») — это настоящий зов по имени, его не трогаем.
 */
export function isPromptLeak(transcript: string, hint: string): boolean {
  const t = normalizeSpeech(transcript).split(' ').filter(Boolean);
  const h = new Set(normalizeSpeech(hint).split(' ').filter(Boolean));
  if (t.length < 2 || h.size < 2) return false;
  return t.every((w) => h.has(w)) && new Set(t).size >= 2;
}

export type NavIntent = 'analytics' | 'city' | 'home' | 'agents' | 'stats' | 'studio' | 'briefing';

/**
 * Локальные команды перехода по интерфейсу («открой аналитику», «покажи наш город», «вернись»).
 * Разбираются без модели — мгновенно и бесплатно. Только короткие фразы, начинающиеся с глагола-команды.
 */
export function parseNavIntent(text: string): NavIntent | null {
  const t = normalizeSpeech(text);
  const words = t.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 9) return null;
  const verb = /^(открой|открыть|покажи|показать|включи|давай|запусти|перейди|переключись|вернись|вернуться|закрой|свернись|сверни|назад|домой|что)(?![а-я])/.test(t);
  if (!verb) return null;
  if (/^(открой|покажи|перейди( к| в)?|давай)( раздел)? агент(ов|ы|ам|ы)?$/.test(t)) return 'agents';
  if (/(^| )агент/.test(t)) return null; // «запусти агента Аналитик» — это поручение модели, а не переход
  if (/(^| )(вернись|вернуться|назад|домой|свернись|сверни)( |$)|закрой (аналитику|город|карточки|все|это)|на главную|главный экран/.test(t)) return 'home';
  if (/(^| )(город|города|городом|городу)( |$)|что (там )?(у нас )?с бизнесом|как (там )?(у нас )?бизнес|состояние бизнеса|карта бизнеса/.test(t)) return 'city';
  if (/сводк|брифинг|утренн(ий|юю|ее|ем)|что нового|что (у нас )?сегодня|что случилось/.test(t)) return 'briefing';
  if (/студи|монтажн(ый|ого|ому) стол|видеомонтаж/.test(t)) return 'studio';
  if (/аналитик|дашборд|карточки/.test(t)) return 'analytics';
  if (/статистик|показател|цифры|отчет по бизнесу|как дела в бизнесе/.test(t)) return 'stats';
  return null;
}

export interface SectionIntent {
  kind: 'production' | 'tasks' | 'stuck' | 'unassigned' | 'lowstock' | 'stage';
  /** Часть названия воронки для kind = stage. */
  pipelineLike?: string;
  /** Как назвать раздел вслух. */
  title: string;
}

/**
 * «Покажи, что у нас в производстве», «покажи просроченные задачи», «открой монтаж» → раздел живой CRM.
 * Только короткие фразы, начинающиеся с команды; разбирается без модели. Аналитика/город («покажи статистику по продажам») — отдельный разбор parseNavIntent.
 */
export function parseSectionIntent(text: string): SectionIntent | null {
  const t = normalizeSpeech(text);
  const words = t.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 10) return null;
  if (!/^(покажи|показать|открой|открыть|расскажи|давай посмотрим|дай|что|как|выведи)(?![а-я])/.test(t)) return null;
  if (/(^| )агент|программ|сайт|ютуб|youtube|телеграм/.test(t)) return null;
  if (/без ответственн/.test(t)) return { kind: 'unassigned', title: 'сделки без ответственного' };
  if (/застряв|завис|без движени|простаива|залежал/.test(t)) return { kind: 'stuck', title: 'сделки без движения' };
  if (/задач/.test(t)) return { kind: 'tasks', title: 'просроченные задачи' };
  if (/производств|(^| )цех(е|а|у|ом)?( |$)/.test(t)) return { kind: 'production', title: 'производство' };
  if (/остатк|материал|склад/.test(t)) return { kind: 'lowstock', title: 'материалы ниже минимума' };
  const pipes: [RegExp, string, string][] = [
    [/монтаж/, 'монтаж', 'монтаж'],
    [/замер/, 'замер', 'замеры'],
    [/сервис/, 'сервис', 'сервис'],
    [/холодн/, 'холодн', 'холодные лиды'],
    [/(^| )продаж/, 'продаж', 'продажи'],
    [/(^| )(лид|лиды|лидов|заявк)/, 'лид', 'лиды'],
  ];
  for (const [re, like, title] of pipes) if (re.test(t)) return { kind: 'stage', pipelineLike: like, title };
  return null;
}

export type ShowControl = 'next' | 'prev' | 'first' | 'pause' | 'play' | 'close';

/** Управление открытым показом голосом: «дальше», «назад», «пауза», «продолжай», «закрой». Только короткие фразы; разбирается без модели. */
export function parseShowControl(text: string): ShowControl | null {
  const t = normalizeSpeech(text);
  if (!t || t.split(' ').length > 5) return null;
  if (/^(дальше|далее|следующий( слайд)?|вперед|листай( дальше)?|давай дальше|покажи дальше)$/.test(t)) return 'next';
  if (/^(назад|предыдущий( слайд)?|вернись назад|верни назад|на шаг назад|покажи назад)$/.test(t)) return 'prev';
  if (/^(сначала|с начала|в начало|первый слайд|давай сначала)$/.test(t)) return 'first';
  if (/^(пауза|остановись|подожди|погоди|останови( показ)?)$/.test(t)) return 'pause';
  if (/^(продолжай|продолжи|продолжаем|играй|поехали)$/.test(t)) return 'play';
  if (/^(закрой( показ| презентацию| это| экран)?|убери( это| экран)?|хватит|выход|выйти|вернись|на главную|свернись|закончили|достаточно)$/.test(t)) return 'close';
  return null;
}

/**
 * «Открой хром», «запусти блокнот» → название программы. Не срабатывает на сайты, файлы, папки, документы и слишком длинные фразы —
 * их разбирает модель. Решение «такая программа есть и она одна» принимает ядро (resolveApp).
 */
export function parseAppIntent(text: string): string | null {
  if (/[\p{L}\d-]+\.[a-z]{2,}/iu.test(text) || /https?:|www\./i.test(text)) return null;
  const t = normalizeSpeech(text);
  const m = /^(открой|открыть|запусти|запустить|включи|стартани|давай)\s+(.+)$/.exec(t);
  if (!m) return null;
  let x = m[2]!;
  if (m[1] === 'давай') {
    const m2 = /^(откроем|запустим|включим)\s+(.+)$/.exec(x);
    if (!m2) return null;
    x = m2[2]!;
  }
  if (x.split(' ').length > 3) return null;
  if (/^(сайт|страниц|ссылк|файл|папк|документ|проект|диалог|чат|настройк|память|журнал|досье|аналитик|статистик|город|бизнес|карточк|камер|микрофон|звук)/.test(x)) return null;
  return x;
}

/** Подготовка ответа к озвучке: без служебной разметки и слишком длинных текстов. */
export function textForSpeech(text: string, maxChars = 800): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' (фрагмент кода пропущен) ')
    .replace(/<untrusted_data[\s\S]*?<\/untrusted_data>/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > 200 ? cut.slice(0, end + 1) : cut) + ' …';
}

export interface UtteranceMeta {
  /** Когда фраза началась и закончилась (мс, performance.now). */
  startedAt: number;
  endedAt: number;
}

/**
 * Похоже ли, что микрофон записал собственную речь Джарвиса из колонок (эхо), а не команду.
 * Короткие фразы (до 2.5 с) пропускаем всегда — это может быть «стоп».
 */
export function isLikelyEcho(meta: UtteranceMeta, speech: { speakingSince: number | null; lastSpokeEnd: number }, now = meta.endedAt): boolean {
  const duration = meta.endedAt - meta.startedAt;
  if (duration <= 2500) return false;
  const overlapsNow = speech.speakingSince !== null && speech.speakingSince <= now;
  const overlapsPast = speech.lastSpokeEnd >= meta.startedAt - 300;
  return overlapsNow || overlapsPast;
}
