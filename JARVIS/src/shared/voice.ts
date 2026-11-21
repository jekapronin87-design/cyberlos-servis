// Разбор голосовых команд. Чистые функции — работают и в рендерере, и в тестах.

export type VoiceCommand =
  | { kind: 'stop' }
  /** Слово «Джарвис» + команда (text может быть пустым — «Джарвис» без продолжения). */
  | { kind: 'wake'; text: string }
  | { kind: 'ignore' };

const WAKE_VARIANTS = ['джарвис', 'джарвиз', 'жарвис', 'джервис', 'джарвес', 'джарвисе', 'jarvis', 'жарвиз'];
const STOP_WORDS = ['стоп', 'остановись', 'остановите', 'отмена', 'отмени', 'хватит', 'замолчи', 'прекрати'];

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

export function isWakeWord(word: string): boolean {
  const w = normalizeSpeech(word);
  if (!w) return false;
  return WAKE_VARIANTS.some((v) => v === w || (w.length >= 6 && levenshtein(v, w) <= 1));
}

/** Является ли фраза командой остановки: «стоп», «Джарвис, стоп», «остановись». */
export function isStopPhrase(text: string): boolean {
  const words = normalizeSpeech(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const rest = isWakeWord(words[0]!) ? words.slice(1) : words;
  return rest.length > 0 && rest.length <= 2 && STOP_WORDS.includes(rest[0]!);
}

/**
 * wake=true: реагируем только на фразы со словом «Джарвис» в начале (или команду «стоп» без него).
 * Остальное — чужой разговор — отбрасывается.
 */
export function parseVoiceCommand(transcript: string, opts: { requireWake: boolean }): VoiceCommand {
  const raw = transcript.trim();
  if (!raw) return { kind: 'ignore' };
  if (isStopPhrase(raw)) return { kind: 'stop' };

  const m = raw.match(/^[\s,.!?:;\-–—«»"']*([\p{L}]+)[\s,.!?:;\-–—]*(.*)$/su);
  if (m && isWakeWord(m[1]!)) return { kind: 'wake', text: (m[2] ?? '').trim() };
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
