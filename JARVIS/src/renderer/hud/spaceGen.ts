// Процедурная генерация реалистичных космических текстур: шум, поверхности планет и Солнца, Млечный Путь.
// Чистые функции без DOM — результат детерминирован (одно и то же «семя» даёт ту же планету) и проверяется тестами.

export function hash(ix: number, iy: number, seed = 0): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Шум значения; period>0 — повторяется по x (для текстур, замкнутых по долготе). */
export function vnoise(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const wrap = (i: number): number => (period > 0 ? ((i % period) + period) % period : i);
  const a = hash(wrap(x0), y0, seed), b = hash(wrap(x0 + 1), y0, seed);
  const c = hash(wrap(x0), y0 + 1, seed), d = hash(wrap(x0 + 1), y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm(x: number, y: number, oct = 5, seed = 0, period = 0): number {
  let v = 0, amp = 0.5, f = 1, p = period, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, seed + i * 7, p);
    norm += amp;
    amp *= 0.5;
    f *= 2;
    p = p ? p * 2 : 0;
  }
  return v / norm;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
type RGB = [number, number, number];
const mix3 = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export type BodyKind = 'earth' | 'moon' | 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'sun';

export interface Texture {
  w: number;
  h: number;
  /** RGB, 3 байта на пиксель; u — долгота (замкнуто), v — широта сверху вниз. */
  rgb: Uint8ClampedArray;
  /** Облака (0..255) — у Земли и Венеры; null — нет. */
  cloud: Uint8ClampedArray | null;
  /** Признак океана (0..255) — для бликов; null — нет. */
  water: Uint8ClampedArray | null;
  /** Огни городов на ночной стороне (0..255); null — нет. */
  lights: Uint8ClampedArray | null;
}

const PAL = {
  jupiter: [[236, 224, 200], [214, 170, 120], [176, 120, 84], [232, 205, 170], [150, 100, 74], [222, 190, 150]] as RGB[],
  saturn: [[238, 224, 182], [216, 192, 140], [200, 170, 120], [232, 214, 170]] as RGB[],
};

/** Генерирует поверхность. Размер 256×128 — достаточно для диска диаметром до ~200 px. */
export function genTexture(kind: BodyKind, w = 256, h = 128): Texture {
  const rgb = new Uint8ClampedArray(w * h * 3);
  const needCloud = kind === 'earth' || kind === 'venus';
  const cloud = needCloud ? new Uint8ClampedArray(w * h) : null;
  const water = kind === 'earth' ? new Uint8ClampedArray(w * h) : null;
  const lights = kind === 'earth' ? new Uint8ClampedArray(w * h) : null;
  const seed = { earth: 11, moon: 23, mercury: 31, venus: 41, mars: 53, jupiter: 61, saturn: 71, uranus: 83, neptune: 97, sun: 5 }[kind];
  // кратеры для лун и Меркурия
  const craters: { u: number; v: number; r: number }[] = [];
  if (kind === 'moon' || kind === 'mercury') for (let i = 0; i < 160; i++) craters.push({ u: hash(i, 1, seed), v: 0.12 + hash(i, 2, seed) * 0.76, r: 0.004 + Math.pow(hash(i, 3, seed), 3) * 0.03 });

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const lat = Math.abs(v - 0.5) * 2; // 0 — экватор, 1 — полюс
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const i = y * w + x;
      let c: RGB = [128, 128, 128];
      switch (kind) {
        case 'earth': {
          const n = fbm(u * 6, v * 3, 6, seed, 6) * 0.75 + fbm(u * 14, v * 7, 4, seed + 3, 14) * 0.25;
          const land = n > 0.53;
          if (land) {
            const e = clamp01((n - 0.53) / 0.22);
            const dry = fbm(u * 5, v * 5, 3, seed + 9, 5);
            const green: RGB = mix3([46, 104, 52], [112, 112, 62], dry);
            c = mix3(green, [150, 130, 96], smooth(0.35, 0.8, e));
            c = mix3(c, [236, 236, 232], smooth(0.78, 0.95, e) * 0.6);
            // пустыни у тропиков
            c = mix3(c, [198, 168, 110], smooth(0.45, 0.7, dry) * (1 - smooth(0.2, 0.6, lat)) * 0.45);
          } else {
            const d = clamp01((0.53 - n) / 0.3);
            c = mix3([22, 82, 160], [6, 24, 74], d);
          }
          const ice = smooth(0.82, 0.93, lat + (fbm(u * 9, v * 9, 3, seed + 4, 9) - 0.5) * 0.12);
          c = mix3(c, [244, 248, 252], ice);
          water![i] = land || ice > 0.4 ? 0 : 255;
          // огни городов — только на суше, не у полюсов
          const city = land && lat < 0.7 ? smooth(0.78, 0.9, fbm(u * 40, v * 20, 3, seed + 21, 40)) * clamp01((n - 0.55) * 8) : 0;
          lights![i] = Math.round(city * 255);
          const cl = smooth(0.5, 0.78, fbm(u * 8 + fbm(u * 3, v * 3, 3, seed + 2, 3) * 1.5, v * 5, 5, seed + 5, 8));
          cloud![i] = Math.round(cl * 235);
          break;
        }
        case 'moon':
        case 'mercury': {
          const base = kind === 'moon' ? 150 : 128;
          const n = fbm(u * 10, v * 5, 6, seed, 10);
          let g = base * (0.65 + 0.7 * n);
          if (kind === 'moon') g *= 0.72 + 0.5 * smooth(0.42, 0.6, fbm(u * 3, v * 2, 3, seed + 8, 3)); // тёмные «моря»
          for (const cr of craters) {
            let du = Math.abs(u - cr.u);
            if (du > 0.5) du = 1 - du;
            const d = Math.hypot(du * 2, v - cr.v) / (cr.r * 1.6);
            if (d < 1.3) g *= d < 0.85 ? 0.82 : d < 1.05 ? 1.28 : 1;
          }
          c = kind === 'moon' ? [g, g * 0.98, g * 0.94] : [g * 1.02, g * 0.96, g * 0.9];
          break;
        }
        case 'venus': {
          const w2 = fbm(u * 4, v * 6, 4, seed, 4);
          const n = fbm(u * 5 + w2 * 2.2, v * 9 + w2, 5, seed + 3, 5);
          c = mix3([218, 182, 118], [248, 232, 190], n);
          cloud![i] = Math.round(smooth(0.45, 0.8, n) * 120);
          break;
        }
        case 'mars': {
          const n = fbm(u * 7, v * 4, 6, seed, 7);
          const dark = smooth(0.52, 0.66, fbm(u * 4 + 3, v * 3, 4, seed + 6, 4));
          c = mix3([196, 98, 58], [226, 150, 98], n);
          c = mix3(c, [96, 56, 46], dark * 0.7);
          c = mix3(c, [244, 240, 238], smooth(0.9, 0.97, lat + (n - 0.5) * 0.06));
          break;
        }
        case 'jupiter':
        case 'saturn': {
          const pal = kind === 'jupiter' ? PAL.jupiter : PAL.saturn;
          const bands = kind === 'jupiter' ? 14 : 10;
          const turb = fbm(u * 6, v * 22, 5, seed, 6);
          const t = v * bands + (turb - 0.5) * (kind === 'jupiter' ? 1.9 : 0.8);
          const k = ((Math.floor(t) % pal.length) + pal.length) % pal.length;
          const k2 = (k + 1) % pal.length;
          c = mix3(pal[k]!, pal[k2]!, smooth(0, 1, t - Math.floor(t)));
          const fine = fbm(u * 30, v * 60, 3, seed + 1, 30);
          c = mix3(c, [c[0] * 0.8, c[1] * 0.78, c[2] * 0.75], (fine - 0.5) * (kind === 'jupiter' ? 1.2 : 0.6) + 0.1);
          if (kind === 'jupiter') {
            // Большое красное пятно
            let du = Math.abs(u - 0.32);
            if (du > 0.5) du = 1 - du;
            const d = Math.hypot(du / 0.07, (v - 0.64) / 0.045);
            if (d < 1.25) c = mix3(c, [188, 84, 58], smooth(1.25, 0.6, d) * 0.9);
          }
          c = mix3(c, kind === 'saturn' ? [210, 196, 160] : [200, 180, 150], smooth(0.8, 1, lat) * 0.5);
          break;
        }
        case 'uranus': {
          const n = fbm(u * 3, v * 12, 3, seed, 3);
          c = mix3([146, 218, 226], [176, 236, 238], v * 0.5 + n * 0.3);
          break;
        }
        case 'neptune': {
          const n = fbm(u * 5, v * 14, 4, seed, 5);
          c = mix3([36, 70, 214], [72, 120, 240], n);
          const streak = smooth(0.7, 0.8, fbm(u * 10, v * 30, 3, seed + 4, 10));
          c = mix3(c, [210, 226, 255], streak * 0.35);
          let du = Math.abs(u - 0.6);
          if (du > 0.5) du = 1 - du;
          c = mix3(c, [18, 30, 110], smooth(1, 0.5, Math.hypot(du / 0.08, (v - 0.55) / 0.07)) * 0.7);
          break;
        }
        case 'sun': {
          const gran = fbm(u * 40, v * 20, 4, seed, 40);
          const big = fbm(u * 8, v * 4, 4, seed + 2, 8);
          const t = clamp01(0.64 + (gran - 0.5) * 0.62 + (big - 0.5) * 0.4);
          c = mix3([232, 120, 24], [255, 238, 150], t);
          const spot = smooth(0.7, 0.78, fbm(u * 6, v * 5, 3, seed + 9, 6)) * (1 - smooth(0.3, 0.45, lat));
          c = mix3(c, [90, 30, 8], spot * 0.8);
          break;
        }
      }
      rgb[i * 3] = c[0];
      rgb[i * 3 + 1] = c[1];
      rgb[i * 3 + 2] = c[2];
    }
  }
  return { w, h, rgb, cloud, water, lights };
}

