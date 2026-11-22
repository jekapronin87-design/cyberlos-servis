import { useEffect, useRef } from 'react';
import { genCorona, genMilkyWay, genStars, genTexture, hash, makeSphereGeom, moonPlacement, shadeSphere, type BodyKind, type SphereGeom, type Texture } from './spaceGen';

/**
 * Реалистичный космос: фотографичный Млечный Путь с пылевыми рукавами и цветными звёздами, Солнечная система «издалека и сверху»:
 * Солнце с короной и бликами, планеты с процедурно сгенерированными поверхностями (облака и огни городов Земли, Большое красное пятно Юпитера,
 * кольца Сатурна, кратеры Меркурия и Луны), освещённые Солнцем (фазы), с атмосферами. Без схематичных орбит. Ассистент (шар) парит над системой.
 * Это не фотографии NASA, а процедурная графика: реальных текстур в программе нет.
 */
interface Body {
  kind: BodyKind;
  name: string;
  orbit: number; // доля ширины экрана
  size: number; // радиус, px при ширине 1400
  speed: number;
  phase: number;
  spinRate: number;
  tilt?: number;
  atmo?: [number, number, number];
  ring?: boolean;
  moon?: boolean;
}
const BODIES: Body[] = [
  { kind: 'mercury', name: 'Меркурий', orbit: 0.1, size: 6, speed: 1.6, phase: 0.6, spinRate: 0.02 },
  { kind: 'venus', name: 'Венера', orbit: 0.16, size: 13, speed: 1.17, phase: 2.2, spinRate: 0.01, atmo: [255, 220, 150] },
  { kind: 'earth', name: 'Земля', orbit: 0.23, size: 15, speed: 1, phase: 4.1, spinRate: 0.06, atmo: [90, 150, 255], moon: true },
  { kind: 'mars', name: 'Марс', orbit: 0.3, size: 10, speed: 0.8, phase: 1.1, spinRate: 0.05, atmo: [255, 150, 110] },
  { kind: 'jupiter', name: 'Юпитер', orbit: 0.5, size: 34, speed: 0.43, phase: 3.0, spinRate: 0.12 },
  { kind: 'saturn', name: 'Сатурн', orbit: 0.64, size: 28, speed: 0.32, phase: 5.2, spinRate: 0.1, tilt: -0.4, ring: true },
  { kind: 'uranus', name: 'Уран', orbit: 0.77, size: 15, speed: 0.23, phase: 0.2, spinRate: 0.07, atmo: [150, 235, 245] },
  { kind: 'neptune', name: 'Нептун', orbit: 0.9, size: 14, speed: 0.18, phase: 2.8, spinRate: 0.07, atmo: [90, 130, 255] },
];
const TILT = 0.25; // перспектива: вид сверху под малым углом
const SIN_T = 0.25;

const texCache = new Map<BodyKind, Texture>();
async function ensureTextures(kinds: BodyKind[], isAlive: () => boolean): Promise<void> {
  for (const k of kinds) {
    if (!isAlive()) return;
    if (!texCache.has(k)) {
      texCache.set(k, genTexture(k, 256, 128));
      await new Promise((r) => setTimeout(r, 0)); // не подвешиваем окно на старте
    }
  }
}

interface Live {
  body: Body | { kind: 'sun' | 'moon'; name: string; spinRate: number; tilt?: number; atmo?: [number, number, number] };
  geom: SphereGeom;
  canvas: HTMLCanvasElement;
  img: ImageData;
  lastUpdate: number;
}
const mkLive = (body: Live['body'], r: number): Live => {
  const geom = makeSphereGeom(r, body.tilt ?? 0);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = geom.size;
  return { body, geom, canvas, img: new ImageData(geom.size, geom.size), lastUpdate: -1e9 };
};

