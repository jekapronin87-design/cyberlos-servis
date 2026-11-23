// Красивые субтитры и надписи: формат ASS (рендерит ffmpeg/libass). Слова подсвечиваются по мере произнесения, фраза «выпрыгивает» и гаснет.

export interface Word {
  w: string;
  s: number;
  e: number;
}

export type SubStyle = 'bold' | 'neon' | 'clean';

const COLORS: Record<SubStyle, { fill: string; base: string; outline: string; accent: string }> = {
  // &HAABBGGRR
  bold: { fill: '&H0000E5FF', base: '&H00FFFFFF', outline: '&H00000000', accent: '&H0000E5FF' },
  neon: { fill: '&H00FFC85C', base: '&H00FFFFFF', outline: '&H00401808', accent: '&H00FFC85C' },
  clean: { fill: '&H00FFFFFF', base: '&H00FFFFFF', outline: '&H00202020', accent: '&H00FFFFFF' },
};

export function defaultFont(platform: string = process.platform): { name: string; dir: string | null; file: string } {
  if (platform === 'win32') return { name: 'Arial Black', dir: 'C:/Windows/Fonts', file: 'C:/Windows/Fonts/ariblk.ttf' };
  if (platform === 'darwin') return { name: 'Arial Black', dir: '/System/Library/Fonts/Supplemental', file: '/System/Library/Fonts/Supplemental/Arial Black.ttf' };
  return { name: 'DejaVu Sans', dir: '/usr/share/fonts/truetype/dejavu', file: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' };
}

const esc = (t: string): string => t.replace(/[{}\\]/g, ' ').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
const ts = (sec: number): string => {
  const v = Math.max(0, sec);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};

/** Группирует слова в короткие «кадры» субтитров (до 3 слов, ~1,8 с, обрыв на паузе и знаках препинания). */
export function chunkWords(words: Word[], o: { maxWords?: number; maxSec?: number; maxChars?: number } = {}): Word[][] {
  const maxWords = o.maxWords ?? 3;
  const maxSec = o.maxSec ?? 1.8;
  const maxChars = o.maxChars ?? 18;
  const out: Word[][] = [];
  let cur: Word[] = [];
  const flush = (): void => {
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (const w of words) {
    if (!w.w.trim() || !(w.e >= w.s)) continue;
    const gap = cur.length ? w.s - cur[cur.length - 1]!.e : 0;
    const chars = cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || w.e - cur[0]!.s > maxSec || chars > maxChars || gap > 0.6)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.w)) flush();
  }
  flush();
  return out;
}

/** Размер шрифта, при котором строка из chars знаков гарантированно помещается в долю frac ширины (широкие жирные шрифты ≈ 0,78 em на знак). */
export function fitSize(chars: number, width: number, max: number, frac = 0.88): number {
  return Math.max(12, Math.min(max, Math.floor((width * frac) / (Math.max(1, chars) * 0.78))));
}

export interface AssOpts {
  width: number;
  height: number;
  style?: SubStyle;
  font?: string;
  /** Высота кегля относительно высоты кадра. */
  size?: number;
  /** Отступ снизу (доля высоты). */
  bottom?: number;
}

function header(o: AssOpts, titleSize: number): string {
  const c = COLORS[o.style ?? 'bold'];
  const font = o.font ?? defaultFont().name;
  const size = fitSize(18, o.width, Math.round(o.height * (o.size ?? 0.038)));
  const mv = Math.round(o.height * (o.bottom ?? 0.17));
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${font},${size},${c.fill},${c.base},${c.outline},&H64000000,${font === 'DejaVu Sans' ? -1 : 0},0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.11))},${Math.max(1, Math.round(size * 0.04))},2,${Math.round(o.width * 0.06)},${Math.round(o.width * 0.06)},${mv},1`,
    `Style: Title,${font},${titleSize},&H00FFFFFF,&H00FFFFFF,${c.outline},&H64000000,${font === 'DejaVu Sans' ? -1 : 0},0,0,0,100,100,2,0,1,${Math.max(3, Math.round(titleSize * 0.1))},${Math.max(1, Math.round(titleSize * 0.04))},8,${Math.round(o.width * 0.07)},${Math.round(o.width * 0.07)},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

