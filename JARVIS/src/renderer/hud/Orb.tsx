import { useEffect, useRef } from 'react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: OrbState;
  /** Возвращает текущую громкость 0..1 (микрофон или голос Системно). */
  getLevel: () => number;
}

const PALETTE: Record<OrbState, [number, number, number]> = {
  idle: [76, 194, 255],
  listening: [90, 225, 255],
  thinking: [160, 140, 255],
  speaking: [120, 240, 255],
};

const N = 3400;
const GOLD = Math.PI * (3 - Math.sqrt(5));
const rnd = (i: number, k = 0): number => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const POINTS = Array.from({ length: N }, (_, i) => {
  const y = 1 - (i / (N - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const t = GOLD * i;
  return { x: Math.cos(t) * r, y, z: Math.sin(t) * r, seed: (i * 37) % 100 };
});

// ---------- «лицо» из точек ----------
// Координаты головы: x вправо, y вниз (лоб — минус, подбородок — плюс), z к зрителю. Линии не рисуются: облик создают плотность,
// яркость и рельеф облака точек (освещение по нормали), как у голографического скана.
const smooth = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, y: number, cx: number, cy: number, sx: number, sy: number, amp: number): number => amp * Math.exp(-(((x - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);
const HA = 0.74, HB = 1.05, HC = 0.86;
const halfW = (y: number): number => HA * (1 - 0.3 * smooth(0.1, 1, y / HB));
/** Рельеф лица: нос, глазницы, брови, скулы, губы, подбородок. */
function relief(x: number, y: number): number {
  const ax = Math.abs(x);
  return (
    gauss(ax, y, 0, 0.12, 0.075, 0.28, 0.28) + // спинка носа
    gauss(ax, y, 0, 0.28, 0.14, 0.06, 0.11) + // кончик и крылья
    -gauss(ax, y, 0.3, -0.2, 0.14, 0.075, 0.2) + // глазницы
    gauss(ax, y, 0.3, -0.37, 0.2, 0.05, 0.11) + // брови
    gauss(ax, y, 0.46, 0.14, 0.15, 0.15, 0.07) + // скулы
    gauss(ax, y, 0, 0.47, 0.2, 0.04, 0.11) + // верхняя губа
    gauss(ax, y, 0, 0.59, 0.18, 0.045, 0.1) + // нижняя губа
    -gauss(ax, y, 0, 0.53, 0.22, 0.012, 0.05) + // линия рта
    gauss(ax, y, 0, 0.86, 0.14, 0.09, 0.07) + // подбородок
    gauss(ax, y, 0, -0.62, 0.35, 0.18, 0.03) // лоб
  );
}
function faceZ(x: number, y: number): number {
  const k = 1 - (x / halfW(y)) ** 2 - (y / HB) ** 2;
  if (k <= 0) return 0;
  const root = Math.sqrt(k);
  return HC * root + relief(x, y) * smooth(0, 0.35, root);
}
const LIGHT = (() => {
  const l = [-0.45, -0.55, 0.7];
  const n = Math.hypot(l[0]!, l[1]!, l[2]!);
  return l.map((v) => v / n) as [number, number, number];
})();
function shade(x: number, y: number): number {
  const e = 0.012;
  const dzx = (faceZ(x + e, y) - faceZ(x - e, y)) / (2 * e);
  const dzy = (faceZ(x, y + e) - faceZ(x, y - e)) / (2 * e);
  const nl = Math.hypot(dzx, dzy, 1);
  const d = (-dzx * LIGHT[0] - dzy * LIGHT[1] + LIGHT[2]) / nl;
  return 0.08 + 0.92 * Math.pow(Math.max(0, d), 1.25);
}

interface Pt {
  /** позиция на сфере */
  sx: number; sy: number; sz: number;
  /** цель в форме головы */
  hx: number; hy: number; hz: number;
  /** яркость от освещения/признак «особая» точка (глаз, рот…) */
  lit: number;
  feat: number; // 0 — кожа, 1 — глаза/брови/нос, 2 — рот
  delay: number;
  seed: number;
}
const CLOUD: Pt[] = [];
for (let i = 0; i < N; i++) {
  const p = POINTS[i]!;
  // сфера → эллипсоид головы
  let hx = p.x * HA * (1 - 0.3 * smooth(0.1, 1, p.y));
  let hy = p.y * HB;
  let hz = p.z * HC;
  let lit = 0.3;
  if (p.z > 0) {
    hz = faceZ(hx, hy);
    lit = shade(hx, hy);
  }
  CLOUD.push({ sx: p.x, sy: p.y, sz: p.z, hx, hy, hz, lit, feat: 0, delay: rnd(i, 1) * 0.5, seed: p.seed });
}
/** Дополнительные точки на чертах лица (глаза, брови, нос, губы) — плотные «созвездия», а не линии. */
function addBlob(count: number, feat: 1 | 2, gen: (k: number) => [number, number]): void {
  for (let k = 0; k < count; k++) {
    const [x, y] = gen(k);
    const i = CLOUD.length;
    const t = rnd(i, 5) * Math.PI * 2;
    const u = rnd(i, 6) * 2 - 1;
    const r = Math.sqrt(1 - u * u);
    CLOUD.push({ sx: Math.cos(t) * r, sy: u, sz: Math.abs(Math.sin(t) * r), hx: x, hy: y, hz: faceZ(x, y) + 0.03, lit: 1, feat, delay: rnd(i, 7) * 0.5, seed: (i * 13) % 100 });
  }
}
const J = (i: number, k: number, a: number): number => (rnd(i, k) - 0.5) * a;
for (const sgn of [-1, 1]) {
  addBlob(60, 1, (k) => { const a = rnd(k, 11 + sgn) * Math.PI * 2; const rr = Math.sqrt(rnd(k, 12 + sgn)); return [sgn * 0.3 + Math.cos(a) * 0.13 * rr, -0.2 + Math.sin(a) * 0.045 * rr]; }); // глаз
  addBlob(10, 1, (k) => [sgn * 0.3 + J(k, 13 + sgn, 0.03), -0.2 + J(k, 14, 0.03)]); // зрачок
  addBlob(30, 1, (k) => { const f = k / 33; return [sgn * (0.12 + f * 0.34) + J(k, 21, 0.03), -0.36 - Math.sin(f * Math.PI) * 0.05 + J(k, 15, 0.035)]; }); // бровь
  addBlob(7, 1, (k) => [sgn * 0.075 + J(k, 16, 0.02), 0.31 + J(k, 17, 0.02)]); // ноздря
}
addBlob(12, 1, (k) => [J(k, 18, 0.07), -0.1 + (k / 11) * 0.38 + J(k, 24, 0.05)]); // спинка носа
addBlob(55, 2, (k) => { const f = k / 69; return [-0.26 + f * 0.52 + J(k, 22, 0.02), 0.47 - Math.sin(f * Math.PI) * 0.025 + J(k, 19, 0.03)]; }); // верхняя губа
addBlob(50, 2, (k) => { const f = k / 59; return [-0.24 + f * 0.48 + J(k, 23, 0.02), 0.52 + Math.sin(f * Math.PI) * 0.055 + J(k, 20, 0.035)]; }); // нижняя губа
const MOUTH_START = CLOUD.length - 50; // индексы нижней губы — смещаются, когда рот «открывается»

/**
 * Голографический шар: облако точек на сфере, меридианы и параллели, вращающиеся кольца и светящееся ядро.
 * Реагирует на состояние (покой / слушает / думает / говорит) и на громкость. Чистый Canvas 2D — без WebGL.
 */
export function Orb({ state, getLevel }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(getLevel);
  levelRef.current = getLevel;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0;
    let h = 0;
    let t0 = performance.now();
    let spin = 0;
    let level = 0;
    let color: [number, number, number] = [...PALETTE.idle];
    let energy = 0.2;
    let morph = 0; // 0 — шар, 1 — голова (когда говорит)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const rgba = (a: number, c = color): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - t0) / 1000);
      t0 = now;
      const time = now / 1000;
      const st = stateRef.current;

      // сглаживаем цвет, энергию и громкость
      const target = PALETTE[st];
      color = color.map((c, i) => c + (target[i]! - c) * 0.06) as [number, number, number];
      const rawLevel = Math.max(0, Math.min(1, levelRef.current()));
      level += (rawLevel - level) * 0.3;
      const wantEnergy = st === 'thinking' ? 1 : st === 'speaking' ? 0.8 : st === 'listening' ? 0.55 : 0.2;
      energy += (wantEnergy - energy) * 0.04;
      spin += dt * (reduce ? 0.05 : 0.18 + energy * 0.9);
      morph += ((st === 'speaking' ? 1 : 0) - morph) * (reduce ? 1 : 0.045);

      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const base = Math.min(w, h) * 0.3;
      const breathe = 1 + Math.sin(time * 1.4) * 0.018;
      const R = base * breathe * (1 + level * 0.16);
      ctx.globalCompositeOperation = 'lighter';

      // ---- фоновое свечение
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * (2.1 + level * 0.5));
      glow.addColorStop(0, rgba(0.28 + level * 0.35));
      glow.addColorStop(0.45, rgba(0.07 + energy * 0.05));
      glow.addColorStop(1, rgba(0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);

      // ---- кольца HUD (позади и вокруг)
      const ring = (radius: number, width: number, dash: number[], speed: number, alpha: number): void => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(spin * speed);
        ctx.setLineDash(dash);
        ctx.lineWidth = width;
        ctx.strokeStyle = rgba(alpha);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      };
      ring(R * 1.55, 1, [2, 7], 0.9, 0.35 + energy * 0.2);
      ring(R * 1.7, 1.5, [60, 18, 8, 18], -0.55, 0.28 + energy * 0.25);
      ring(R * 1.9, 1, [1, 5], 0.3, 0.2);
      // дуги-«сегменты»
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-spin * 0.7);
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        ctx.strokeStyle = rgba(0.55 + level * 0.4);
        ctx.beginPath();
        ctx.arc(0, 0, R * 1.62, a, a + 0.5 + energy * 0.3);
        ctx.stroke();
      }
      ctx.restore();

      // ---- 3D: вращение и проекция
      const ay = spin * (1 - morph) + Math.sin(time * 0.7) * 0.28 * morph;
      const ax = (0.42 + Math.sin(time * 0.35) * 0.08) * (1 - morph) + Math.sin(time * 0.5) * 0.05 * morph;
      const cyA = Math.cos(ay), syA = Math.sin(ay), cxA = Math.cos(ax), sxA = Math.sin(ax);
      const project = (x: number, y: number, z: number, rad = 1): { px: number; py: number; d: number } => {
        const x1 = x * cyA + z * syA;
        const z1 = -x * syA + z * cyA;
        const y2 = y * cxA - z1 * sxA;
        const z2 = y * sxA + z1 * cxA;
        const persp = 1 / (1 - z2 * 0.28);
        return { px: cx + x1 * R * rad * persp, py: cy + y2 * R * rad * persp, d: z2 };
      };

      // сетка: меридианы и параллели
      ctx.lineWidth = 1;
      const seg = 40;
      for (let m = 0; m < 10; m++) {
        const lon = (m / 10) * Math.PI;
        ctx.beginPath();
        for (let i = 0; i <= seg; i++) {
          const lat = (i / seg) * Math.PI * 2;
          const x = Math.cos(lat) * Math.cos(lon);
          const z = Math.cos(lat) * Math.sin(lon);
          const y = Math.sin(lat);
          const p = project(x, y, z);
          i === 0 ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py);
        }
        ctx.strokeStyle = rgba((0.11 + energy * 0.06) * (1 - morph));
        ctx.stroke();
      }
      for (let k = -3; k <= 3; k++) {
        const y = k / 4;
        const rr = Math.sqrt(1 - y * y);
        ctx.beginPath();
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          const p = project(Math.cos(a) * rr, y, Math.sin(a) * rr);
          i === 0 ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py);
        }
        ctx.strokeStyle = rgba((0.1 + energy * 0.05) * (1 - morph));
        ctx.stroke();
      }

      // облако точек: шар → (пульсируя) лицо. Каждая точка «перелетает» со своей задержкой, поэтому лицо проступает роем.
      const open = level * 0.13; // рот открывается от громкости голоса
      const scanY = Math.sin(time * 0.9) * 0.95; // голографическая «линия сканирования» скользит по лицу
      const faceAlpha = smooth(0.15, 0.7, morph);
      for (let i = 0; i < CLOUD.length; i++) {
        const pt = CLOUD[i]!;
        const m = smooth(pt.delay, pt.delay + 0.5, morph);
        if (pt.feat > 0 && m < 0.02) continue;
        let hy = pt.hy;
        if (pt.feat === 2 && i >= MOUTH_START) hy += open; // нижняя губа
        else if (pt.feat === 0 && pt.hy > 0.55 && Math.abs(pt.hx) < 0.35 && pt.hz > 0.3) hy += open * smooth(0.55, 0.95, pt.hy) * 0.9; // подбородок следует за губой
        const blink = pt.feat === 1 && pt.hy > -0.25 && pt.hy < -0.12 && Math.sin(time * 0.9) > 0.996 ? 0.3 : 1;
        const eyeY = blink < 1 ? -0.2 + (hy + 0.2) * 0.2 : hy;
        const pulse = 1 + Math.sin(time * (2 + energy * 3) + pt.seed) * (0.012 + level * 0.1 * (1 - m * 0.8)) + level * 0.04 * (1 - m);
        // волна голоса по лицу
        const wave = m > 0.5 ? Math.sin(hy * 9 - time * 10) * level * 0.045 : 0;
        const x = (pt.sx + (pt.hx - pt.sx) * m) * pulse;
        const y = (pt.sy + ((blink < 1 ? eyeY : hy) - pt.sy) * m) * pulse;
        const z = (pt.sz + (pt.hz - pt.sz) * m) * pulse + wave;
        const p = project(x, y, z);
        const front = (p.d + 1) / 2;
        let a = 0.12 + front * front * 0.85;
        let size = 0.45 + front * 1.15 + level * 0.45;
        if (m > 0.02) {
          // освещение рельефа: светлые и тёмные участки лепят лицо
          const light = pt.lit * (0.55 + 0.45 * (1 - (1 - m)));
          const scan = Math.exp(-(((hy - scanY) / 0.09) ** 2)) * 0.6 * m;
          a = (a * (1 - m) + (0.1 + light * 0.9) * (0.25 + 0.75 * Math.max(0.3, front)) * m) + scan;
          if (pt.feat > 0) {
            a = Math.min(1, a + 0.18 * m * faceAlpha);
            size += 0.2 * m;
          }
        }
        if (pt.feat > 0) a *= faceAlpha;
        if (a < 0.02) continue;
        ctx.fillStyle = rgba(Math.min(1, a));
        ctx.beginPath();
        ctx.arc(p.px, p.py, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // ядро
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.45 + level * 0.25));
      core.addColorStop(0, `rgba(255,255,255,${(0.55 + level * 0.4) * (1 - morph)})`);
      core.addColorStop(0.25, rgba((0.45 + level * 0.3) * (1 - morph * 0.85)));
      core.addColorStop(1, rgba(0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.5 + level * 0.25), 0, Math.PI * 2);
      ctx.fill();

      // волны при речи/прослушивании
      if (st === 'speaking' || st === 'listening') {
        for (let i = 0; i < 3; i++) {
          const ph = (time * 0.7 + i / 3) % 1;
          ctx.strokeStyle = rgba((1 - ph) * (0.25 + level * 0.4));
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(cx, cy, R * (1.05 + ph * 0.9), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="orb-canvas" data-state={state} aria-label="Ассистент" role="img" />;
}
