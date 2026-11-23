import type { MediaInfo } from './ffmpeg';

export type Layout = 'talk' | 'reaction-split' | 'reaction-pip';

export interface MontageIn {
  layout: Layout;
  face: { path: string; info: MediaInfo };
  ref?: { path: string; info: MediaInfo };
  width: number;
  height: number;
  /** Имя файла субтитров ASS (относительное — ffmpeg запускается в его каталоге). */
  ass?: string;
  /** Подкаталог шрифтов для libass (Windows: C:/Windows/Fonts). */
  fontsDir?: string | null;
  out: string;
  /** Громкость видео с вашим лицом, пока идёт показываемое видео (0..1). */
  faceDuck?: number;
}

export interface MontagePlan {
  args: string[];
  /** Длина итогового ролика. */
  duration: number;
  /** Момент, когда «реакция» заканчивается и начинается ваш рассказ (0 — реакции нет). */
  split: number;
  warnings: string[];
}

const n2 = (v: number): string => v.toFixed(3);
/** Путь для фильтра ffmpeg: слэши прямые, двоеточие и апостроф экранируются (диск Windows «C:»). */
export function escFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Собирает команду ffmpeg для монтажа: подложка с размытием, «экран пополам» или «кружок», склейка с вашим рассказом, субтитры, выравнивание громкости. */
export function planMontage(i: MontageIn): MontagePlan {
  const W = i.width;
  const H = i.height;
  const warnings: string[] = [];
  const T = i.face.info.durationSec;
  if (!i.face.info.hasVideo || T <= 0) throw new Error('В видео с вашим лицом нет изображения или длительности.');
  if (!i.face.info.hasAudio) throw new Error('В видео с вашим лицом нет звука — субтитры и монтаж невозможны.');
  let layout = i.layout;
  let D = 0;
  if (layout !== 'talk') {
    if (!i.ref) throw new Error('Для режима с наложением нужно второе видео — то, которое вы показываете.');
    D = Math.min(i.ref.info.durationSec, T);
    if (D < 0.5) layout = 'talk';
    if (i.ref.info.durationSec > T + 0.5) warnings.push('Показываемое видео длиннее вашего — оно обрезано по длине вашей записи.');
  }
  if (layout === 'talk') D = 0;
  const duck = i.faceDuck ?? 0.22;
  const refAudio = !!i.ref?.info.hasAudio;

  const args: string[] = [];
  const f: string[] = [];
  let faceIdx = 0;
  let refIdx = -1;
  let ringIdx = -1;
  if (layout !== 'talk' && i.ref) {
    args.push('-i', i.ref.path, '-i', i.face.path);
    refIdx = 0;
    faceIdx = 1;
    if (layout === 'reaction-pip') {
      const R = Math.round(W * 0.36) + 16;
      args.push('-f', 'lavfi', '-i', `color=c=0x5cc8ff:s=${R}x${R}:r=30:d=${n2(D)}`);
      ringIdx = 2;
    }
  } else {
    args.push('-i', i.face.path);
  }

  const fill = (label: string, w: number, h: number, out: string): void => {
    f.push(`${label}fps=30,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=yuv420p${out}`);
  };
  /** Показываемое видео: целиком, поверх своей же размытой копии (не обрезается). */
  const refBox = (w: number, h: number, out: string): void => {
    f.push(`[${refIdx}:v]fps=30,trim=0:${n2(D)},setpts=PTS-STARTPTS,split=2[rb1][rb2]`);
    f.push(`[rb1]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=28,eq=brightness=-0.12:saturation=1.15,setsar=1[rbg]`);
    f.push(`[rb2]scale=${w}:${h}:force_original_aspect_ratio=decrease,setsar=1[rfg]`);
    f.push(`[rbg][rfg]overlay=(W-w)/2:(H-h)/2,format=yuv420p${out}`);
  };

  let vOut: string;
  if (layout === 'talk') {
    fill(`[${faceIdx}:v]`, W, H, '[v0]');
    vOut = '[v0]';
  } else {
    f.push(`[${faceIdx}:v]fps=30,split=2[fa][fb]`);
    // --- часть 1: пока идёт показываемое видео ---
    if (layout === 'reaction-split') {
      refBox(W, Math.floor(H / 2), '[top]');
      f.push(`[fa]trim=0:${n2(D)},setpts=PTS-STARTPTS,scale=${W}:${H - Math.floor(H / 2)}:force_original_aspect_ratio=increase,crop=${W}:${H - Math.floor(H / 2)},setsar=1,format=yuv420p[bot]`);
      f.push('[top][bot]vstack=inputs=2[seg1]');
    } else {
      const S = Math.round(W * 0.36);
      const R = S + 16;
      refBox(W, H, '[bgv]');
      f.push(`[fa]trim=0:${n2(D)},setpts=PTS-STARTPTS,scale=${S}:${S}:force_original_aspect_ratio=increase,crop=${S}:${S},format=yuva420p,geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(hypot(X-${S / 2},Y-${S / 2}),${S / 2}),255,0)'[face]`);
      f.push(`[${ringIdx}:v]format=rgba,geq=r='92':g='200':b='255':a='if(between(hypot(X-${R / 2},Y-${R / 2}),${R / 2 - 7},${R / 2 - 1}),255,0)'[ring]`);
      const x = W - R - Math.round(W * 0.05);
      const y = H - R - Math.round(H * 0.27);
      f.push(`[bgv][ring]overlay=${x}:${y}:shortest=1[t1]`);
      f.push(`[t1][face]overlay=${x + 8}:${y + 8}:shortest=1,format=yuv420p[seg1]`);
    }
    // --- часть 2: ваш рассказ на весь экран ---
    if (T - D > 0.2) {
      f.push(`[fb]trim=${n2(D)}:${n2(T)},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[seg2]`);
      f.push('[seg1][seg2]concat=n=2:v=1:a=0[v0]');
    } else {
      f.push('[seg1]null[v0]');
    }
    vOut = '[v0]';
  }
  if (i.ass) {
    f.push(`${vOut}ass=${i.ass}${i.fontsDir ? `:fontsdir=${escFilterPath(i.fontsDir)}` : ''}[v]`);
  } else {
    f.push(`${vOut}null[v]`);
  }

  // ---- звук ----
  if (layout === 'talk') {
    f.push(`[${faceIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`);
  } else {
    f.push(`[${faceIdx}:a]asplit=2[fa1][fa2]`);
    f.push(`[fa1]atrim=0:${n2(D)},asetpts=PTS-STARTPTS,volume=${refAudio ? duck : 1}[fv1]`);
    if (refAudio) {
      f.push(`[${refIdx}:a]atrim=0:${n2(D)},asetpts=PTS-STARTPTS[rv1]`);
      f.push('[rv1][fv1]amix=inputs=2:duration=longest:normalize=0[s1a]');
    } else f.push('[fv1]anull[s1a]');
    if (T - D > 0.2) {
      f.push(`[fa2]atrim=${n2(D)}:${n2(T)},asetpts=PTS-STARTPTS[s2a]`);
      f.push('[s1a][s2a]concat=n=2:v=0:a=1[am]');
    } else f.push('[s1a]anull[am]');
    f.push('[am]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]');
  }

  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', n2(T), i.out);
  if (T > 180) warnings.push('Ролик длиннее 3 минут: YouTube Shorts принимает до 3 минут, Instagram Reels — до 90 секунд.');
  else if (T > 90) warnings.push('Ролик длиннее 90 секунд: Instagram Reels принимает до 90 секунд (Shorts — до 3 минут).');
  return { args, duration: T, split: layout === 'talk' ? 0 : D, warnings };
}
