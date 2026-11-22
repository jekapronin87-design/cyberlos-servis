// Звуки интерфейса: синтезируются на лету (Web Audio), файлов нет. Тихие, короткие, «космические».

export type SoundKind = 'click' | 'hover' | 'toggleOn' | 'toggleOff' | 'open' | 'send' | 'wake' | 'sleep' | 'reply' | 'success' | 'error';

interface Note {
  f: number;
  to?: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain: number;
}

/** Описание каждого звука — набор нот. Чистые данные: удобно проверять и править. */
export const RECIPES: Record<SoundKind, Note[]> = {
  click: [
    { f: 1250, to: 1800, dur: 0.05, type: 'sine', gain: 0.1 },
    { f: 620, at: 0.012, dur: 0.07, type: 'triangle', gain: 0.05 },
  ],
  hover: [{ f: 2100, dur: 0.022, type: 'sine', gain: 0.022 }],
  toggleOn: [
    { f: 700, to: 980, dur: 0.07, type: 'sine', gain: 0.1 },
    { f: 1250, at: 0.06, dur: 0.09, type: 'sine', gain: 0.09 },
  ],
  toggleOff: [
    { f: 1100, to: 760, dur: 0.07, type: 'sine', gain: 0.09 },
    { f: 520, at: 0.06, dur: 0.09, type: 'sine', gain: 0.08 },
  ],
  open: [
    { f: 260, to: 1100, dur: 0.22, type: 'sine', gain: 0.07 },
    { f: 130, to: 520, dur: 0.26, type: 'triangle', gain: 0.05 },
    { f: 1600, at: 0.14, dur: 0.12, type: 'sine', gain: 0.04 },
  ],
  send: [
    { f: 520, to: 1500, dur: 0.1, type: 'sine', gain: 0.1 },
    { f: 1900, at: 0.09, dur: 0.06, type: 'sine', gain: 0.05 },
  ],
  wake: [
    { f: 660, dur: 0.09, type: 'sine', gain: 0.11 },
    { f: 990, at: 0.08, dur: 0.12, type: 'sine', gain: 0.11 },
    { f: 1480, at: 0.17, dur: 0.16, type: 'sine', gain: 0.07 },
  ],
  sleep: [
    { f: 990, dur: 0.08, type: 'sine', gain: 0.08 },
    { f: 660, at: 0.08, dur: 0.12, type: 'sine', gain: 0.08 },
  ],
  reply: [
    { f: 880, dur: 0.14, type: 'sine', gain: 0.06 },
    { f: 1320, at: 0.07, dur: 0.22, type: 'sine', gain: 0.05 },
  ],
  success: [
    { f: 784, dur: 0.1, type: 'sine', gain: 0.1 },
    { f: 988, at: 0.09, dur: 0.1, type: 'sine', gain: 0.1 },
    { f: 1319, at: 0.18, dur: 0.22, type: 'sine', gain: 0.09 },
  ],
  error: [
    { f: 190, to: 120, dur: 0.22, type: 'sawtooth', gain: 0.07 },
    { f: 150, at: 0.09, to: 100, dur: 0.2, type: 'square', gain: 0.04 },
  ],
};

interface AudioCtxLike {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?: () => Promise<void>;
  createOscillator(): { type: string; frequency: { setValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): void; start(t: number): void; stop(t: number): void };
  createGain(): { gain: { setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void }; connect(n: unknown): void };
}

export class UiSounds {
  private ctx: AudioCtxLike | null = null;
  private last = new Map<SoundKind, number>();
  enabled = true;
  /** Микрофон слушает: звуки тише и без «наведения», чтобы не мешать распознаванию. */
  micActive = false;

  constructor(private factory: () => AudioCtxLike | null = () => (typeof AudioContext !== 'undefined' ? (new AudioContext() as unknown as AudioCtxLike) : null)) {}

