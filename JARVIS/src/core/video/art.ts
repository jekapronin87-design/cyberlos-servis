// Оформление канала: процедурные фоны (без нейросети, бесплатно) в трёх стилях + текст в безопасной зоне YouTube.
import { defaultFont, fitSize, wrapTitle } from './ass';

export type ArtStyle = 'space' | 'neon' | 'minimal';
export const ART_STYLES: ArtStyle[] = ['space', 'neon', 'minimal'];

/** Безопасная зона шапки YouTube (видна на всех устройствах): 1546×423 по центру холста 2560×1440. */
export const SAFE = { w: 1546, h: 423 };

const clip = (e: string): string => `clip(${e},0,255)`;
const glow = (cx: number, cy: number, rx: number, ry: number): string => `exp(-pow((X-${cx})/${rx},2)-pow((Y-${cy})/${ry},2))`;
/** Тонкое эллиптическое кольцо радиуса r вокруг (cx, cy), сплющенное по вертикали. */
const ring = (cx: number, cy: number, r: number, squash: number, w = 3): string => `exp(-pow((hypot(X-${cx},(Y-${cy})/${squash})-${r})/${w},2))`;

/** Фильтр ffmpeg (geq), рисующий фон шапки. Вход — однотонный кадр W×H в rgb24. */
export function bannerBackground(style: ArtStyle, W: number, H: number): string {
  if (style === 'neon') {
    const grid = `(lt(mod(X,96),3)+lt(mod(Y,96),3))*(0.1+0.6*Y/${H})`;
    const l = glow(W * 0.12, H * 0.9, W * 0.35, H * 0.5);
    const r = glow(W * 0.88, H * 0.15, W * 0.35, H * 0.5);
    return `geq=r='${clip(`10+190*${l}+30*${r}+60*${grid}`)}':g='${clip(`4+40*${l}+170*${r}+70*${grid}`)}':b='${clip(`34+150*${l}+210*${r}+90*${grid}`)}'`;
  }
  if (style === 'minimal') {
    const g = glow(W * 0.86, H * 0.28, W * 0.3, H * 0.6);
    return `geq=r='${clip(`8+12*Y/${H}+40*${g}`)}':g='${clip(`18+26*Y/${H}+70*${g}`)}':b='${clip(`46+58*Y/${H}+120*${g}`)}'`;
  }
  // space: туманности, звёзды и орбиты вокруг планеты
  const a = glow(W * 0.72, H * 0.3, W * 0.35, H * 0.45);
  const b = glow(W * 0.2, H * 0.8, W * 0.3, H * 0.4);
  const px = W * 0.84;
  const py = H * 0.42;
  const planet = `exp(-pow(hypot(X-${px},Y-${py})/150,2))`;
  const orbit = `(${ring(px, py, 330, 0.34)}+${ring(px, py, 520, 0.34)}+0.6*${ring(px, py, 740, 0.34)})`;
  const star = 'if(gt(random(1),0.9992),230,0)';
  return `geq=r='${clip(`8+90*${a}+40*${b}+60*${planet}+25*${orbit}+${star}`)}':g='${clip(`14+70*${a}+30*${b}+90*${planet}+60*${orbit}+${star}`)}':b='${clip(`34+170*${a}+120*${b}+140*${planet}+120*${orbit}+${star}`)}'`;
}

/** Фон аватара 800×800. */
export function avatarBackground(style: ArtStyle): string {
  const d = 'hypot(X-400,Y-400)';
  if (style === 'neon') return `geq=r='${clip(`10+200*exp(-pow((${d}-300)/10,2))`)}':g='${clip(`4+120*exp(-pow((${d}-300)/10,2))+30*exp(-pow(${d}/300,2))`)}':b='${clip(`34+220*exp(-pow((${d}-300)/10,2))+80*exp(-pow(${d}/300,2))`)}'`;
  if (style === 'minimal') return `geq=r='${clip(`14+30*exp(-pow(${d}/420,2))`)}':g='${clip(`30+60*exp(-pow(${d}/420,2))`)}':b='${clip(`80+120*exp(-pow(${d}/420,2))`)}'`;
  return `geq=r='${clip('10+120*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2))')}':g='${clip('20+160*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2))')}':b='${clip('60+190*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2))')}'`;
}

const ACCENT: Record<ArtStyle, string> = { space: '&H00FFC85C', neon: '&H00FFE15C', minimal: '&H00FFD9A8' };
const OUTLINE: Record<ArtStyle, string> = { space: '&H00401808', neon: '&H00500A38', minimal: '&H00301808' };

/** Субтитры ASS с названием и слоганом в безопасной зоне. Размер шрифта подбирается под длину, чтобы всё помещалось. */
export function bannerAss(style: ArtStyle, name: string, tagline: string, W = 2560, H = 1440): { ass: string; nameSize: number; tagSize: number } {
  const font = defaultFont();
  const bold = font.name === 'DejaVu Sans' ? -1 : 0;
  const clean = (t: string): string => t.replace(/[{}\\]/g, '').toLocaleUpperCase('ru-RU');
  const rows = wrapTitle(name.slice(0, 40), 20);
  const nameSize = fitSize(Math.max(...rows.map((r) => r.length)), SAFE.w, rows.length > 1 ? 150 : 170, 1);
  const tagSize = fitSize(tagline.length || 1, SAFE.w, 64, 1);
  const text = rows.map(clean).join('\\N');
  const cy = H / 2 - (tagline ? 40 : 0);
  const line1 = `Dialogue: 1,0:00:00.00,0:00:05.00,Name,,0,0,0,,{\\pos(${W / 2},${cy})}${text}`;
  const line2 = tagline ? `Dialogue: 1,0:00:00.00,0:00:05.00,Tag,,0,0,0,,{\\pos(${W / 2},${cy + nameSize * 0.55 * rows.length + 50})}${clean(tagline.slice(0, 70))}` : '';
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Name,${font.name},${nameSize},&H00FFFFFF,&H00FFFFFF,${OUTLINE[style]},&H64000000,${bold},0,0,0,100,100,6,0,1,${style === 'minimal' ? 4 : 10},${style === 'minimal' ? 0 : 3},5,0,0,0,1`,
    `Style: Tag,${font.name},${tagSize},${ACCENT[style]},${ACCENT[style]},${OUTLINE[style]},&H64000000,${bold},0,0,0,100,100,4,0,1,${style === 'minimal' ? 3 : 5},${style === 'minimal' ? 0 : 2},5,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', line1, line2,
  ].filter(Boolean).join('\n');
  return { ass, nameSize, tagSize };
}

export function avatarAss(style: ArtStyle, initials: string): string {
  const font = defaultFont();
  const bold = font.name === 'DejaVu Sans' ? -1 : 0;
  const size = initials.length > 1 ? 300 : 380;
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 800', 'PlayResY: 800', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: I,${font.name},${size},&H00FFFFFF,&H00FFFFFF,${OUTLINE[style]},&H64000000,${bold},0,0,0,100,100,0,0,1,${style === 'minimal' ? 4 : 8},${style === 'minimal' ? 0 : 2},5,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 1,0:00:00.00,0:00:05.00,I,,0,0,0,,{\\pos(400,410)}${initials.replace(/[{}\\]/g, '')}`,
  ].join('\n');
}