/** Билинейная выборка (замкнутая по u). Возвращает индекс-доли для переиспользования в вычислении цвета. */
export function sampleRGB(t: Texture, u: number, v: number, out: [number, number, number]): void {
  const x = ((u % 1) + 1) % 1 * t.w, y = clamp01(v) * (t.h - 1);
  const x0 = Math.floor(x) % t.w, x1 = (x0 + 1) % t.w, y0 = Math.floor(y), y1 = Math.min(t.h - 1, y0 + 1);
  const fx = x - Math.floor(x), fy = y - y0;
  for (let k = 0; k < 3; k++) {
    const a = t.rgb[(y0 * t.w + x0) * 3 + k]!, b = t.rgb[(y0 * t.w + x1) * 3 + k]!;
    const c = t.rgb[(y1 * t.w + x0) * 3 + k]!, d = t.rgb[(y1 * t.w + x1) * 3 + k]!;
    out[k] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
}
export function sampleChannel(ch: Uint8ClampedArray, w: number, h: number, u: number, v: number): number {
  const x = (((u % 1) + 1) % 1) * w, y = clamp01(v) * (h - 1);
  const x0 = Math.floor(x) % w, x1 = (x0 + 1) % w, y0 = Math.floor(y), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - Math.floor(x), fy = y - y0;
  const a = ch[y0 * w + x0]!, b = ch[y0 * w + x1]!, c = ch[y1 * w + x0]!, d = ch[y1 * w + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export interface SphereGeom {
  r: number;
  size: number;
  /** для каждого пикселя внутри диска: индекс, nx, ny, nz, u0, v */
  px: Float32Array;
  n: number;
}

/** Геометрия диска-шара: нормали и координаты текстуры считаются один раз. */
export function makeSphereGeom(r: number, tilt = 0): SphereGeom {
  const size = Math.ceil(r * 2 + 4);
  const c = size / 2;
  const list: number[] = [];
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - c) / r, ny = (y + 0.5 - c) / r;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      // наклон оси вращения (Сатурн, Уран)
      const rx = nx * ct + ny * st, ry = -nx * st + ny * ct;
      const lon = Math.atan2(rx, nz);
      const lat = Math.asin(Math.max(-1, Math.min(1, -ry)));
      list.push(y * size + x, nx, ny, nz, lon / (Math.PI * 2) + 0.5, 0.5 - lat / Math.PI);
    }
  }
  return { r, size, px: Float32Array.from(list), n: list.length / 6 };
}

