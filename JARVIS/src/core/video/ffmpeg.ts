import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Где искать ffmpeg: путь из настроек → встроенный (пакет ffmpeg-static) → установленный в системе (PATH). */
export function locateFfmpeg(custom = ''): string | null {
  if (custom && existsSync(custom)) return custom;
  try {
    const req = createRequire(typeof __filename === 'string' ? __filename : `${process.cwd()}/`);
    const p = req('ffmpeg-static') as string | null;
    if (p) {
      const fixed = p.replace('app.asar' + (p.includes('\\') ? '\\' : '/'), 'app.asar.unpacked' + (p.includes('\\') ? '\\' : '/'));
      if (existsSync(fixed)) return fixed;
      if (existsSync(p)) return p;
    }
  } catch {
    /* пакета нет — пробуем системный */
  }
  return 'ffmpeg'; // из PATH; если его нет — понятная ошибка при запуске
}

export class FfmpegError extends Error {}

export interface RunOpts {
  /** Каталог запуска (имена файлов в фильтрах — относительные, это обходит экранирование путей Windows). */
  cwd?: string;
  signal?: AbortSignal;
  /** Прогресс 0..1 по длительности результата (durationSec — ожидаемая длина). */
  onProgress?: (p: number) => void;
  durationSec?: number;
  bin?: string;
}

/** Запуск ffmpeg. Бросает FfmpegError с хвостом лога при ошибке. */
export function runFfmpeg(args: string[], o: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = o.bin ?? locateFfmpeg();
    if (!bin) return reject(new FfmpegError('Не найден ffmpeg.'));
    const full = ['-hide_banner', '-y', '-nostdin', ...(o.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
    const ps = spawn(bin, full, { cwd: o.cwd, windowsHide: true });
    let err = '';
    let out = '';
    ps.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    ps.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = [...out.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m && o.onProgress && o.durationSec) o.onProgress(Math.min(1, Number(m[1]) / 1e6 / o.durationSec));
      if (out.length > 50_000) out = out.slice(-5000);
    });
    const abort = (): void => {
      ps.kill();
    };
    o.signal?.addEventListener('abort', abort, { once: true });
    ps.on('error', (e: NodeJS.ErrnoException) => {
      o.signal?.removeEventListener('abort', abort);
      reject(new FfmpegError(e.code === 'ENOENT' ? 'Не найден ffmpeg. Выполните «npm install» в папке программы (он ставится вместе с ней) или установите ffmpeg и укажите путь в настройках.' : `Не удалось запустить ffmpeg: ${e.message}`));
    });
    ps.on('close', (code) => {
      o.signal?.removeEventListener('abort', abort);
      if (o.signal?.aborted) return reject(new FfmpegError('Остановлено.'));
      if (code === 0) return resolve(err);
      reject(new FfmpegError(`ffmpeg завершился с ошибкой (${code}): ${err.split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(0, 600)}`));
    });
  });
}

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Разбор вывода `ffmpeg -i` (без ffprobe): длительность, размер кадра с учётом поворота телефона, наличие звука. */
export function parseMediaInfo(log: string): MediaInfo {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const vline = /Stream #[^\n]*Video:[^\n]*/.exec(log)?.[0] ?? '';
  const size = /(?:,|\s)(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/.exec(vline);
  let width = size ? Number(size[1]) : 0;
  let height = size ? Number(size[2]) : 0;
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(log);
  if (rot && Math.abs(Math.round(Number(rot[1])) % 180) === 90) [width, height] = [height, width];
  const fps = Number(/(\d+(?:\.\d+)?)\s*fps/.exec(vline)?.[1] ?? 30);
  return { durationSec, width, height, fps: fps > 0 && fps < 240 ? fps : 30, hasVideo: !!vline, hasAudio: /Stream #[^\n]*Audio:/.test(log) };
}

export async function probe(file: string, bin?: string): Promise<MediaInfo> {
  const log = await new Promise<string>((resolve) => {
    const b = bin ?? locateFfmpeg() ?? 'ffmpeg';
    const ps = spawn(b, ['-hide_banner', '-i', file], { windowsHide: true });
    let e = '';
    ps.stderr.on('data', (d: Buffer) => (e += d.toString()));
    ps.on('error', () => resolve(e));
    ps.on('close', () => resolve(e));
  });
  if (/No such file|Invalid data found|does not contain/.test(log) && !/Duration:/.test(log)) throw new FfmpegError('Не удалось прочитать видео: файл повреждён или это не видео.');
  return parseMediaInfo(log);
}
