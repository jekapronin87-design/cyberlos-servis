import { describe, expect, it } from 'vitest';
import { fbm, genMilkyWay, genStars, genTexture, makeSphereGeom, shadeSphere, vnoise } from '../src/renderer/hud/spaceGen';

describe('космос: процедурные текстуры', () => {
  it('шум детерминирован и замкнут по долготе', () => {
    expect(fbm(1.3, 2.7, 5, 3)).toBe(fbm(1.3, 2.7, 5, 3));
    expect(vnoise(0.4, 1.2, 1, 6)).toBeCloseTo(vnoise(6.4, 1.2, 1, 6), 10);
    const v = fbm(3.3, 1.1, 6, 2);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('Земля: есть и океан, и суша, и облака, и огни городов; текстура повторяема', () => {
    const t = genTexture('earth', 128, 64);
    let ocean = 0, land = 0;
    for (let i = 0; i < t.w * t.h; i++) (t.water![i]! > 128 ? ocean++ : land++);
    expect(ocean).toBeGreaterThan(t.w * t.h * 0.3);
    expect(land).toBeGreaterThan(t.w * t.h * 0.1);
    expect(Math.max(...t.cloud!)).toBeGreaterThan(150);
    expect(Math.max(...t.lights!)).toBeGreaterThan(50);
    expect(genTexture('earth', 128, 64).rgb).toEqual(t.rgb);
  });

  it('у каждого тела своя характерная окраска', () => {
    const avg = (k: Parameters<typeof genTexture>[0]) => {
      const t = genTexture(k, 64, 32);
      const s = [0, 0, 0];
      for (let i = 0; i < t.w * t.h; i++) for (let c = 0; c < 3; c++) s[c]! += t.rgb[i * 3 + c]!;
      return s.map((v) => v / (t.w * t.h));
    };
    const mars = avg('mars'), neptune = avg('neptune'), moon = avg('moon'), sun = avg('sun');
    expect(mars[0]!).toBeGreaterThan(mars[2]! + 50); // красноватый
    expect(neptune[2]!).toBeGreaterThan(neptune[0]! + 60); // синий
    expect(Math.abs(moon[0]! - moon[2]!)).toBeLessThan(25); // серый
    expect(sun[0]!).toBeGreaterThan(200);
  });

  it('освещённый шар: дневная сторона светлее ночной, за диском — прозрачность', () => {
    const tex = genTexture('mars', 64, 32);
    const g = makeSphereGeom(20);
    const out = new Uint8ClampedArray(g.size * g.size * 4);
    shadeSphere(g, tex, { light: [1, 0, 0.3], spin: 0 }, out);
    const lum = (x: number, y: number) => out[(y * g.size + x) * 4]! + out[(y * g.size + x) * 4 + 1]! + out[(y * g.size + x) * 4 + 2]!;
    const mid = Math.floor(g.size / 2);
    expect(lum(mid + 14, mid)).toBeGreaterThan(lum(mid - 14, mid) * 3);
    expect(out[3]).toBe(0); // угол квадрата вне диска
  });

  it('Млечный Путь: полоса ярче краёв; звёзд много, ярких мало', () => {
    const w = 80, h = 50;
    const buf = new Uint8ClampedArray(w * h * 4);
    genMilkyWay({ w, h, angle: -0.5 }, buf);
    const lum = (x: number, y: number) => buf[(y * w + x) * 4]! + buf[(y * w + x) * 4 + 1]!;
    let center = 0, edge = 0;
    for (let x = 20; x < 60; x++) { center += lum(x, 25 + Math.round((x - 40) * Math.tan(-0.5))); edge += lum(x, 2) + lum(x, 47); }
    expect(center / 40).toBeGreaterThan(edge / 80);
    const stars = genStars(2000, 1000, 600, -0.5);
    expect(stars.length).toBeGreaterThan(1500);
    expect(stars.filter((s) => s.mag > 0.5).length).toBeLessThan(stars.length * 0.1);
  });
});
