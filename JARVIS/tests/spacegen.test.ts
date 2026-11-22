import { describe, expect, it } from 'vitest';
import { genCorona, moonPlacement, fbm, genMilkyWay, genStars, genTexture, makeSphereGeom, shadeSphere, vnoise } from '../src/renderer/hud/spaceGen';

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

describe('Луна и корона', () => {
  it('Луна обходит Землю: за Землёй (дальняя половина орбиты) и перед ней, орбита сплюснута как у планет', () => {
    const r = 20;
    let behind = 0, front = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.1) (moonPlacement(a, r).behind ? behind++ : front++);
    expect(Math.abs(behind - front)).toBeLessThan(4);
    const far = moonPlacement(-Math.PI / 2, r);
    expect(far.behind).toBe(true);
    expect(Math.abs(far.dx)).toBeLessThan(1);
    expect(far.dy).toBeLessThan(0); // дальняя точка — выше центра Земли
    expect(Math.abs(far.dy)).toBeLessThan(r); // за диском Земли: Луна скрыта
    const near = moonPlacement(Math.PI / 2, r);
    expect(near.behind).toBe(false);
    expect(near.dy).toBeGreaterThan(0);
    expect(near.scale).toBeGreaterThan(far.scale); // ближняя половина крупнее
    expect(Math.abs(moonPlacement(0, r).dy)).toBeLessThan(1); // у края — на уровне Земли
  });
  it('корона плавная: яркость убывает от центра, без резких «лучей»; за краем прозрачно', () => {
    const size = 128;
    const buf = new Uint8ClampedArray(size * size * 4);
    genCorona(size, buf);
    const a = (x: number, y: number) => buf[(y * size + x) * 4 + 3]!;
    const c = size / 2;
    expect(a(c, c)).toBeGreaterThan(a(c + 20, c));
    expect(a(c + 20, c)).toBeGreaterThan(a(c + 55, c));
    expect(a(0, 0)).toBe(0);
    // соседние по углу точки на одном радиусе отличаются умеренно (плавность)
    let maxJump = 0;
    for (let k = 0; k < 360; k += 2) {
      const t1 = (k * Math.PI) / 180, t2 = ((k + 2) * Math.PI) / 180;
      const v1 = a(Math.round(c + Math.cos(t1) * 32), Math.round(c + Math.sin(t1) * 32));
      const v2 = a(Math.round(c + Math.cos(t2) * 32), Math.round(c + Math.sin(t2) * 32));
      maxJump = Math.max(maxJump, Math.abs(v1 - v2));
    }
    expect(maxJump).toBeLessThan(40);
  });
});
