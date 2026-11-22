// Отсев эха: что делать с записанной фразой, если рядом говорил сам ассистент. Чистая функция — проверяется тестами.

export interface GateChunk {
  /** Момент окончания куска (performance.now()). */
  t: number;
  ms: number;
}

/** После окончания речи ассистента ещё столько мс — «хвост» эха и реверберации комнаты. */
export const ECHO_TAIL_MS = 300;
/** Фразы короче этого, начатые во время речи ассистента, пропускаем (возможное «стоп»). */
export const BARGE_IN_MAX_MS = 2500;
/** Меньше этого от вашей речи после его замолчания — не хватит для распознавания. */
export const MIN_KEPT_MS = 350;

export type GateResult<C extends GateChunk> = { drop: 'echo' | 'short' } | { chunks: C[]; startedAt: number };

export function applyEchoGate<C extends GateChunk>(
  chunks: C[],
  meta: { startedAt: number; endedAt: number },
  gate: { speaking: boolean; lastEnd: number } | undefined,
): GateResult<C> {
  if (!gate) return { chunks, startedAt: meta.startedAt };
  const dur = meta.endedAt - meta.startedAt;
  if (gate.speaking) {
    // Ассистент говорит: длинная «фраза» — почти наверняка он сам из колонок. Короткую («стоп») пропускаем.
    return dur > BARGE_IN_MAX_MS ? { drop: 'echo' } : { chunks, startedAt: meta.startedAt };
  }
  if (gate.lastEnd > 0) {
    const cut = gate.lastEnd + ECHO_TAIL_MS;
    if (meta.startedAt < cut) {
      const kept = chunks.filter((c) => c.t - c.ms / 2 >= cut);
      const keptMs = kept.reduce((a, c) => a + c.ms, 0);
      if (keptMs < MIN_KEPT_MS) return { drop: meta.endedAt <= cut ? 'echo' : 'short' };
      return { chunks: kept, startedAt: Math.max(meta.startedAt, cut) };
    }
  }
  return { chunks, startedAt: meta.startedAt };
}
