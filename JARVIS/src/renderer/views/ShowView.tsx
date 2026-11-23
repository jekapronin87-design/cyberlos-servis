import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DeckDto, SlideDto, Tone } from '../../shared/deck';
import { uiSounds } from '../audio/uiSounds';

export type ShowCommand = { kind: 'next' | 'prev' | 'pause' | 'play' | 'first'; nonce: number };

const COLOR: Record<Tone, string> = { good: '#5be39b', bad: '#ff7a6a', warn: '#ffd166', neutral: '#5cc8ff' };
const PALETTE = ['#5cc8ff', '#7ea8ff', '#a98bff', '#5be39b', '#ffd166', '#ff9a80', '#ff7ac8'];
const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = (n: number): string => Math.round(n).toLocaleString('ru-RU');
const idx = (i: number): CSSProperties => ({ ['--i' as string]: i });

/** Число «набегает» от нуля — плавно и красиво. */
function Count({ value, unit }: { value: number; unit?: string }) {
  const [v, setV] = useState(reduced() ? value : 0);
  useEffect(() => {
    if (reduced()) return setV(value);
    const t0 = performance.now();
    let raf = 0;
    const f = (t: number): void => {
      const p = Math.min(1, (t - t0) / 1100);
      setV(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <>
      {fmt(v)}
      {unit && <small>{unit}</small>}
    </>
  );
}

/** Рамка «ноутбука»: слайд выглядит как макет на экране устройства, с бликом и мягким свечением. */
function Mock({ children, tag }: { children: React.ReactNode; tag: string }) {
  return (
    <div className="show-mock">
      <div className="show-mock-bar">
        <i /><i /><i />
        <span>{tag}</span>
      </div>
      <div className="show-mock-screen">{children}</div>
      <div className="show-mock-shine" aria-hidden="true" />
    </div>
  );
}

function Head({ s }: { s: { title: string; subtitle?: string } }) {
  return (
    <div className="sh-head">
      <h2>{s.title}</h2>
      {s.subtitle && <p>{s.subtitle}</p>}
    </div>
  );
}

/** Спидометр: полукруглая шкала, светящаяся дуга и стрелка, которые плавно «доезжают» до значения. */
function Gauge({ g, i }: { g: { label: string; value: number; max: number; unit?: string; note?: string; tone?: Tone }; i: number }) {
  const frac = Math.max(0, Math.min(1, g.value / Math.max(1, g.max)));
  const [on, setOn] = useState(reduced());
  useEffect(() => {
    const t = window.setTimeout(() => setOn(true), 250 + i * 160);
    return () => window.clearTimeout(t);
  }, []);
  const c = COLOR[g.tone ?? 'neutral'];
  const angle = -90 + (on ? frac : 0) * 180;
  const ticks = Array.from({ length: 11 }, (_, k) => -90 + k * 18);
  return (
    <div className="sh-gauge" style={{ ...idx(i), ['--c' as string]: c }}>
      <svg viewBox="0 0 200 120" aria-hidden="true">
        <path d="M20 100 A80 80 0 0 1 180 100" pathLength="100" className="sh-g-track" />
        <path d="M20 100 A80 80 0 0 1 180 100" pathLength="100" className="sh-g-arc" style={{ strokeDasharray: `${on ? frac * 100 : 0} 100` }} />
        {ticks.map((a, k) => (
          <line key={k} x1="100" y1="22" x2="100" y2={k % 5 === 0 ? 30 : 27} className="sh-g-tick" transform={`rotate(${a} 100 100)`} />
        ))}
        <g className="sh-g-needle" style={{ transform: `rotate(${angle}deg)` }}>
          <line x1="100" y1="100" x2="100" y2="32" />
          <circle cx="100" cy="100" r="6" />
        </g>
      </svg>
      <div className="sh-g-v"><Count value={g.value} unit={g.unit} /></div>
      <div className="sh-g-l">{g.label}</div>
      {g.note && <div className="sh-g-n">{g.note}</div>}
    </div>
  );
}

/** Линейный график по дням: линии «рисуются» слева направо, под ними мягкая заливка. */
function Trend({ s }: { s: Extract<SlideDto, { kind: 'trend' }> }) {
  const W = 640;
  const H = 250;
  const L = 36;
  const B = 28;
  const n = Math.max(2, s.labels.length);
  const max = Math.max(1, ...s.series.flatMap((r) => r.values));
  const niceMax = Math.max(2, Math.ceil(max / 2) * 2);
  const x = (k: number): number => L + (k * (W - L - 12)) / (n - 1);
  const y = (v: number): number => H - B - (v / niceMax) * (H - B - 16);
  return (
    <div className="sh-trend">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {[0, 0.5, 1].map((f, k) => (
          <g key={k}>
            <line x1={L} x2={W - 12} y1={y(niceMax * f)} y2={y(niceMax * f)} className="sh-t-grid" />
            <text x={L - 6} y={y(niceMax * f) + 4} className="sh-t-axis" textAnchor="end">{Math.round(niceMax * f)}</text>
          </g>
        ))}
        {s.labels.map((l, k) => (
          <text key={k} x={x(k)} y={H - 8} className="sh-t-axis" textAnchor="middle">{l}</text>
        ))}
        {s.series.map((r, si) => {
          const col = r.tone ? COLOR[r.tone] : PALETTE[si % PALETTE.length]!;
          const pts = r.values.map((v, k) => [x(k), y(v)] as const);
          if (pts.length === 0) return null;
          const line = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
          const area = `${line} L${pts[pts.length - 1]![0].toFixed(1)} ${H - B} L${pts[0]![0].toFixed(1)} ${H - B} Z`;
          return (
            <g key={si} style={{ ['--c' as string]: col, ...idx(si) }}>
              <path d={area} className="sh-t-area" />
              <path d={line} pathLength="1" className="sh-t-line" />
              {pts.map((p, k) => <circle key={k} cx={p[0]} cy={p[1]} r={k === pts.length - 1 ? 5 : 3} className="sh-t-dot" style={{ animationDelay: `${0.9 + k * 0.08}s` }} />)}
              <text x={pts[pts.length - 1]![0]} y={pts[pts.length - 1]![1] - 10} className="sh-t-last" textAnchor="middle">{r.values[r.values.length - 1]}</text>
            </g>
          );
        })}
      </svg>
      <div className="sh-t-legend">
        {s.series.map((r, si) => <span key={si}><i style={{ background: r.tone ? COLOR[r.tone] : PALETTE[si % PALETTE.length] }} />{r.label}</span>)}
      </div>
    </div>
  );
}

function Slide({ s, source }: { s: SlideDto; source: string }) {
  if (s.kind === 'title') {
    return (
      <div className="sh-title">
        <svg className="sh-rings" viewBox="0 0 400 400" aria-hidden="true">
          <circle cx="200" cy="200" r="150" /><circle cx="200" cy="200" r="110" /><circle cx="200" cy="200" r="190" />
        </svg>
        <h1>{s.title}</h1>
        {s.subtitle && <p>{s.subtitle}</p>}
      </div>
    );
  }
  return (
    <Mock tag={source}>
      <Head s={s} />
      {s.kind === 'kpis' && (
        <div className="sh-kpis">
          {s.items.map((k, i) => (
            <div key={i} className="sh-kpi" style={{ ...idx(i), ['--c' as string]: COLOR[k.tone ?? 'neutral'] }}>
              <div className="sh-kpi-v"><Count value={k.value} unit={k.unit} /></div>
              <div className="sh-kpi-l">{k.label}</div>
              {k.note && <div className="sh-kpi-n">{k.note}</div>}
              <span className="sh-kpi-bar" />
            </div>
          ))}
        </div>
      )}
      {s.kind === 'bars' && (() => {
        const max = Math.max(1, ...s.items.map((x) => x.value));
        return (
          <div className="sh-bars">
            {s.items.map((b, i) => (
              <div key={i} className="sh-bar-row" style={idx(i)}>
                <span className="sh-bar-l">{b.label}</span>
                <span className="sh-bar-track">
                  <span className="sh-bar-fill" style={{ ['--w' as string]: `${Math.max(2, (b.value / max) * 100)}%`, ['--c' as string]: COLOR[b.tone ?? 'neutral'] }} />
                </span>
                <span className="sh-bar-v"><Count value={b.value} unit={s.unit ? ` ${s.unit}` : ''} /></span>
                {b.note && <span className="sh-bar-n">{b.note}</span>}
              </div>
            ))}
          </div>
        );
      })()}
      {s.kind === 'funnel' && (() => {
        const max = Math.max(1, ...s.stages.map((x) => x.value));
        return (
          <div className="sh-funnel">
            {s.stages.map((f, i) => (
              <div key={i} className="sh-fn" style={{ ...idx(i), ['--w' as string]: `${Math.max(14, (f.value / max) * 100)}%`, ['--c' as string]: COLOR[f.tone ?? 'neutral'] }}>
                <span className="sh-fn-shape"><b><Count value={f.value} /></b></span>
                <span className="sh-fn-l">{f.label}</span>
              </div>
            ))}
          </div>
        );
      })()}
      {s.kind === 'donut' && (() => {
        const total = Math.max(1, s.items.reduce((a, b) => a + b.value, 0));
        const C = 2 * Math.PI * 70;
        let acc = 0;
        return (
          <div className="sh-donut">
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <circle cx="100" cy="100" r="70" className="sh-donut-bg" />
              {s.items.map((it, i) => {
                const len = (it.value / total) * C;
                const off = -acc;
                acc += len;
                return <circle key={i} cx="100" cy="100" r="70" className="sh-donut-seg" style={{ ...idx(i), stroke: it.tone ? COLOR[it.tone] : PALETTE[i % PALETTE.length], strokeDasharray: `${len} ${C - len}`, strokeDashoffset: off }} />;
              })}
              <text x="100" y="104" textAnchor="middle" className="sh-donut-t">{fmt(total)}</text>
            </svg>
            <ul>
              {s.items.map((it, i) => (
                <li key={i} style={idx(i)}>
                  <i style={{ background: it.tone ? COLOR[it.tone] : PALETTE[i % PALETTE.length] }} />
                  <span>{it.label}</span>
                  <b><Count value={it.value} /></b>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}
      {s.kind === 'table' && (
        <div className="sh-table-wrap">
          <table className="sh-table">
            <thead><tr>{s.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{s.rows.map((r, i) => <tr key={i} style={idx(i)}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {s.kind === 'gauges' && (
        <div className="sh-gauges">
          {s.items.map((g, i) => <Gauge key={i} g={g} i={i} />)}
        </div>
      )}
      {s.kind === 'trend' && <Trend s={s} />}
      {s.kind === 'alerts' && (
        <ul className="sh-alerts">
          {s.items.map((a, i) => (
            <li key={i} className={`sh-alert lv-${a.level}`} style={idx(i)}>
              <span className="sh-alert-dot" aria-hidden="true" />
              <div>
                <b>{a.title}</b>
                {a.detail && <small>{a.detail}</small>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {s.kind === 'text' && (
        <ul className="sh-text">
          {s.bullets.map((b, i) => <li key={i} style={idx(i)}>{b}</li>)}
        </ul>
      )}
    </Mock>
  );
}

/**
 * Полноэкранный «Показ»: слайды в космическом оформлении с движением — числа набегают, столбцы растут, воронки раскрываются, слайды
 * «влетают» в рамке-макете. Листается стрелками, мышью и голосом («дальше», «назад», «пауза», «закрой»); сам идёт по слайдам.
 */
export function ShowView(props: { deck: DeckDto; command: ShowCommand | null; onClose: () => void; narrator?: (text: string) => { done: Promise<void>; cancel: () => void } }) {
  const { deck } = props;
  const n = deck.slides.length;
  const sec = deck.autoplaySec ?? 9;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [dir, setDir] = useState<1 | -1>(1);
  const last = i === n - 1;
  const go = (to: number): void => {
    const t = Math.max(0, Math.min(n - 1, to));
    setDir(t >= i ? 1 : -1);
    setI(t);
  };

  // космические звуки: вход в показ и «пролёт» при каждой смене слайда; тревожный слайд — свой сигнал
  const firstRef = useRef(true);
  useEffect(() => {
    const kind = deck.slides[i]?.kind;
    if (firstRef.current) {
      firstRef.current = false;
      uiSounds.play(deck.title.startsWith('Утренняя') ? 'sweep' : 'open');
      return;
    }
    uiSounds.play('whoosh');
    if (kind === 'alerts' && (deck.slides[i] as { items?: { level: string }[] }).items?.some((a) => a.level === 'hot')) window.setTimeout(() => uiSounds.play('alarm'), 380);
    else if (kind === 'kpis') window.setTimeout(() => uiSounds.play('tick'), 420);
  }, [i]);

  // Озвученный показ: на каждом слайде читается его текст (say); когда реплика закончилась — пауза и следующий слайд
  const narrating = !!props.narrator && deck.narrate === true;
  const say = deck.slides[i]?.say;
  useEffect(() => {
    if (!narrating || !say || !playing) return;
    let alive = true;
    let next = 0;
    const h = props.narrator!(say);
    void h.done.then(() => {
      if (alive && !last) next = window.setTimeout(() => go(i + 1), 1100);
    });
    return () => {
      alive = false;
      window.clearTimeout(next);
      h.cancel();
    };
  }, [narrating, say, playing, i]);

  // автопоказ
  useEffect(() => {
    if (!playing || last || (narrating && say)) return;
    const t = window.setTimeout(() => go(i + 1), sec * 1000);
    return () => window.clearTimeout(t);
  }, [playing, i, last, sec, narrating, say]);

  // клавиатура
  const goRef = useRef(go);
  goRef.current = go;
  const iRef = useRef(i);
  iRef.current = i;
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goRef.current(iRef.current + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goRef.current(iRef.current - 1);
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [props.onClose]);

  // голосовые команды
  useEffect(() => {
    const c = props.command;
    if (!c) return;
    if (c.kind === 'next') (setPlaying(false), goRef.current(iRef.current + 1));
    else if (c.kind === 'prev') (setPlaying(false), goRef.current(iRef.current - 1));
    else if (c.kind === 'first') goRef.current(0);
    else if (c.kind === 'pause') setPlaying(false);
    else if (c.kind === 'play') setPlaying(true);
  }, [props.command]);

  const source = useMemo(() => (deck.source ?? 'СИСТЕМНО').toUpperCase(), [deck.source]);
  const slide = deck.slides[i]!;
  return (
    <section className="show" data-testid="show" aria-label={deck.title}>
      <div className="show-aurora" aria-hidden="true" />
      <header className="show-top">
        <div className="show-brand">
          <span className="show-mark" aria-hidden="true" />
          <div>
            <div className="show-title">{deck.title}</div>
            {deck.source && <div className="show-src">{deck.source}</div>}
          </div>
        </div>
        <div className="show-ctl">
          <button onClick={() => go(i - 1)} disabled={i === 0} title="Назад (←)" aria-label="Предыдущий слайд">‹</button>
          <button onClick={() => setPlaying((p) => !p)} title={playing ? 'Пауза (пробел)' : 'Продолжить (пробел)'} aria-label={playing ? 'Пауза' : 'Продолжить'} data-testid="show-play">{playing && !last ? '❚❚' : '▶'}</button>
          <button onClick={() => go(i + 1)} disabled={last} title="Дальше (→)" aria-label="Следующий слайд">›</button>
          <span className="show-count" data-testid="show-count">{i + 1} / {n}</span>
          <button className="show-x" onClick={props.onClose} title="Закрыть (Esc или «закрой»)" aria-label="Закрыть показ">✕</button>
        </div>
      </header>

      <div className={`show-stage dir-${dir}`}>
        <div key={i} className="show-slide" data-kind={slide.kind} data-testid="show-slide">
          <Slide s={slide} source={source} />
        </div>
      </div>

      <footer className="show-foot">
        <div className="show-dots" role="tablist">
          {deck.slides.map((_, k) => (
            <button key={k} role="tab" aria-selected={k === i} className={k === i ? 'on' : k < i ? 'seen' : ''} onClick={() => go(k)} aria-label={`Слайд ${k + 1}`} />
          ))}
        </div>
        <div className="show-hint">← → листать · пробел — пауза · Esc — закрыть · голосом: «дальше», «назад», «пауза», «закрой»</div>
      </footer>
      {playing && !last && !(narrating && say) && <div key={`p${i}`} className="show-progress" style={{ animationDuration: `${sec}s` }} aria-hidden="true" />}
    </section>
  );
}
