// Звуки интерфейса: синтезируются на лету (Web Audio), файлов нет. Тихие, короткие, «космические».

export type SoundKind = 'click' | 'hover' | 'toggleOn' | 'toggleOff' | 'open' | 'send' | 'wake' | 'sleep' | 'reply' | 'success' | 'error' | 'boot';

interface Note {
  f: number;
  to?: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain: number;
  /** FM-«металл»: частота модулятора = f * ratio, глубина — в герцах. Даёт чистый «звон», как у космических интерфейсов. */
  fm?: { ratio: number; depth: number };
}

/** Описание каждого звука — набор нот. Чистые данные: удобно проверять и править. Громкость задаёт ползунок в настройках. */
export const RECIPES: Record<SoundKind, Note[]> = {
  click: [
    { f: 1700, to: 2300, dur: 0.06, type: 'sine', gain: 0.26, fm: { ratio: 2.01, depth: 420 } },
    { f: 240, to: 120, dur: 0.05, type: 'triangle', gain: 0.2 },
  ],
  hover: [{ f: 3400, dur: 0.02, type: 'sine', gain: 0.07 }],
  toggleOn: [
    { f: 900, to: 1250, dur: 0.07, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 260 } },
    { f: 1760, at: 0.065, dur: 0.12, type: 'sine', gain: 0.22, fm: { ratio: 3, depth: 200 } },
  ],
  toggleOff: [
    { f: 1400, to: 900, dur: 0.07, type: 'sine', gain: 0.22, fm: { ratio: 2, depth: 260 } },
    { f: 640, at: 0.065, dur: 0.12, type: 'sine', gain: 0.2, fm: { ratio: 3, depth: 160 } },
  ],
  open: [
    { f: 180, to: 1300, dur: 0.26, type: 'sine', gain: 0.18 },
    { f: 90, to: 640, dur: 0.3, type: 'triangle', gain: 0.14 },
    { f: 2093, at: 0.16, dur: 0.18, type: 'sine', gain: 0.14, fm: { ratio: 2.7, depth: 300 } },
    { f: 3136, at: 0.22, dur: 0.2, type: 'sine', gain: 0.09, fm: { ratio: 2.7, depth: 300 } },
  ],
  send: [
    { f: 700, to: 2000, dur: 0.1, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 300 } },
    { f: 2600, at: 0.09, dur: 0.1, type: 'sine', gain: 0.12 },
  ],
  wake: [
    { f: 784, dur: 0.1, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 200 } },
    { f: 1175, at: 0.09, dur: 0.12, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 200 } },
    { f: 1760, at: 0.19, dur: 0.24, type: 'sine', gain: 0.18, fm: { ratio: 2, depth: 200 } },
  ],
  sleep: [
    { f: 1175, dur: 0.09, type: 'sine', gain: 0.2, fm: { ratio: 2, depth: 160 } },
    { f: 784, at: 0.09, dur: 0.16, type: 'sine', gain: 0.2, fm: { ratio: 2, depth: 160 } },
  ],
  reply: [
    { f: 1047, dur: 0.16, type: 'sine', gain: 0.16, fm: { ratio: 3, depth: 180 } },
    { f: 1568, at: 0.08, dur: 0.26, type: 'sine', gain: 0.13, fm: { ratio: 3, depth: 180 } },
  ],
  success: [
    { f: 880, dur: 0.1, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 220 } },
    { f: 1109, at: 0.09, dur: 0.1, type: 'sine', gain: 0.24, fm: { ratio: 2, depth: 220 } },
    { f: 1568, at: 0.18, dur: 0.3, type: 'sine', gain: 0.22, fm: { ratio: 2, depth: 220 } },
  ],
  error: [
    { f: 220, to: 150, dur: 0.2, type: 'sawtooth', gain: 0.16 },
    { f: 165, at: 0.1, to: 110, dur: 0.24, type: 'square', gain: 0.1 },
  ],
  /** Включение системы: нарастающий гул и «звон» после него (только при запуске окна). */
  boot: [
    { f: 70, to: 520, dur: 0.9, type: 'sine', gain: 0.2 },
    { f: 140, to: 1040, dur: 1.0, type: 'triangle', gain: 0.1 },
    { f: 1568, at: 0.85, dur: 0.5, type: 'sine', gain: 0.2, fm: { ratio: 2.7, depth: 380 } },
    { f: 2349, at: 0.95, dur: 0.55, type: 'sine', gain: 0.14, fm: { ratio: 2.7, depth: 380 } },
  ],
};

