import { describe, expect, it } from 'vitest';
import { concat, downsample, encodeWav } from '../src/renderer/voice/wav';

describe('WAV для распознавания речи', () => {
  it('корректный заголовок и размер', () => {
    const wav = encodeWav(new Float32Array(1600), 16000);
    const s = (o: number, n: number) => String.fromCharCode(...wav.slice(o, o + n));
    expect(s(0, 4)).toBe('RIFF');
    expect(s(8, 4)).toBe('WAVE');
    expect(s(36, 4)).toBe('data');
    const dv = new DataView(wav.buffer);
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint16(22, true)).toBe(1);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(wav.length).toBe(44 + 3200);
  });
  it('понижение частоты 48 кГц → 16 кГц сохраняет длительность', () => {
    const out = downsample(new Float32Array(48000), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(downsample(new Float32Array(10), 16000, 16000).length).toBe(10);
  });
  it('тихая речь подтягивается по громкости, но не шум', () => {
    const quiet = new Float32Array(100).fill(0.05);
    const dv = (w: Uint8Array) => new DataView(w.buffer).getInt16(44, true);
    expect(dv(encodeWav(quiet, 16000))).toBeGreaterThan(0.55 * 32767);
    expect(dv(encodeWav(quiet, 16000, false))).toBeLessThan(0.06 * 32767);
    const noise = new Float32Array(100).fill(0.002);
    expect(dv(encodeWav(noise, 16000))).toBeLessThan(0.01 * 32767);
  });
  it('склейка кусков', () => {
    expect(Array.from(concat([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3]);
  });
});
