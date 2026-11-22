import { describe, expect, it } from 'vitest';
import { applyEchoGate } from '../src/renderer/voice/gate';

const mk = (from: number, to: number, ms = 50) => {
  const out: { t: number; ms: number }[] = [];
  for (let t = from + ms; t <= to; t += ms) out.push({ t, ms });
  return out;
};

describe('отсев эха колонок', () => {
  it('без сведений о речи ассистента — всё пропускается как есть', () => {
    const c = mk(0, 3000);
    expect(applyEchoGate(c, { startedAt: 0, endedAt: 3000 }, undefined)).toEqual({ chunks: c, startedAt: 0 });
  });

  it('ассистент говорит сейчас: длинная «фраза» — эхо; короткая («стоп») проходит', () => {
    expect(applyEchoGate(mk(0, 6000), { startedAt: 0, endedAt: 6000 }, { speaking: true, lastEnd: 0 })).toEqual({ drop: 'echo' });
    const c = mk(0, 1200);
    expect(applyEchoGate(c, { startedAt: 0, endedAt: 1200 }, { speaking: true, lastEnd: 0 })).toEqual({ chunks: c, startedAt: 0 });
  });

  it('ваша длинная фраза СРАЗУ после речи ассистента не теряется: отбрасывается только звук до его конца и хвост', () => {
    // ассистент замолчал на 10000; вы начали говорить на 10100 (запись началась ещё с эха в 9500) и говорили 4 с
    const c = mk(9500, 14000);
    const r = applyEchoGate(c, { startedAt: 9500, endedAt: 14000 }, { speaking: false, lastEnd: 10000 });
    expect('chunks' in r).toBe(true);
    if ('chunks' in r) {
      expect(r.startedAt).toBe(10300);
      expect(r.chunks[0]!.t - r.chunks[0]!.ms / 2).toBeGreaterThanOrEqual(10300);
      expect(r.chunks.reduce((a, x) => a + x.ms, 0)).toBeGreaterThan(3500); // почти вся ваша речь сохранена
    }
  });

  it('если после его речи звука почти нет — это был только хвост эха', () => {
    expect(applyEchoGate(mk(9000, 10200), { startedAt: 9000, endedAt: 10200 }, { speaking: false, lastEnd: 10000 })).toEqual({ drop: 'echo' });
    expect(applyEchoGate(mk(9000, 10500), { startedAt: 9000, endedAt: 10500 }, { speaking: false, lastEnd: 10000 })).toEqual({ drop: 'short' });
  });

  it('давно после речи ассистента — ничего не режем', () => {
    const c = mk(20000, 23000);
    expect(applyEchoGate(c, { startedAt: 20000, endedAt: 23000 }, { speaking: false, lastEnd: 10000 })).toEqual({ chunks: c, startedAt: 20000 });
  });
});