function renderBackdrop(w: number, h: number): HTMLCanvasElement {
  const W = Math.round(w * 1.12), H = Math.round(h * 1.12);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = out.getContext('2d')!;
  g.fillStyle = '#010208';
  g.fillRect(0, 0, W, H);
  // Млечный Путь считаем в уменьшенном виде и растягиваем (сглаживание даёт мягкие облака)
  const sw = Math.min(520, Math.round(W / 3)), sh = Math.round((sw * H) / W);
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sg = small.getContext('2d')!;
  const img = sg.createImageData(sw, sh);
  const angle = -0.46;
  genMilkyWay({ w: sw, h: sh, angle }, img.data);
  sg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.globalCompositeOperation = 'lighter';
  g.drawImage(small, 0, 0, W, H);
  // звёзды
  const stars = genStars(Math.round((W * H) / 520), W, H, angle);
  for (const s of stars) {
    const a = 0.18 + 0.82 * Math.sqrt(s.mag);
    const r = 0.45 + s.mag * 1.5;
    g.fillStyle = `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${a})`;
    g.beginPath();
    g.arc(s.x, s.y, r, 0, Math.PI * 2);
    g.fill();
    if (s.mag > 0.5) {
      // мягкое свечение (гауссов спад) — как у настоящих ярких звёзд на снимках, без «лучей»
      const R = r * 6;
      const gl = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, R);
      const k = 0.5 * s.mag;
      gl.addColorStop(0, `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${k})`);
      gl.addColorStop(0.12, `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${k * 0.45})`);
      gl.addColorStop(0.35, `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${k * 0.12})`);
      gl.addColorStop(0.7, `rgba(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]},${k * 0.025})`);
      gl.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gl;
      g.fillRect(s.x - R, s.y - R, R * 2, R * 2);
    }
  }
  g.globalCompositeOperation = 'source-over';
  return out;
}