/** Разбивает заголовок на строки по ширине (≈ chars знаков), слова не рвёт. */
export function wrapTitle(t: string, chars = 16): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const w of esc(t).split(' ')) {
    if (cur && (cur + ' ' + w).length > chars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

/** Файл субтитров + (необязательно) вылетающий заголовок в начале ролика. */
export function buildAss(words: Word[], o: AssOpts & { title?: string; titleSec?: number; uppercase?: boolean }): string {
  const rows0 = o.title ? wrapTitle(o.title, o.width > o.height ? 30 : 15) : [];
  const titleSize = fitSize(Math.max(0, ...rows0.map((r) => r.length)) || 15, o.width, Math.round(o.height * 0.058), 0.84);
  const c = COLORS[o.style ?? 'bold'];
  const lines: string[] = [header(o, titleSize)];
  const chunks = chunkWords(words);
  chunks.forEach((ch, i) => {
    const start = ch[0]!.s;
    const next = chunks[i + 1]?.[0]?.s ?? Infinity;
    const end = Math.min(ch[ch.length - 1]!.e + 0.18, next - 0.02, start + 4);
    if (!(end > start)) return;
    const body = ch
      .map((w) => {
        const cs = Math.max(8, Math.round((w.e - w.s) * 100));
        const txt = esc(o.uppercase === false ? w.w : w.w.toLocaleUpperCase('ru-RU'));
        return `{\\kf${cs}}${txt}`;
      })
      .join(' ');
    lines.push(`Dialogue: 0,${ts(start)},${ts(end)},Sub,,0,0,0,,{\\fad(40,60)\\fscx88\\fscy88\\t(0,120,\\fscx108\\fscy108)\\t(120,240,\\fscx100\\fscy100)}${body}`);
  });
  if (o.title) {
    const sec = o.titleSec ?? 3.2;
    const rows = wrapTitle(o.title, o.width > o.height ? 30 : 15);
    const y = Math.round(o.height * 0.13);
    const text = rows.map((r, i) => (i === rows.length - 1 ? `{\\c${c.accent}}${r.toLocaleUpperCase('ru-RU')}` : r.toLocaleUpperCase('ru-RU'))).join('\\N');
    lines.push(`Dialogue: 1,${ts(0.15)},${ts(sec)},Title,,0,0,0,,{\\pos(${Math.round(o.width / 2)},${y})\\fad(350,450)\\blur10\\fscx70\\fscy70\\t(0,420,\\blur0\\fscx100\\fscy100)}${text}`);
  }
  return lines.join('\n') + '\n';
}

/** Текст для обложки (неподвижная картинка): крупный заголовок внизу, последняя строка — акцентным цветом. */
export function buildCoverAss(o: AssOpts & { title: string; kicker?: string }): string {
  const c = COLORS[o.style ?? 'bold'];
  const rows = wrapTitle(o.title, o.width > o.height ? 22 : 13);
  const size = fitSize(Math.max(...rows.map((r) => r.length)), o.width, Math.round(o.height * (o.width > o.height ? 0.11 : 0.072)), 0.9);
  const lines: string[] = [header({ ...o, size: 0.05 }, size)];
  const text = rows.map((r, i) => (i === rows.length - 1 ? `{\\c${c.accent}}${r.toLocaleUpperCase('ru-RU')}` : r.toLocaleUpperCase('ru-RU'))).join('\\N');
  const y = Math.round(o.height * (o.width > o.height ? 0.38 : 0.52));
  lines.push(`Dialogue: 1,0:00:00.00,0:00:05.00,Title,,0,0,0,,{\\pos(${Math.round(o.width / 2)},${y})}${text}`);
  if (o.kicker) {
    lines.push(`Dialogue: 1,0:00:00.00,0:00:05.00,Sub,,0,0,0,,{\\an8\\pos(${Math.round(o.width / 2)},${Math.round(o.height * 0.08)})\\fs${Math.round(o.height * 0.034)}\\c${c.accent}}${esc(o.kicker).toLocaleUpperCase('ru-RU')}`);
  }
  return lines.join('\n') + '\n';
}
