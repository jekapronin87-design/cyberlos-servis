import { useEffect, useRef } from 'react';

/**
 * Космос: Млечный Путь и Солнечная система «издалека и сверху» в перспективе. Планеты ходят по орбитам, между Марсом и Юпитером — пояс астероидов.
 * Ассистент (шар) «парит» над системой. Чистый Canvas 2D; при скрытом окне и при «уменьшении движения» не нагружает компьютер.
 */
interface Planet {
  name: string;
  orbit: number; // доля ширины экрана
  size: number;
  color: string;
  speed: number;
  phase: number;
  ring?: boolean;
  moon?: boolean;
  bands?: boolean;
}
const PLANETS: Planet[] = [
  { name: 'Меркурий', orbit: 0.1, size: 3.2, color: '#b0a79a', speed: 1.6, phase: 0.6 },
  { name: 'Венера', orbit: 0.16, size: 6, color: '#e6c27d', speed: 1.17, phase: 2.2 },
  { name: 'Земля', orbit: 0.23, size: 6.5, color: '#3f7fe8', speed: 1, phase: 4.1, moon: true },
  { name: 'Марс', orbit: 0.3, size: 4.6, color: '#c4573a', speed: 0.8, phase: 1.1 },
  { name: 'Юпитер', orbit: 0.5, size: 17, color: '#d8b48b', speed: 0.43, phase: 3.0, bands: true },
  { name: 'Сатурн', orbit: 0.64, size: 14, color: '#e6d5a4', speed: 0.32, phase: 5.2, ring: true },
  { name: 'Уран', orbit: 0.77, size: 9, color: '#9fe3e8', speed: 0.23, phase: 0.2 },
  { name: 'Нептун', orbit: 0.9, size: 8.5, color: '#4f70e2', speed: 0.18, phase: 2.8 },
];
const TILT = 0.25; // сплющивание орбит: вид сверху под малым углом
const rnd = (i: number, k = 0): number => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function gaussian(i: number, k: number): number {
  let s = 0;
  for (let j = 0; j < 4; j++) s += rnd(i, k + j * 17);
  return (s - 2) / 0.58;
}

