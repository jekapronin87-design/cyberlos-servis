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
    if (hit) return { rest: raw.slice(end).replace(/^[\s,.!?:;\-–—]+/, '').trim() };
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