interface ParamLike {
  value?: number;
  setValueAtTime(v: number, t: number): void;
  exponentialRampToValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime?(v: number, t: number): void;
}
interface NodeLike {
  connect(n: unknown): unknown;
}
interface AudioCtxLike {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?: () => Promise<void>;
  createOscillator(): NodeLike & { type: string; frequency: ParamLike; start(t: number): void; stop(t: number): void };
  createGain(): NodeLike & { gain: ParamLike };
  createDynamicsCompressor?(): NodeLike;
  createDelay?(max: number): NodeLike & { delayTime: { value: number } };
  createBiquadFilter?(): NodeLike & { type: string; frequency: { value: number } };
}

export class UiSounds {
  private ctx: AudioCtxLike | null = null;
  private chain: NodeLike | null = null;
  private last = new Map<SoundKind, number>();
  enabled = true;
  /** 0..1 — общая громкость (ползунок в настройках). */
  volume = 0.7;
  /** Микрофон слушает: звуки тише и без «наведения», чтобы не мешать распознаванию. */
  micActive = false;
  /** Сколько звуков проиграно (для проверок). */
  played = 0;

  constructor(private factory: () => AudioCtxLike | null = () => (typeof AudioContext !== 'undefined' ? (new AudioContext() as unknown as AudioCtxLike) : null)) {}

  /** Вход цепочки эффектов: компрессор (чтобы не «щёлкало») и лёгкое космическое эхо. Если браузер не умеет — звук идёт напрямую. */
  private input(c: AudioCtxLike): NodeLike {
    if (this.chain) return this.chain;
    const master = c.createGain();
    master.gain.setValueAtTime(1, c.currentTime);
    try {
      const comp = c.createDynamicsCompressor?.();
      if (comp) {
        master.connect(comp);
        comp.connect(c.destination);
      } else master.connect(c.destination);
      if (c.createDelay && c.createBiquadFilter) {
        const delay = c.createDelay(1);
        delay.delayTime.value = 0.17;
        const fb = c.createGain();
        fb.gain.setValueAtTime(0.32, c.currentTime);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        const wet = c.createGain();
        wet.gain.setValueAtTime(0.28, c.currentTime);
        master.connect(delay);
        delay.connect(lp);
        lp.connect(fb);
        fb.connect(delay);
        lp.connect(wet);
        wet.connect(comp ?? c.destination);
      }
    } catch {
      master.connect(c.destination);
    }
    this.chain = master;
    return master;
  }

  play(kind: SoundKind): void {
    if (!this.enabled || this.volume <= 0) return;
    if (this.micActive && (kind === 'hover' || kind === 'open' || kind === 'boot')) return;
    const now = Date.now();
    const gap = kind === 'hover' ? 70 : 25;
    if (now - (this.last.get(kind) ?? 0) < gap) return;
    this.last.set(kind, now);
    try {
      this.ctx ??= this.factory();
      const c = this.ctx;
      if (!c) return;
      if (c.state === 'suspended') void c.resume?.();
      const out = this.input(c);
      const vol = this.volume * (this.micActive ? 0.45 : 1);
      const t0 = c.currentTime + 0.005;
      for (const n of RECIPES[kind]) {
        const osc = c.createOscillator();
        const g = c.createGain();
        const st = t0 + (n.at ?? 0);
        osc.type = n.type ?? 'sine';
        osc.frequency.setValueAtTime(n.f, st);
        if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, st + n.dur);
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.gain * vol), st + Math.min(0.008, n.dur / 3));
        g.gain.exponentialRampToValueAtTime(0.0001, st + n.dur);
        if (n.fm) {
          const mod = c.createOscillator();
          const mg = c.createGain();
          mod.type = 'sine';
          mod.frequency.setValueAtTime(n.f * n.fm.ratio, st);
          mg.gain.setValueAtTime(n.fm.depth, st);
          mg.gain.exponentialRampToValueAtTime(1, st + n.dur);
          mod.connect(mg);
          mg.connect(osc.frequency as unknown as NodeLike);
          mod.start(st);
          mod.stop(st + n.dur + 0.02);
        }
        osc.connect(g);
        g.connect(out);
        osc.start(st);
        osc.stop(st + n.dur + 0.02);
      }
      this.played += 1;
    } catch (e) {
      /* звук недоступен — интерфейс продолжает работать */
      console.warn('uiSounds:', e instanceof Error ? e.message : e);
    }
  }

  /** Проверка звука: короткая последовательность (кнопка в настройках). */
  async demo(): Promise<void> {
    const seq: SoundKind[] = ['click', 'toggleOn', 'open', 'wake', 'success'];
    for (const k of seq) {
      this.last.clear();
      this.play(k);
      await new Promise((r) => setTimeout(r, 420));
    }
  }
}

export const uiSounds = new UiSounds();
if (typeof window !== 'undefined') (window as unknown as { __uiSounds?: UiSounds }).__uiSounds = uiSounds;

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