/** Млечный Путь рисуется один раз в отдельный холст (тысячи звёзд + свечение + пылевые полосы). */
function renderMilkyWay(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * 1.2);
  c.height = Math.round(h * 1.2);
  const g = c.getContext('2d')!;
  const W = c.width, H = c.height;
  g.translate(W / 2, H / 2);
  g.rotate(-0.5); // полоса идёт по диагонали
  const L = Math.hypot(W, H);
  // широкое свечение
  const glow = g.createLinearGradient(0, -H * 0.3, 0, H * 0.3);
  glow.addColorStop(0, 'rgba(70,90,200,0)');
  glow.addColorStop(0.35, 'rgba(110,120,220,0.16)');
  glow.addColorStop(0.5, 'rgba(210,190,255,0.26)');
  glow.addColorStop(0.65, 'rgba(110,120,220,0.16)');
  glow.addColorStop(1, 'rgba(70,90,200,0)');
  g.fillStyle = glow;
  g.fillRect(-L, -H * 0.3, L * 2, H * 0.6);
  // ядро галактики — тёплое
  const core = g.createRadialGradient(-L * 0.1, 0, 0, -L * 0.1, 0, H * 0.35);
  core.addColorStop(0, 'rgba(255,215,170,0.22)');
  core.addColorStop(1, 'rgba(255,215,170,0)');
  g.fillStyle = core;
  g.fillRect(-L, -H * 0.5, L * 2, H);
  // звёзды полосы
  for (let i = 0; i < 5200; i++) {
    const x = (rnd(i, 1) - 0.5) * L;
    const y = gaussian(i, 3) * H * 0.075;
    const bright = rnd(i, 5);
    const warm = rnd(i, 7) > 0.8;
    g.fillStyle = warm ? `rgba(255,225,190,${0.1 + bright * 0.5})` : `rgba(200,215,255,${0.1 + bright * 0.5})`;
    const sz = bright > 0.97 ? 1.6 : bright > 0.85 ? 1.1 : 0.7;
    g.fillRect(x, y, sz, sz);
  }
  // пылевые полосы (тёмные)
  g.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 26; i++) {
    const x = (rnd(i, 21) - 0.5) * L * 0.9;
    const y = (rnd(i, 22) - 0.5) * H * 0.07;
    const r = H * (0.03 + rnd(i, 23) * 0.06);
    const d = g.createRadialGradient(x, y, 0, x, y, r);
    d.addColorStop(0, 'rgba(2,3,10,0.55)');
    d.addColorStop(1, 'rgba(2,3,10,0)');
    g.fillStyle = d;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

export function SpaceBackground({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 1, h = 1, dpr = 1, raf = 0;
    let milky: HTMLCanvasElement | null = null;
    let mx = 0, my = 0, tx = 0, ty = 0;
    const stars = Array.from({ length: 260 }, (_, i) => ({ x: rnd(i, 1), y: rnd(i, 2), z: 0.2 + rnd(i, 3) * 0.8, tw: rnd(i, 4) * 6.28, hue: rnd(i, 5) > 0.85 ? 30 : rnd(i, 5) > 0.7 ? 215 : 200 }));
    const belt = Array.from({ length: 900 }, (_, i) => ({ a: rnd(i, 8) * 6.28, r: 0.36 + rnd(i, 9) * 0.07 + gaussian(i, 10) * 0.004, s: 0.5 + rnd(i, 11), j: gaussian(i, 12) * 0.006 }));

    const resize = (): void => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      milky = renderMilkyWay(w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const onMove = (e: MouseEvent): void => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('mousemove', onMove);

    let comet: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
    let nextComet = 8;

    const sphere = (x: number, y: number, r: number, color: string, lightAngle: number, glow = 0): void => {
      if (glow > 0) {
        const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * (1 + glow));
        g.addColorStop(0, color + '55');
        g.addColorStop(1, color + '00');
        ctx.fillStyle = g;
        ctx.fillRect(x - r * (1 + glow), y - r * (1 + glow), r * (2 + glow * 2), r * (2 + glow * 2));
      }
      const lx = x + Math.cos(lightAngle) * r * 0.45;
      const ly = y + Math.sin(lightAngle) * r * 0.45;
      const g = ctx.createRadialGradient(lx, ly, r * 0.1, x, y, r * 1.05);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.18, color);
      g.addColorStop(1, '#04060c');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const t = reduce ? 0 : now / 1000;
      mx += (tx - mx) * 0.04;
      my += (ty - my) * 0.04;
      ctx.clearRect(0, 0, w, h);
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#02030a');
      bg.addColorStop(0.7, '#050818');
      bg.addColorStop(1, '#0a0c22');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Млечный Путь (медленный параллакс)
      if (milky) {
        ctx.globalAlpha = 0.95;
        ctx.drawImage(milky, (w - milky.width) / 2 - mx * 14, (h - milky.height) / 2 - my * 10, milky.width, milky.height);
        ctx.globalAlpha = 1;
      }
      // звёзды
      for (const s of stars) {
        const a = (0.2 + 0.6 * s.z) * (0.7 + 0.3 * Math.sin(t * 1.3 + s.tw));
        ctx.fillStyle = `hsla(${s.hue},70%,88%,${a})`;
        const x = ((s.x * w - mx * 22 * s.z) % w + w) % w;
        const y = ((s.y * h - my * 16 * s.z) % h + h) % h;
        ctx.beginPath();
        ctx.arc(x, y, 0.35 + s.z * 1.0, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- Солнечная система
      const cx = w * 0.5 - mx * 10;
      const cy = h * 0.79 - my * 6;
      const R = w; // орбиты в долях ширины экрана
      const sc = Math.max(0.6, w / 1400);
      const sunAngle = (x: number, y: number): number => Math.atan2(cy - y, cx - x);
      const behind: (() => void)[] = [];
      const front: (() => void)[] = [];
      // орбиты
      ctx.lineWidth = 1;
      for (const p of PLANETS) {
        ctx.strokeStyle = 'rgba(120,170,255,0.13)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.orbit * R, p.orbit * R * TILT, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(150,200,255,0.12)';
        ctx.beginPath();
        ctx.ellipse(cx, cy, p.orbit * R, p.orbit * R * TILT, 0, 0, Math.PI);
        ctx.stroke();
      }
      // пояс астероидов
      ctx.fillStyle = 'rgba(190,175,160,0.55)';
      for (const b of belt) {
        const a = b.a + t * 0.012 / (b.r * b.r * 4) * 0.3;
        const x = cx + Math.cos(a) * (b.r + b.j) * R;
        const y = cy + Math.sin(a) * (b.r + b.j) * R * TILT;
        const draw = (): void => ctx.fillRect(x, y, b.s * (0.8 + Math.sin(a) * 0.4), b.s * (0.8 + Math.sin(a) * 0.4));
        (Math.sin(a) < 0 ? behind : front).push(draw);
      }
      // планеты
      for (const p of PLANETS) {
        const a = p.phase + t * 0.045 * p.speed;
        const x = cx + Math.cos(a) * p.orbit * R;
        const y = cy + Math.sin(a) * p.orbit * R * TILT;
        const persp = 0.78 + 0.34 * ((Math.sin(a) + 1) / 2); // ближние к зрителю — крупнее
        const r = p.size * sc * persp * 1.35;
        const draw = (): void => {
          const la = sunAngle(x, y);
          if (p.ring) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.25);
            ctx.strokeStyle = 'rgba(230,210,160,0.55)';
            ctx.lineWidth = Math.max(1, r * 0.22);
            ctx.beginPath();
            ctx.ellipse(0, 0, r * 2.0, r * 0.62, 0, Math.PI, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          sphere(x, y, r, p.color, la, p.name === 'Земля' ? 0.8 : 0.3);
          if (p.bands) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.clip();
            ctx.fillStyle = 'rgba(120,80,50,0.28)';
            for (const k of [-0.45, -0.1, 0.3]) ctx.fillRect(x - r, y + k * r, r * 2, r * 0.18);
            ctx.restore();
          }
          if (p.ring) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.25);
            ctx.strokeStyle = 'rgba(235,215,165,0.75)';
            ctx.lineWidth = Math.max(1, r * 0.22);
            ctx.beginPath();
            ctx.ellipse(0, 0, r * 2.0, r * 0.62, 0, 0, Math.PI);
            ctx.stroke();
            ctx.restore();
          }
          if (p.moon) {
            const ma = t * 1.6;
            sphere(x + Math.cos(ma) * r * 2.1, y + Math.sin(ma) * r * 0.8, r * 0.28, '#cfd3da', la);
          }
        };
        (Math.sin(a) < 0 ? behind : front).push(draw);
      }
      behind.forEach((f) => f());
      // Солнце: свечение, лучи, ядро
      ctx.globalCompositeOperation = 'lighter';
      const sunR = 30 * sc;
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR * 9);
      halo.addColorStop(0, 'rgba(255,214,130,0.55)');
      halo.addColorStop(0.15, 'rgba(255,170,70,0.22)');
      halo.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(cx - sunR * 9, cy - sunR * 9, sunR * 18, sunR * 18);
      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < 14; i++) {
        ctx.rotate((Math.PI * 2) / 14 + Math.sin(t * 0.1) * 0.0005);
        const len = sunR * (3 + rnd(i, 31) * 3 + Math.sin(t * 0.8 + i) * 0.4);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, 'rgba(255,220,150,0.25)');
        g.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, -1.2, len, 2.4);
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, sunR);
      sun.addColorStop(0, '#fffbe6');
      sun.addColorStop(0.5, '#ffd36b');
      sun.addColorStop(1, '#ff9a2e');
      ctx.fillStyle = sun;
      ctx.beginPath();
      ctx.arc(cx, cy, sunR, 0, Math.PI * 2);
      ctx.fill();
      front.forEach((f) => f());

      // комета
      if (!reduce) {
        if (!comet && t > nextComet) {
          comet = { x: w * (0.1 + Math.random() * 0.5), y: h * Math.random() * 0.3, vx: 520 + Math.random() * 200, vy: 180 + Math.random() * 120, life: 1.4 };
          nextComet = t + 14 + Math.random() * 18;
        }
        if (comet) {
          const dt = 1 / 60;
          comet.x += comet.vx * dt;
          comet.y += comet.vy * dt;
          comet.life -= dt;
          const g = ctx.createLinearGradient(comet.x, comet.y, comet.x - comet.vx * 0.22, comet.y - comet.vy * 0.22);
          g.addColorStop(0, `rgba(220,240,255,${Math.max(0, comet.life)})`);
          g.addColorStop(1, 'rgba(220,240,255,0)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(comet.x, comet.y);
          ctx.lineTo(comet.x - comet.vx * 0.22, comet.y - comet.vy * 0.22);
          ctx.stroke();
          if (comet.life <= 0) comet = null;
        }
      }

      // виньетка
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,6,0.55)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
    };
  }, []);

  return <canvas ref={ref} className="starfield" aria-hidden="true" style={{ opacity: intensity }} />;
}