export interface ShadeOpts {
  /** направление на Солнце в экранных осях (x вправо, y вниз, z к зрителю) */
  light: [number, number, number];
  spin: number;
  atmosphere?: RGB;
  emissive?: boolean;
}

/** Рисует освещённый шар с текстурой в готовый буфер RGBA. */
export function shadeSphere(g: SphereGeom, tex: Texture, o: ShadeOpts, out: Uint8ClampedArray): void {
  const L = o.light;
  const ln = Math.hypot(L[0], L[1], L[2]) || 1;
  const lx = L[0] / ln, ly = L[1] / ln, lz = L[2] / ln;
  const col: [number, number, number] = [0, 0, 0];
  out.fill(0);
  for (let k = 0; k < g.n; k++) {
    const b = k * 6;
    const idx = g.px[b]!, nx = g.px[b + 1]!, ny = g.px[b + 2]!, nz = g.px[b + 3]!, u0 = g.px[b + 4]!, v = g.px[b + 5]!;
    const u = u0 + o.spin;
    sampleRGB(tex, u, v, col);
    let r = col[0], gg = col[1], bb = col[2];
    const dot = nx * lx + ny * ly + nz * lz;
    if (o.emissive) {
      const limb = 0.45 + 0.55 * Math.pow(nz, 0.55); // потемнение к краю диска
      r *= limb * 1.05;
      gg *= limb;
      bb *= limb * 0.9;
    } else {
      const day = smooth(-0.08, 0.28, dot);
      let light = 0.02 + 0.98 * day * (0.35 + 0.65 * Math.max(0, dot));
      if (tex.cloud) {
        const cl = sampleChannel(tex.cloud, tex.w, tex.h, u * 1.0 + o.spin * 0.35, v) / 255;
        r = mix(r, 252, cl);
        gg = mix(gg, 252, cl);
        bb = mix(bb, 255, cl);
      }
      if (tex.water) {
        const wmask = sampleChannel(tex.water, tex.w, tex.h, u, v) / 255;
        const refl = Math.max(0, 2 * dot * nz - lz);
        const spec = Math.pow(refl, 40) * wmask * 0.7 * day;
        r += 255 * spec; gg += 255 * spec; bb += 255 * spec;
      }
      r *= light; gg *= light; bb *= light;
      if (tex.lights) {
        const night = 1 - day;
        const lv = sampleChannel(tex.lights, tex.w, tex.h, u, v) / 255 * night * night;
        r += 255 * lv * 0.95; gg += 190 * lv * 0.9; bb += 90 * lv * 0.6;
      }
      if (o.atmosphere) {
        const f = Math.pow(1 - nz, 2.6);
        const a = f * (0.15 + 0.85 * smooth(-0.3, 0.5, dot));
        r += o.atmosphere[0] * a * 1.2; gg += o.atmosphere[1] * a * 1.2; bb += o.atmosphere[2] * a * 1.2;
      }
    }
    // мягкий край диска
    const edge = Math.min(1, (1 - Math.sqrt(1 - nz * nz)) * g.r * 1.5 + 0.35);
    const p = idx * 4;
    out[p] = r;
    out[p + 1] = gg;
    out[p + 2] = bb;
    out[p + 3] = 255 * Math.min(1, edge);
  }
}

