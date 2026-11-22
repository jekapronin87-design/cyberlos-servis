import { useEffect, useRef } from 'react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: OrbState;
  /** Возвращает текущую громкость 0..1 (микрофон или голос ассистента). */
  getLevel: () => number;
}

const PALETTE: Record<OrbState, [number, number, number]> = {
  idle: [76, 194, 255],
  listening: [90, 225, 255],
  thinking: [160, 140, 255],
  speaking: [120, 240, 255],
};

const N = 700;
const GOLD = Math.PI * (3 - Math.sqrt(5));
const POINTS = Array.from({ length: N }, (_, i) => {
  const y = 1 - (i / (N - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const t = GOLD * i;
  return { x: Math.cos(t) * r, y, z: Math.sin(t) * r, seed: (i * 37) % 100 };
});

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
      const ay = spin;
      const ax = 0.42 + Math.sin(time * 0.35) * 0.08;
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
        ctx.strokeStyle = rgba(0.11 + energy * 0.06);
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
        ctx.strokeStyle = rgba(0.1 + energy * 0.05);
        ctx.stroke();
      }

      // облако точек (с «дыханием» поверхности от громкости)
      for (const pt of POINTS) {
        const wob = 1 + Math.sin(time * (2 + energy * 3) + pt.seed) * (0.015 + level * 0.12) + level * 0.05;
        const p = project(pt.x * wob, pt.y * wob, pt.z * wob);
        const front = (p.d + 1) / 2; // 0 — сзади, 1 — спереди
        const a = 0.2 + front * front * 0.9;
        const size = 0.8 + front * 1.7 + level * 0.6;
        ctx.fillStyle = rgba(a);
        ctx.beginPath();
        ctx.arc(p.px, p.py, size, 0, Math.PI * 2);
        ctx.fill();
      }

      // ядро
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.45 + level * 0.25));
      core.addColorStop(0, `rgba(255,255,255,${0.55 + level * 0.4})`);
      core.addColorStop(0.25, rgba(0.45 + level * 0.3));
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