  play(kind: SoundKind): void {
    if (!this.enabled) return;
    if (this.micActive && (kind === 'hover' || kind === 'open')) return;
    const now = Date.now();
    const gap = kind === 'hover' ? 70 : 25;
    if (now - (this.last.get(kind) ?? 0) < gap) return;
    this.last.set(kind, now);
    try {
      this.ctx ??= this.factory();
      const c = this.ctx;
      if (!c) return;
      if (c.state === 'suspended') void c.resume?.();
      const vol = this.micActive ? 0.45 : 1;
      const t0 = c.currentTime;
      for (const n of RECIPES[kind]) {
        const osc = c.createOscillator();
        const g = c.createGain();
        const st = t0 + (n.at ?? 0);
        osc.type = n.type ?? 'sine';
        osc.frequency.setValueAtTime(n.f, st);
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, st + n.dur);
        g.gain.setValueAtTime(0.0001, st);
        g.gain.linearRampToValueAtTime(n.gain * vol, st + Math.min(0.008, n.dur / 3));
        g.gain.exponentialRampToValueAtTime(0.0001, st + n.dur);
        osc.connect(g);
        g.connect(c.destination);
        osc.start(st);
        osc.stop(st + n.dur + 0.02);
      }
    } catch {
      /* звук недоступен — интерфейс продолжает работать */
    }
  }
}

export const uiSounds = new UiSounds();

const CLICKABLE = 'button, a[href], [role=button], [role=tab], summary, select, .nav-item, label.check, .chip, .list-item[style*="cursor"]';

/** Вешает звуки на все кнопки окна (делегирование событий). Возвращает функцию отключения. */
export function installUiSounds(root: Document = document): () => void {
  let lastTarget: Element | null = null;
  const onDown = (e: Event): void => {
    const el = (e.target as Element | null)?.closest?.(CLICKABLE);
    if (!el || (el as HTMLButtonElement).disabled) return;
    if (el.classList.contains('nav-item')) uiSounds.play('open');
    else if (el.closest('label.check')) return; // для переключателей звучит change
    else uiSounds.play('click');
  };
  const onOver = (e: Event): void => {
    const el = (e.target as Element | null)?.closest?.(CLICKABLE);
    if (!el || el === lastTarget || (el as HTMLButtonElement).disabled) return;
    lastTarget = el;
    uiSounds.play('hover');
  };
  const onChange = (e: Event): void => {
    const t = e.target as HTMLInputElement | null;
    if (t?.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio')) uiSounds.play(t.checked ? 'toggleOn' : 'toggleOff');
  };
  const onOut = (): void => {
    lastTarget = null;
  };
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('mouseover', onOver, true);
  root.addEventListener('mouseout', onOut, true);
  root.addEventListener('change', onChange, true);
  return () => {
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('mouseover', onOver, true);
    root.removeEventListener('mouseout', onOut, true);
    root.removeEventListener('change', onChange, true);
  };
}

/** Тихий фоновый «гул космоса»: два расстроенных низких тона с медленным дыханием. */
export class Ambient {
  private nodes: { stop(): void } | null = null;
  start(): void {
    if (this.nodes || typeof AudioContext === 'undefined') return;
    try {
      const c = new AudioContext();
      const master = c.createGain();
      master.gain.value = 0;
      master.gain.linearRampToValueAtTime(0.018, c.currentTime + 3);
      master.connect(c.destination);
      const mk = (f: number, g: number): OscillatorNode => {
        const o = c.createOscillator();
        const gg = c.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        gg.gain.value = g;
        o.connect(gg);
        gg.connect(master);
        o.start();
        return o;
      };
      const oscs = [mk(55, 1), mk(55.7, 0.8), mk(82.4, 0.35)];
      const lfo = c.createOscillator();
      const lg = c.createGain();
      lfo.frequency.value = 0.07;
      lg.gain.value = 0.008;
      lfo.connect(lg);
      lg.connect(master.gain);
      lfo.start();
      this.nodes = {
        stop: () => {
          master.gain.linearRampToValueAtTime(0, c.currentTime + 1);
          setTimeout(() => {
            [...oscs, lfo].forEach((o) => o.stop());
            void c.close();
          }, 1200);
        },
      };
    } catch {
      this.nodes = null;
    }
  }
  stop(): void {
    this.nodes?.stop();
    this.nodes = null;
  }
}
export const ambient = new Ambient();
