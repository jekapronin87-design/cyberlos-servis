import { useEffect, useRef } from 'react';

/** Космический фон: звёзды с параллаксом и мягкие туманности. Лёгкий Canvas 2D, останавливается, когда окно скрыто. */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    const stars = Array.from({ length: 170 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      z: 0.2 + Math.random() * 0.8,
      tw: Math.random() * Math.PI * 2,
      hue: i % 9 === 0 ? 200 : i % 13 === 0 ? 280 : 190,
    }));
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
    let last = performance.now();
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);
      // туманности
      const t = now / 1000;
      const neb = (x: number, y: number, r: number, c: string): void => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, c);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      };
      neb(w * (0.2 + Math.sin(t * 0.03) * 0.03), h * 0.25, Math.max(w, h) * 0.5, 'rgba(70,40,160,0.10)');
      neb(w * 0.85, h * (0.8 + Math.cos(t * 0.04) * 0.03), Math.max(w, h) * 0.55, 'rgba(20,120,200,0.10)');
      for (const s of stars) {
        if (!reduce) {
          s.y += dt * 0.004 * s.z;
          if (s.y > 1) s.y = 0;
        }
        const a = (0.25 + 0.55 * s.z) * (0.75 + 0.25 * Math.sin(t * 1.2 + s.tw));
        ctx.fillStyle = `hsla(${s.hue},80%,85%,${a})`;
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, 0.4 + s.z * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return <canvas ref={ref} className="starfield" aria-hidden="true" />;
}