// ---------------- Млечный Путь и звёзды ----------------

export interface MilkyWayParams {
  w: number;
  h: number;
  /** угол полосы, рад */
  angle: number;
}

/** Фон галактики: свечение полосы, неоднородность, тёмные пылевые рукава. Рисуется в уменьшенном размере и растягивается. */
export function genMilkyWay(p: MilkyWayParams, out: Uint8ClampedArray): void {
  const { w, h, angle } = p;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x / h, py = y / h; // единицы высоты
      const cx = px - (w / h) * 0.5, cy = py - 0.5;
      const along = cx * ca + cy * sa; // вдоль полосы
      const across = -cx * sa + cy * ca; // поперёк
      const warp = (fbm(along * 2.2 + 3, across * 2.2, 4, 7) - 0.5) * 0.16;
      const d = (across + warp) / 0.17;
      const band = Math.exp(-d * d);
      const clump = fbm(along * 4.5, across * 4.5, 6, 13);
      const dustN = fbm(along * 7 + 9, across * 9, 5, 29);
      const dust = smooth(0.55, 0.72, dustN) * Math.exp(-(((across + warp * 0.6) / 0.11) ** 2));
      const core = Math.exp(-(((along + 0.25) / 0.55) ** 2)); // яркое ядро галактики
      let I = band * (0.28 + 0.9 * clump) * (0.55 + 0.9 * core);
      I *= 1 - 0.82 * dust;
      const halo = Math.exp(-((across / 0.5) ** 2)) * 0.07;
      const warm = clamp01(core * 0.9 + (clump - 0.5) * 0.4);
      const r = (86 + 150 * warm) * I + 18 * halo;
      const g = (100 + 105 * warm) * I + 22 * halo;
      const b = (150 + 20 * warm - 30 * warm) * I + 40 * halo;
      const i = (y * w + x) * 4;
      out[i] = r * 0.6;
      out[i + 1] = g * 0.62;
      out[i + 2] = b * 0.7;
      out[i + 3] = 255;
    }
  }
}

