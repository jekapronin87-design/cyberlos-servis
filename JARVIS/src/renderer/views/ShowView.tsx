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
export function ShowView(props: { deck: DeckDto; command: ShowCommand | null; onClose: () => void }) {
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

  // автопоказ
  useEffect(() => {
    if (!playing || last) return;
    const t = window.setTimeout(() => go(i + 1), sec * 1000);
    return () => window.clearTimeout(t);
  }, [playing, i, last, sec]);

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
      {playing && !last && <div key={`p${i}`} className="show-progress" style={{ animationDuration: `${sec}s` }} aria-hidden="true" />}
    </section>
  );
}
