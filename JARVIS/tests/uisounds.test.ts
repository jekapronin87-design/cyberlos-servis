import { describe, expect, it } from 'vitest';
import { RECIPES, UiSounds, type SoundKind } from '../src/renderer/audio/uiSounds';

function fakeCtx() {
  const log: { f: number; gain: number }[] = [];
  const ctx = {
    currentTime: 0,
    destination: {},
    state: 'running',
    createOscillator: () => {
      const o = { type: 'sine', frequency: { setValueAtTime: (v: number) => (o.f = v), exponentialRampToValueAtTime: () => undefined }, f: 0, connect: () => undefined, start: () => log.push({ f: o.f, gain: 0 }), stop: () => undefined };
      return o;
    },
    createGain: () => ({ gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: () => undefined }),
  };
  return { ctx, log };
}

describe('звуки интерфейса', () => {
  it('у каждого звука есть ноты, они короткие и тихие', () => {
    for (const [k, notes] of Object.entries(RECIPES)) {
      expect(notes.length, k).toBeGreaterThan(0);
      for (const n of notes) {
        expect(n.dur).toBeLessThan(k === 'boot' ? 1.2 : k === 'sweep' ? 1.6 : k === 'whoosh' ? 0.5 : 0.4);
        expect(n.gain).toBeLessThanOrEqual(0.3);
        expect(n.f).toBeGreaterThan(50);
      }
    }
  });
  it('играет только когда включено; при микрофоне без «наведения»; частые повторы сглаживаются', () => {
    const { ctx, log } = fakeCtx();
    const s = new UiSounds(() => ctx as never);
    s.enabled = false;
    s.play('click');
    expect(log).toHaveLength(0);
    s.enabled = true;
    s.play('click');
    expect(log.length).toBeGreaterThanOrEqual(RECIPES.click.length);
    log.length = 0;
    s.play('click'); // сразу же второй раз — подавляется
    expect(log).toHaveLength(0);
    s.micActive = true;
    s.play('hover');
    s.play('open');
    expect(log).toHaveLength(0);
    s.play('wake');
    expect(log.length).toBeGreaterThanOrEqual(RECIPES.wake.length);
  });
  it('сбой звуковой системы не ломает интерфейс', () => {
    const s = new UiSounds(() => {
      throw new Error('нет звука');
    });
    expect(() => (['click', 'error', 'success'] as SoundKind[]).forEach((k) => s.play(k))).not.toThrow();
  });
});