export interface Star {
  x: number;
  y: number;
  mag: number;
  rgb: RGB;
}

/** Звёзды с реалистичным распределением блеска (мало ярких, очень много тусклых), цветом по температуре и сгущением к Млечному Пути. */
export function genStars(count: number, w: number, h: number, angle: number): Star[] {
  const out: Star[] = [];
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let i = 0;
  while (out.length < count && i < count * 8) {
    i++;
    const x = hash(i, 1, 77) * w, y = hash(i, 2, 77) * h;
    const cx = x / h - (w / h) * 0.5, cy = y / h - 0.5;
    const across = -cx * sa + cy * ca;
    const dens = 0.35 + 0.65 * Math.exp(-((across / 0.2) ** 2));
    if (hash(i, 3, 77) > dens) continue;
    const m = Math.pow(hash(i, 4, 77), 7); // 0..1, почти всегда мало
    const t = hash(i, 5, 77);
    const rgb: RGB = t < 0.12 ? [255, 200, 150] : t < 0.3 ? [255, 238, 214] : t < 0.78 ? [236, 240, 255] : [180, 205, 255];
    out.push({ x, y, mag: m, rgb });
  }
  return out;
}

// ---------------- Луна вокруг Земли ----------------

/** Положение Луны относительно Земли на экране при виде сверху под малым углом (tilt — то же сплющивание, что у орбит планет). */
export function moonPlacement(angle: number, earthR: number, tilt = 0.25, dist = 3.1): { dx: number; dy: number; behind: boolean; scale: number } {
  const s = Math.sin(angle);
  return { dx: Math.cos(angle) * earthR * dist, dy: s * earthR * dist * tilt, behind: s < 0, scale: 1 + 0.18 * s };
}

// ---------------- Корона Солнца ----------------

/** Мягкая корона: радиальное свечение, промодулированное шумом по углу (получаются размытые «языки», а не лучи-полоски). RGBA, квадрат size×size. */
export function genCorona(size: number, out: Uint8ClampedArray): void {
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c, dy = (y + 0.5 - c) / c;
      const r = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      if (r >= 1) {
        out[i + 3] = 0;
        continue;
      }
      const ang = Math.atan2(dy, dx);
      // угловая неоднородность: плавная (низкие частоты), плюс мелкая рябь, затухающая к краю
      const lobes = fbm(Math.cos(ang) * 1.6 + 3, Math.sin(ang) * 1.6 + 3, 4, 91);
      const ripple = fbm(Math.cos(ang) * 5 + r * 3, Math.sin(ang) * 5 + r * 2, 3, 17);
      const mod = 0.45 + 1.1 * lobes + 0.3 * (ripple - 0.5) * (1 - r);
      const I = (0.75 * Math.exp(-r / 0.075) + 0.26 * Math.exp(-r / 0.28) + 0.09 * Math.pow(1 - r, 2.6) * mod) * smooth(1, 0.82, r);
      out[i] = 255;
      out[i + 1] = 170 + 60 * Math.exp(-r / 0.2);
      out[i + 2] = 90 + 110 * Math.exp(-r / 0.12);
      out[i + 3] = Math.min(255, 255 * I * (0.55 + 0.45 * mod));
    }
  }
}