export function SpaceBackground({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let alive = true;
    let w = 1, h = 1, dpr = 1, raf = 0;
    let backdrop: HTMLCanvasElement | null = null;
    let lives: Live[] = [];
    let sun: Live | null = null;
    let moon: Live | null = null;
    let corona: HTMLCanvasElement | null = null;
    let mx = 0, my = 0, tx = 0, ty = 0;
    let ready = 0; // плавное появление планет после генерации текстур
    let resizeTimer = 0;
    const belt = Array.from({ length: 1100 }, (_, i) => ({ a: hash(i, 8) * 6.283, r: 0.36 + hash(i, 9) * 0.07 + (hash(i, 10) - 0.5) * 0.012, s: 0.6 + hash(i, 11) * 1.1, tone: 110 + hash(i, 12) * 90 }));

    const build = (): void => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      backdrop = renderBackdrop(w, h);
      const sc = Math.max(0.7, w / 1400);
      lives = BODIES.map((b) => mkLive(b, Math.max(4, Math.round(b.size * sc * 1.25))));
      sun = mkLive({ kind: 'sun', name: 'Солнце', spinRate: 0.01 }, Math.round(34 * sc));
      moon = mkLive({ kind: 'moon', name: 'Луна', spinRate: 0.01 }, Math.max(3, Math.round(5.5 * sc)));
      const cc = document.createElement('canvas');
      cc.width = cc.height = 384;
      const ci = new ImageData(384, 384);
      genCorona(384, ci.data);
      cc.getContext('2d')!.putImageData(ci, 0, 0);
      corona = cc;
    };
    build();
    void ensureTextures(['sun', 'earth', 'moon', 'jupiter', 'saturn', 'mars', 'venus', 'mercury', 'uranus', 'neptune'], () => alive);
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 200);
    });
    ro.observe(canvas);
    const onMove = (e: MouseEvent): void => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('mousemove', onMove);

    const refresh = (l: Live, now: number, light: [number, number, number], emissive = false): void => {
      const kind = l.body.kind as BodyKind;
      const tex = texCache.get(kind);
      if (!tex || now - l.lastUpdate < 110) return;
      l.lastUpdate = now;
      shadeSphere(l.geom, tex, { light, spin: reduce ? 0 : (now / 1000) * l.body.spinRate, atmosphere: l.body.atmo, emissive }, l.img.data);
      l.canvas.getContext('2d')!.putImageData(l.img, 0, 0);
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !backdrop) return;
      const t = reduce ? 0 : now / 1000;
      mx += (tx - mx) * 0.04;
      my += (ty - my) * 0.04;
      if (texCache.size >= 10 && ready < 1) ready = Math.min(1, ready + 0.02);
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(backdrop, (w - backdrop.width) / 2 - mx * 16, (h - backdrop.height) / 2 - my * 11);

      const sc = Math.max(0.7, w / 1400);
      const cx = w * 0.5 - mx * 8;
      const cy = h * 0.79 - my * 5;
      const R = w;
      type Item = { z: number; draw: () => void };
      const items: Item[] = [];

      // пояс астероидов: мелкие каменистые крупинки (светлее на стороне, обращённой к Солнцу)
      for (const b of belt) {
        const a = b.a + t * 0.004;
        const x = cx + Math.cos(a) * b.r * R, y = cy + Math.sin(a) * b.r * R * TILT;
        const lit = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(a + 1));
        items.push({ z: Math.sin(a), draw: () => { ctx.fillStyle = `rgba(${b.tone * lit},${b.tone * lit * 0.92},${b.tone * lit * 0.82},0.8)`; ctx.fillRect(x, y, b.s, b.s); } });
      }

      // планеты
      BODIES.forEach((b, i) => {
        const l = lives[i]!;
        const a = b.phase + t * 0.03 * b.speed;
        const X = Math.cos(a) * b.orbit * R, Z = Math.sin(a) * b.orbit * R;
        const x = cx + X, y = cy + Z * TILT;
        const persp = 0.8 + 0.34 * ((Math.sin(a) + 1) / 2);
        const d = Math.hypot(X, Z) || 1;
        // направление на Солнце (экранные оси); чуть «подсвечиваем» сторону к зрителю, как на иллюстрациях NASA
        const light: [number, number, number] = [-X / d, (-Z * SIN_T) / d, 0.55 - 0.35 * (Z / d)];
        items.push({
          z: Math.sin(a),
          draw: () => {
            if (!texCache.has(b.kind) || ready <= 0) return;
            refresh(l, now, light);
            const r = l.geom.r * persp;
            ctx.globalAlpha = ready;
            const lx = light[0], ly = light[1];
            if (b.ring) drawRing(ctx, x, y, r, b.tilt ?? 0, true);
            if (b.atmo) {
              ctx.globalCompositeOperation = 'lighter';
              const g = ctx.createRadialGradient(x + lx * r * 0.18, y + ly * r * 0.18, r * 0.85, x, y, r * 1.28);
              g.addColorStop(0, `rgba(${b.atmo[0]},${b.atmo[1]},${b.atmo[2]},0.34)`);
              g.addColorStop(1, `rgba(${b.atmo[0]},${b.atmo[1]},${b.atmo[2]},0)`);
              ctx.fillStyle = g;
              ctx.fillRect(x - r * 1.3, y - r * 1.3, r * 2.6, r * 2.6);
              ctx.globalCompositeOperation = 'source-over';
            }
            // Луна обходит Землю по той же плоской орбите: дальняя половина — ЗА Землёй (скрыта диском), ближняя — перед ней
            const drawMoon = (): void => {
              if (!b.moon || !moon) return;
              const mp = moonPlacement(t * 0.5, r, TILT, 3.1);
              refresh(moon, now, light);
              const mr = moon.geom.r * persp * mp.scale;
              ctx.drawImage(moon.canvas, x + mp.dx - mr - 1, y + mp.dy - mr - 1, (mr + 1) * 2, (mr + 1) * 2);
            };
            const moonBehind = b.moon ? moonPlacement(t * 0.5, r, TILT, 3.1).behind : false;
            if (moonBehind) drawMoon();
            ctx.drawImage(l.canvas, x - r - 2 * persp, y - r - 2 * persp, (r + 2 * persp) * 2, (r + 2 * persp) * 2);
            if (b.ring) drawRing(ctx, x, y, r, b.tilt ?? 0, false);
            if (!moonBehind) drawMoon();
            ctx.globalAlpha = 1;
          },
        });
      });

      // Солнце
      items.push({
        z: 0,
        draw: () => {
          const sr = (sun?.geom.r ?? 30) * 1.0;
          ctx.globalCompositeOperation = 'lighter';
          const halo = ctx.createRadialGradient(cx, cy, sr * 0.6, cx, cy, sr * 11);
          halo.addColorStop(0, 'rgba(255,200,120,0.55)');
          halo.addColorStop(0.12, 'rgba(255,150,60,0.22)');
          halo.addColorStop(0.45, 'rgba(255,110,40,0.06)');
          halo.addColorStop(1, 'rgba(255,100,30,0)');
          ctx.fillStyle = halo;
          ctx.fillRect(cx - sr * 11, cy - sr * 11, sr * 22, sr * 22);
          // корона: мягкая текстура (размытые языки пламени), медленно вращается и «дышит»
          if (corona) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(t * 0.004);
            const cs = sr * 9 * (1 + 0.015 * Math.sin(t * 0.5));
            ctx.globalAlpha = 0.9;
            ctx.drawImage(corona, -cs, -cs, cs * 2, cs * 2);
            ctx.rotate(-t * 0.009);
            ctx.globalAlpha = 0.45;
            ctx.drawImage(corona, -cs * 0.7, -cs * 0.7, cs * 1.4, cs * 1.4);
            ctx.restore();
            ctx.globalAlpha = 1;
          }
          ctx.globalCompositeOperation = 'source-over';
          if (sun && texCache.has('sun')) {
            refresh(sun, now, [0, 0, 1], true);
            ctx.drawImage(sun.canvas, cx - sr - 2, cy - sr - 2, (sr + 2) * 2, (sr + 2) * 2);
          } else {
            ctx.fillStyle = '#ffd36b';
            ctx.beginPath();
            ctx.arc(cx, cy, sr, 0, Math.PI * 2);
            ctx.fill();
          }
          // яркое ядро-ореол
          ctx.globalCompositeOperation = 'lighter';
          const core = ctx.createRadialGradient(cx, cy, sr * 0.8, cx, cy, sr * 1.6);
          core.addColorStop(0, 'rgba(255,240,200,0.35)');
          core.addColorStop(1, 'rgba(255,200,120,0)');
          ctx.fillStyle = core;
          ctx.fillRect(cx - sr * 1.6, cy - sr * 1.6, sr * 3.2, sr * 3.2);
          ctx.globalCompositeOperation = 'source-over';
        },
      });

      items.sort((a, b) => a.z - b.z);
      // «Солнце» (z=0) делит дальние и ближние объекты — порядок по z этого достаточно
      for (const it of items) it.draw();

      // виньетка: глубина кадра
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.4, w / 2, h / 2, Math.max(w, h) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,4,0.5)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return <canvas ref={ref} className="starfield" aria-hidden="true" style={{ opacity: intensity }} />;
}

/** Кольца Сатурна: тонкие полосы с щелью Кассини; задняя половина — за планетой, передняя — поверх. */
function drawRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, tilt: number, back: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.28 + tilt * 0.2);
  const A0 = back ? Math.PI : 0;
  const A1 = back ? Math.PI * 2 : Math.PI;
  const inner = 1.3, outer = 2.4;
  for (let k = 0; k < 90; k++) {
    const f = k / 89;
    const rr = (inner + (outer - inner) * f) * r;
    // полосы: яркое B-кольцо, щель Кассини около f≈0.6, тусклое C-кольцо у внутреннего края
    const base = f < 0.18 ? 0.18 : f < 0.58 ? 0.78 : f < 0.64 ? 0.05 : f < 0.9 ? 0.55 : 0.2;
    const a = base * (0.7 + 0.3 * hash(k, 41));
    ctx.strokeStyle = `rgba(${226 - f * 20},${206 - f * 22},${164 - f * 30},${a})`;
    ctx.lineWidth = ((outer - inner) / 90) * r * 1.2;
    ctx.beginPath();
    ctx.ellipse(0, 0, rr, rr * 0.3, 0, A0, A1);
    ctx.stroke();
  }
  ctx.restore();
}
