import { useEffect, useRef, useState } from 'react';
import type { CrmDashboardDto } from '../../shared/types';

interface Building {
  x: number;
  y: number;
  h: number;
  label: string;
  open: number;
  breaches: number;
  district: string;
}

/**
 * «Город бизнеса»: воронки — районы, стадии — здания. Высота здания — число сделок на стадии, красное свечение — нарушенные сроки (SLA).
 * Изометрия на Canvas 2D. Наведите курсор на здание — подсказка.
 */
export function CityCanvas({ data, onPick }: { data: CrmDashboardDto; onPick?: (pick: { pipeline: string; stage: string }) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const hit = useRef<{ poly: [number, number][]; b: Building }[]>([]);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    let raf = 0;
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

    const pipes = data.overview.pipelines.slice(0, 6);
    const buildings: Building[] = [];
    const maxOpen = Math.max(1, ...pipes.flatMap((p) => p.byStage.map((s) => s.open)));
    pipes.forEach((p, r) => {
      p.byStage.slice(0, 10).forEach((s, i) => {
        buildings.push({ x: i * 1.5, y: r * 2.7, h: 0.4 + (s.open / maxOpen) * 3.2, label: s.name, open: s.open, breaches: s.breaches, district: p.name });
      });
    });
    const cols = Math.max(1, ...pipes.map((p) => Math.min(10, p.byStage.length)));
    const worldW = cols * 1.5;
    const worldD = Math.max(1, pipes.length) * 2.7;

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const t = now / 1000;
      ctx.clearRect(0, 0, w, h);
      // масштаб и положение: весь город (с подписями районов и самым высоким зданием) вписывается в окно
      const u = (x: number, y: number, z: number): [number, number] => [(x - y) * 0.5, (x + y) * 0.25 - z * 0.45];
      const corners = [u(-3.2, -1, 0), u(worldW + 0.8, -1, 0), u(-3.2, worldD, 0), u(worldW + 0.8, worldD, 0), u(0, 0, 4), u(worldW, worldD, 4), u(worldW, 0, 4), u(0, worldD, 4)];
      const minX = Math.min(...corners.map((c) => c[0])), maxX = Math.max(...corners.map((c) => c[0]));
      const minY = Math.min(...corners.map((c) => c[1])), maxY = Math.max(...corners.map((c) => c[1]));
      const tw = Math.min((w * 0.94) / (maxX - minX), (h * 0.92) / (maxY - minY), 150);
      const th = tw / 2;
      const ox = w / 2 - ((minX + maxX) / 2) * tw;
      const oy = h / 2 - ((minY + maxY) / 2) * tw;
      const iso = (x: number, y: number, z = 0): [number, number] => [ox + (x - y) * (tw / 2), oy + (x + y) * (th / 2) - z * th * 0.9];
      ctx.globalCompositeOperation = 'lighter';

      // сетка земли
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(70,190,255,0.10)';
      for (let gx = -1; gx <= worldW + 0.5; gx += 0.75) {
        const a = iso(gx, -1), b = iso(gx, worldD);
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      }
      for (let gy = -1; gy <= worldD; gy += 0.75) {
        const a = iso(-1, gy), b = iso(worldW + 0.5, gy);
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      }
      // дороги и «трафик»
      pipes.forEach((_, r) => {
        const y = r * 2.7 + 1.35;
        const a = iso(-1, y), b = iso(worldW + 0.5, y);
        ctx.strokeStyle = 'rgba(120,220,255,0.28)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
        for (let k = 0; k < 4; k++) {
          const f = reduce ? k / 4 : (t * 0.08 + k / 4 + r * 0.13) % 1;
          const p = iso(-1 + f * (worldW + 1.5), y);
          ctx.fillStyle = 'rgba(220,250,255,0.9)';
          ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2); ctx.fill();
        }
      });

      // здания — от дальних к ближним
      hit.current = [];
      const sorted = [...buildings].sort((a, b) => a.x + a.y - (b.x + b.y));
      for (const b of sorted) {
        const size = 1;
        const hot = b.breaches > 0;
        const pulse = hot && !reduce ? 0.65 + 0.35 * Math.sin(t * 3 + b.x) : 1;
        const base: [number, number, number] = hot ? [255, 120, 90] : [80, 200, 255];
        const c = (a: number): string => `rgba(${base[0]},${base[1]},${base[2]},${a})`;
        const p0 = iso(b.x, b.y, 0), p1 = iso(b.x + size, b.y, 0), p2 = iso(b.x + size, b.y + size, 0), p3 = iso(b.x, b.y + size, 0);
        const q0 = iso(b.x, b.y, b.h), q1 = iso(b.x + size, b.y, b.h), q2 = iso(b.x + size, b.y + size, b.h), q3 = iso(b.x, b.y + size, b.h);
        const poly = (pts: [number, number][], fill: string, stroke: string): void => {
          ctx.beginPath();
          pts.forEach((p, i) => (i === 0 ? ctx.moveTo(...p) : ctx.lineTo(...p)));
          ctx.closePath();
          ctx.fillStyle = fill; ctx.fill();
          ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke();
        };
        poly([p3, p2, q2, q3], c(0.10 * pulse), c(0.55)); // левая грань (передняя-левая)
        poly([p2, p1, q1, q2], c(0.18 * pulse), c(0.65)); // правая грань
        poly([q0, q1, q2, q3], c(0.30 * pulse), c(0.95)); // крыша
        // «окна»
        const rows = Math.max(1, Math.floor(b.h * 2));
        for (let k = 1; k < rows; k++) {
          const z = (k / rows) * b.h;
          const a = iso(b.x + size, b.y, z), bb = iso(b.x + size, b.y + size, z);
          ctx.strokeStyle = c(0.18); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...bb); ctx.stroke();
        }
        // луч-маяк над проблемным зданием
        if (hot) {
          const top = iso(b.x + size / 2, b.y + size / 2, b.h);
          const g = ctx.createLinearGradient(top[0], top[1], top[0], top[1] - 60);
          g.addColorStop(0, 'rgba(255,120,90,0.55)'); g.addColorStop(1, 'rgba(255,120,90,0)');
          ctx.fillStyle = g; ctx.fillRect(top[0] - 2, top[1] - 60, 4, 60);
        }
        hit.current.push({ poly: [q0, q1, p1, p2, p3, q3], b });
      }

      // названия районов
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = '600 12px Bahnschrift, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(190,235,255,0.85)';
      pipes.forEach((p, r) => {
        const a = iso(-1.2, r * 2.7 + 0.5);
        ctx.textAlign = 'right';
        ctx.fillText(p.name.toUpperCase(), a[0] - 8, a[1]);
      });
    };
    raf = requestAnimationFrame(frame);

    const inPoly = (pt: [number, number], poly: [number, number][]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
        if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const move = (e: MouseEvent): void => {
      const r = canvas.getBoundingClientRect();
      mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      const m = mouse.current;
      const f = [...hit.current].reverse().find((hb) => inPoly([m.x, m.y], hb.poly));
      canvas.style.cursor = f && onPickRef.current ? 'pointer' : 'default';
      setTip(f ? { x: m.x, y: m.y, text: `${f.b.district} · ${f.b.label}: ${f.b.open} в работе${f.b.breaches ? `, без движения/просрочено: ${f.b.breaches}` : ''}${onPickRef.current ? ' — нажмите, чтобы открыть список' : ''}` } : null);
    };
    const leave = (): void => setTip(null);
    const click = (e: MouseEvent): void => {
      const r = canvas.getBoundingClientRect();
      const pt: [number, number] = [e.clientX - r.left, e.clientY - r.top];
      const f = [...hit.current].reverse().find((hb) => inPoly(pt, hb.poly));
      if (f) onPickRef.current?.({ pipeline: f.b.district, stage: f.b.label });
    };
    canvas.addEventListener('click', click);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('click', click);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseleave', leave);
    };
  }, [data]);

  return (
    <div className="city-wrap">
      <canvas ref={ref} className="city-canvas" role="img" aria-label="Город бизнеса: районы — воронки, здания — стадии" />
      {tip && <div className="city-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.text}</div>}
    </div>
  );
}
