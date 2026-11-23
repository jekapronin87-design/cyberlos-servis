import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Settings, VideoFileDto, VideoPlanDto, VideoResultDto, VideoSpecDto, VideoStatusDto, VideoStepDto, VideoTrackDto } from '../../shared/types';
import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import type { ToolRegistry } from '../tools/registry';
import type { VoiceService } from '../voice/service';
import { buildAss, buildCoverAss, chunkWords, defaultFont, fitSize, wrapTitle, type Word } from './ass';
import { locateFfmpeg, probe, runFfmpeg, type MediaInfo } from './ffmpeg';
import { planMontage } from './montage';

const EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|wmv)$/i;
export const DONE_DIR = 'Готово';
export const ART_DIR = 'Оформление канала';
export const SUGGESTED_NAME = 'Видосы для системных';

export interface ImageMaker {
  (prompt: string, size: string, signal: AbortSignal): Promise<{ file: string; b64: string }>;
}

interface Deps {
  db: Db;
  audit: AuditLog;
  getSettings: () => Settings;
  voice: VoiceService;
  /** Платная генерация картинки (для обложки и оформления канала). */
  image: ImageMaker;
  /** Добавить папку в разрешённые (после выбора пользователем). */
  allowFolder: (path: string) => void;
  home?: string;
  /** Подмена пути к ffmpeg (тесты). */
  ffmpegBin?: string;
  /** Размер кадра результата (по умолчанию вертикальный 1080×1920; в тестах меньше — быстрее). */
  size?: { w: number; h: number };
}

const slug = (s: string): string => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'ролик';
const stamp = (): string => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');

/**
 * Видео-студия: берёт исходники из выбранной пользователем папки, монтирует (разговор / реакция «экран пополам» / «кружок»), делает субтитры,
 * обложку и оформление канала. Результат кладёт в подпапку «Готово». Исходники не меняются. Ход работы показывается на «монтажном столе» в интерфейсе.
 */
export class VideoService {
  private listeners = new Set<(p: VideoPlanDto) => void>();
  private busy = false;
  private thumbCache = new Map<string, string>();
  private ctl: AbortController | null = null;

  constructor(private d: Deps) {}

  onPlan(cb: (p: VideoPlanDto) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(p: VideoPlanDto): void {
    for (const l of this.listeners) l(structuredClone(p));
  }

  private bin(): string {
    return this.d.ffmpegBin ?? locateFfmpeg() ?? 'ffmpeg';
  }

  // ---------- папка ----------
  private read(): string | null {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get('video.folder') as { value: string } | undefined;
    if (!r) return null;
    try {
      const v = JSON.parse(r.value) as string;
      return v && existsSync(v) ? v : null;
    } catch {
      return null;
    }
  }

  folder(): string | null {
    return this.read();
  }

  setFolder(path: string): string {
    const p = resolve(path);
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('Такой папки нет.');
    if (resolve(p) === resolve(this.d.home ?? homedir())) throw new Error('Выберите отдельную папку для видео, не всю домашнюю папку.');
    this.d.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run('video.folder', JSON.stringify(p), nowIso());
    this.d.allowFolder(p);
    this.d.audit.record({ actor: 'user', action: 'video.folder_set', decision: 'info', details: { folder: p } });
    return p;
  }

  suggested(): string | null {
    const home = this.d.home ?? homedir();
    for (const base of [join(home, 'Desktop'), join(home, 'Рабочий стол'), join(home, 'OneDrive', 'Desktop'), join(home, 'OneDrive', 'Рабочий стол')]) {
      const c = join(base, SUGGESTED_NAME);
      if (existsSync(c)) return c;
    }
    return null;
  }

  status(): VideoStatusDto {
    const bin = this.bin();
    return { folder: this.folder(), suggested: this.folder() ? null : this.suggested(), ffmpeg: bin !== 'ffmpeg' || existsSync('/usr/bin/ffmpeg') || this.ffmpegOnPath(), hasVoiceKey: this.d.voice.hasKey(), busy: this.busy };
  }
  private ffmpegOnPath(): boolean {
    return (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':').some((p) => existsSync(join(p, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')));
  }

  private need(): string {
    const f = this.folder();
    if (!f) throw new Error(`Папка с видео не выбрана. Откройте раздел «Студия» и выберите папку (например, «${SUGGESTED_NAME}» на рабочем столе).`);
    return f;
  }

  async list(withThumbs = false): Promise<VideoFileDto[]> {
    const dir = this.need();
    const out: VideoFileDto[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !EXT.test(e.name)) continue;
      const full = join(dir, e.name);
      const st = statSync(full);
      let dur: number | null = null;
      try {
        dur = (await probe(full, this.bin())).durationSec || null;
      } catch {
        dur = null;
      }
      out.push({ name: e.name, sizeMb: Math.round((st.size / 1048576) * 10) / 10, durationSec: dur ? Math.round(dur * 10) / 10 : null, thumb: withThumbs ? await this.thumb(full).catch(() => null) : null });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  results(): VideoResultDto[] {
    const dir = this.folder();
    if (!dir) return [];
    const root = join(dir, DONE_DIR);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const d = join(root, e.name);
        const files = readdirSync(d);
        const v = files.find((f) => /\.mp4$/i.test(f));
        const c = files.find((f) => /^обложка\.(png|jpg)$/i.test(f));
        return { name: e.name, dir: d, video: v ? join(d, v) : null, cover: c ? join(d, c) : null, t: statSync(d).mtimeMs };
      })
      .sort((a, b) => b.t - a.t)
      .map(({ t: _t, ...r }) => r);
  }

  /** Находит файл в папке по точному имени или части названия (без учёта регистра); неоднозначность — понятная ошибка. */
  resolveFile(ref: string): string {
    const dir = this.need();
    const q = ref.trim().toLowerCase();
    if (!q) throw new Error('Не указан файл.');
    const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && EXT.test(e.name)).map((e) => e.name);
    const exact = names.find((n) => n.toLowerCase() === q);
    if (exact) return join(dir, exact);
    const part = names.filter((n) => n.toLowerCase().includes(q.replace(/\.[a-z0-9]+$/, '')));
    if (part.length === 1) return join(dir, part[0]!);
    if (part.length > 1) throw new Error(`Под «${ref}» подходит несколько файлов: ${part.slice(0, 6).join(', ')}. Уточните название.`);
    throw new Error(`В папке нет видео «${ref}». Есть: ${names.slice(0, 8).join(', ') || 'пусто'}.`);
  }

  private async thumb(file: string): Promise<string | null> {
    if (this.thumbCache.has(file)) return this.thumbCache.get(file)!;
    const tmp = mkdtempSync(join(tmpdir(), 'jv-th-'));
    try {
      await runFfmpeg(['-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=220:-2', join(tmp, 't.jpg')], { bin: this.bin() });
      const data = `data:image/jpeg;base64,${readFileSync(join(tmp, 't.jpg')).toString('base64')}`;
      this.thumbCache.set(file, data);
      return data;
    } catch {
      return null;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Кадры для дорожки монтажного стола. */
  private async strip(file: string, dur: number, n = 6): Promise<string[]> {
    const tmp = mkdtempSync(join(tmpdir(), 'jv-st-'));
    try {
      await runFfmpeg(['-i', file, '-vf', `fps=${n}/${Math.max(1, dur).toFixed(2)},scale=140:-2`, '-frames:v', String(n), join(tmp, 's%d.jpg')], { bin: this.bin() });
      const out: string[] = [];
      for (let i = 1; i <= n; i++) {
        const p = join(tmp, `s${i}.jpg`);
        if (existsSync(p)) out.push(`data:image/jpeg;base64,${readFileSync(p).toString('base64')}`);
      }
      return out;
    } catch {
      return [];
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Монтаж по кнопке в интерфейсе (можно остановить). */
  async montageUi(spec: VideoSpecDto): Promise<VideoPlanDto> {
    this.ctl = new AbortController();
    try {
      return await this.montage(spec, this.ctl.signal);
    } finally {
      this.ctl = null;
    }
  }
  stop(): void {
    this.ctl?.abort();
  }

  /** Путь внутри папки студии? (для «Открыть в проводнике»). */
  isInside(p: string): boolean {
    const dir = this.folder();
    return !!dir && resolve(p).startsWith(resolve(dir) + sep);
  }

  // ---------- монтаж ----------
  async montage(spec: VideoSpecDto, signal?: AbortSignal): Promise<VideoPlanDto> {
    if (this.busy) throw new Error('Студия уже монтирует другой ролик. Дождитесь окончания.');
    const folder = this.need();
    const layout = spec.layout;
    if (!['talk', 'reaction-split', 'reaction-pip'].includes(layout)) throw new Error('Неизвестный режим монтажа.');
    const facePath = this.resolveFile(spec.face);
    if (layout !== 'talk' && !spec.reference?.trim()) throw new Error('Для режима с наложением нужно второе видео — то, которое вы показываете (reference).');
    const refPath = layout === 'talk' ? null : this.resolveFile(spec.reference!);
    if (refPath && refPath === facePath) throw new Error('Показываемое видео и ваше — один и тот же файл.');
    if (spec.subtitles && !this.d.voice.hasKey()) throw new Error('Для субтитров нужен ключ OpenAI (Настройки → Голос): речь расшифровывается там.');

    this.busy = true;
    const name = slug(spec.name || spec.title || `Монтаж ${stamp()}`);
    const W = this.d.size?.w ?? 1080;
    const H = this.d.size?.h ?? 1920;
    const steps: VideoStepDto[] = [
      { id: 'probe', label: 'Читаю ролики', status: 'wait' },
      { id: 'strip', label: 'Раскадровка', status: 'wait' },
      { id: 'audio', label: 'Достаю звук', status: spec.subtitles ? 'wait' : 'skip' },
      { id: 'asr', label: 'Расшифровываю речь', status: spec.subtitles ? 'wait' : 'skip' },
      { id: 'subs', label: 'Рисую субтитры', status: spec.subtitles || spec.title ? 'wait' : 'skip' },
      { id: 'render', label: 'Монтирую', status: 'wait' },
      { id: 'cover', label: 'Обложка', status: spec.cover ? 'wait' : 'skip' },
      { id: 'pack', label: 'Складываю в «Готово»', status: 'wait' },
    ];
    const plan: VideoPlanDto = { id: `v${Date.now()}`, name, layout, width: W, height: H, duration: 0, split: 0, tracks: [], steps, warnings: [], finished: false };
    const set = (id: string, status: VideoStepDto['status'], pct?: number): void => {
      const s = steps.find((x) => x.id === id)!;
      s.status = status;
      s.pct = pct;
      this.emit(plan);
    };
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-video-'));
    const bin = this.bin();
    try {
      this.emit(plan);
      set('probe', 'run');
      const face = { path: facePath, info: await probe(facePath, bin) };
      const ref = refPath ? { path: refPath, info: await probe(refPath, bin) } : undefined;
      set('probe', 'done');

      // предварительный расчёт, чтобы стол показал, что куда ляжет
      const pre = planMontage({ layout, face, ref, width: W, height: H, out: 'x.mp4' });
      plan.duration = pre.duration;
      plan.split = pre.split;
      plan.warnings.push(...pre.warnings);
      const tracks: VideoTrackDto[] = [];
      if (ref && pre.split > 0) tracks.push({ id: 'ref', label: 'Показываемое видео', kind: 'ref', clips: [{ start: 0, end: pre.split, label: ref.path.split(sep).pop()!.replace(/\.[^.]+$/, '') }] });
      const faceClips = pre.split > 0 ? [{ start: 0, end: pre.split, label: 'реакция' }, { start: pre.split, end: pre.duration, label: 'рассказ' }] : [{ start: 0, end: pre.duration, label: 'вы' }];
      tracks.push({ id: 'face', label: 'Вы', kind: 'face', clips: faceClips });
      tracks.push({ id: 'audio', label: 'Звук', kind: 'audio', clips: [{ start: 0, end: pre.duration, label: 'выровнен по громкости' }] });
      if (spec.title) tracks.push({ id: 'title', label: 'Заголовок', kind: 'title', clips: [{ start: 0.15, end: Math.min(3.2, pre.duration), label: spec.title.slice(0, 40) }] });
      plan.tracks = tracks;
      this.emit(plan);

      set('strip', 'run');
      const fs = await this.strip(face.path, face.info.durationSec);
      const fc = tracks.find((t) => t.id === 'face')!.clips;
      fc.forEach((c) => (c.thumbs = fs));
      if (ref) {
        const rs = await this.strip(ref.path, Math.min(ref.info.durationSec, pre.split || ref.info.durationSec));
        const rc = tracks.find((t) => t.id === 'ref');
        if (rc) rc.clips[0]!.thumbs = rs;
      }
      set('strip', 'done');

      // субтитры
      let words: Word[] = [];
      if (spec.subtitles) {
        set('audio', 'run');
        const audio = join(tmp, 'speech.mp3');
        await runFfmpeg(['-i', face.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio], { bin, signal });
        set('audio', 'done');
        set('asr', 'run');
        const r = await this.d.voice.transcribeWords(new Uint8Array(readFileSync(audio)), 'audio/mpeg', signal);
        words = r.words.filter((w) => w.s < pre.duration);
        if (words.length === 0) plan.warnings.push('Речь в вашем видео не распознана — субтитров не будет.');
        set('asr', 'done');
      }
      let assName: string | undefined;
      if (words.length > 0 || spec.title) {
        set('subs', 'run');
        const font = defaultFont();
        assName = 'subs.ass';
        writeFileSync(join(tmp, assName), buildAss(words, { width: W, height: H, style: spec.subStyle ?? 'bold', font: font.name, title: spec.title }), 'utf8');
        const sc = chunkWords(words).map((ch) => ({ start: ch[0]!.s, end: ch[ch.length - 1]!.e, label: ch.map((w) => w.w).join(' ') }));
        if (sc.length) plan.tracks.splice(plan.tracks.findIndex((t) => t.id === 'title') >= 0 ? plan.tracks.findIndex((t) => t.id === 'title') : plan.tracks.length, 0, { id: 'subs', label: 'Субтитры', kind: 'subs', clips: sc });
        set('subs', 'done');
      }

      // монтаж
      set('render', 'run', 0);
      const outName = `${name}.mp4`;
      const mp = planMontage({ layout, face, ref, width: W, height: H, ass: assName, fontsDir: defaultFont().dir && existsSync(defaultFont().dir!) ? defaultFont().dir : null, out: join(tmp, 'out.mp4') });
      let last = 0;
      await runFfmpeg(mp.args, {
        bin,
        cwd: tmp,
        signal,
        durationSec: mp.duration,
        onProgress: (p) => {
          if (p - last >= 0.02) {
            last = p;
            set('render', 'run', Math.round(p * 100));
          }
        },
      });
      set('render', 'done', 100);

      const outDir = join(folder, DONE_DIR, name);
      mkdirSync(outDir, { recursive: true });
      const video = join(outDir, outName);
      writeFileSync(video, readFileSync(join(tmp, 'out.mp4')));
      let cover: string | undefined;
      if (spec.cover) {
        set('cover', 'run');
        cover = join(outDir, 'Обложка.png');
        await this.coverFrom(face.path, Math.min(1.5, face.info.durationSec / 2), spec.title || name, spec.subStyle ?? 'bold', cover, W, H, tmp, signal);
        set('cover', 'done');
      }
      set('pack', 'run');
      writeFileSync(join(outDir, 'Субтитры.txt'), words.length ? chunkWords(words).map((c) => c.map((w) => w.w).join(' ')).join('\n') : '(без субтитров)', 'utf8');
      set('pack', 'done');
      plan.output = { dir: outDir, video, cover };
      plan.finished = true;
      this.emit(plan);
      this.d.audit.record({ actor: 'user', action: 'video.montage', decision: 'info', details: { layout, seconds: Math.round(mp.duration), subtitles: !!spec.subtitles, cover: !!spec.cover } });
      return plan;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      plan.error = msg;
      plan.finished = true;
      const run = steps.find((s) => s.status === 'run');
      if (run) run.status = 'error';
      this.emit(plan);
      throw e;
    } finally {
      this.busy = false;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- обложка ----------
  private async coverFrom(video: string | null, atSec: number, title: string, style: 'bold' | 'neon' | 'clean', out: string, W: number, H: number, tmp: string, signal?: AbortSignal, bgImage?: string): Promise<void> {
    const font = defaultFont();
    writeFileSync(join(tmp, 'cover.ass'), buildCoverAss({ width: W, height: H, style, font: font.name, title, kicker: undefined }), 'utf8');
    const fonts = font.dir && existsSync(font.dir) ? `:fontsdir=${font.dir.replace(/\\/g, '/').replace(/:/g, '\\:')}` : '';
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.06:saturation=1.15,drawbox=y=ih*0.36:w=iw:h=ih*0.64:color=black@0.38:t=fill,drawbox=y=ih*0.6:w=iw:h=ih*0.4:color=black@0.32:t=fill,ass=cover.ass${fonts}`;
    const input = bgImage ? ['-i', bgImage] : ['-ss', atSec.toFixed(2), '-i', video!];
    await runFfmpeg([...input, '-frames:v', '1', '-vf', vf, out], { bin: this.bin(), cwd: tmp, signal });
  }

  /** Обложка к готовому ролику: кадр из видео (или картинка от ИИ) + крупный заголовок. */
  async makeCover(args: { video: string; title: string; ai?: boolean; idea?: string; style?: 'bold' | 'neon' | 'clean' }, signal: AbortSignal): Promise<string> {
    const vid = this.resolveFileDeep(args.video);
    const dir = join(vid, '..');
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-cover-'));
    try {
      const out = join(dir, 'Обложка.png');
      let bg: string | undefined;
      if (args.ai) {
        const img = await this.d.image(`${args.idea || args.title}. Вертикальная обложка для короткого видео, яркая, контрастная, без текста и букв, место для крупного заголовка в нижней трети.`, '1024x1536', signal);
        bg = img.file;
      }
      await this.coverFrom(bg ? null : vid, 1.5, args.title, args.style ?? 'bold', out, this.d.size?.w ?? 1080, this.d.size?.h ?? 1920, tmp, signal, bg);
      this.d.audit.record({ actor: 'assistant', action: 'video.cover', decision: 'info', details: { ai: !!args.ai } });
      return out;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Готовый ролик и его обложка по названию папки результата или пути (для загрузки на YouTube). */
  resolveResult(ref: string): { video: string; cover: string | null } {
    this.need();
    const abs = resolve(ref);
    const hit = this.results().find((r) => r.video && (r.name.toLowerCase() === ref.toLowerCase() || r.video === abs)) ?? this.results().find((r) => r.video && r.name.toLowerCase().includes(ref.toLowerCase()));
    if (!hit?.video) throw new Error(`В «${DONE_DIR}» нет готового ролика «${ref}». Сначала смонтируйте его в студии.`);
    return { video: hit.video, cover: hit.cover };
  }

  /** Файл внутри папки студии (исходник или результат в «Готово»). */
  private resolveFileDeep(ref: string): string {
    const dir = this.need();
    const abs = resolve(ref);
    if (existsSync(abs) && statSync(abs).isFile() && abs.startsWith(resolve(dir) + sep)) return abs;
    const done = this.results().find((r) => r.name.toLowerCase().includes(ref.toLowerCase()) && r.video);
    if (done?.video) return done.video;
    return this.resolveFile(ref);
  }

  // ---------- оформление канала ----------
  /** Шапка 2560×1440 (текст в безопасной зоне 1546×423) и аватар 800×800. */
  async channelArt(args: { name: string; tagline?: string; ai?: boolean; idea?: string }, signal: AbortSignal): Promise<{ banner: string; avatar: string }> {
    const dir = join(this.need(), ART_DIR);
    mkdirSync(dir, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-art-'));
    const font = defaultFont();
    const fonts = font.dir && existsSync(font.dir) ? `:fontsdir=${font.dir.replace(/\\/g, '/').replace(/:/g, '\\:')}` : '';
    try {
      const W = 2560;
      const H = 1440;
      let bgInput: string[];
      let bgFilter: string;
      if (args.ai) {
        const img = await this.d.image(`${args.idea || 'космос, туманность, синие и фиолетовые огни, футуристичная технологичная атмосфера'}. Широкая шапка для YouTube-канала, без текста и букв, центр спокойный.`, '1536x1024', signal);
        bgInput = ['-i', img.file];
        bgFilter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},eq=brightness=-0.1`;
      } else {
        // процедурный «космос»: тёмный градиент, свечение туманности и звёзды
        bgInput = ['-f', 'lavfi', '-i', `color=c=0x050a1c:s=${W}x${H}:d=1,format=rgb24`];
        bgFilter = `geq=r='clip(8+90*exp(-pow((X-${W * 0.72})/${W * 0.35},2)-pow((Y-${H * 0.3})/${H * 0.45},2))+40*exp(-pow((X-${W * 0.2})/${W * 0.3},2)-pow((Y-${H * 0.8})/${H * 0.4},2))+if(gt(random(1),0.9992),230,0),0,255)':g='clip(14+70*exp(-pow((X-${W * 0.72})/${W * 0.35},2)-pow((Y-${H * 0.3})/${H * 0.45},2))+30*exp(-pow((X-${W * 0.2})/${W * 0.3},2)-pow((Y-${H * 0.8})/${H * 0.4},2))+if(gt(random(1),0.9992),230,0),0,255)':b='clip(34+170*exp(-pow((X-${W * 0.72})/${W * 0.35},2)-pow((Y-${H * 0.3})/${H * 0.45},2))+120*exp(-pow((X-${W * 0.2})/${W * 0.3},2)-pow((Y-${H * 0.8})/${H * 0.4},2))+if(gt(random(1),0.9992),230,0),0,255)'`;
      }
      const name = args.name.slice(0, 40);
      const tag = (args.tagline ?? '').slice(0, 70);
      const nameRows = wrapTitle(name, 20);
      const SAFE = 1546; // безопасная зона шапки YouTube по ширине
      const nameSize = fitSize(Math.max(...nameRows.map((r) => r.length)), SAFE, nameRows.length > 1 ? 150 : 170, 1);
      const tagSize = fitSize(tag.length || 1, SAFE, 64, 1);
      const nameText = nameRows.map((r) => r.replace(/[{}\\]/g, '').toLocaleUpperCase('ru-RU')).join('\\N');
      const ass = [
        '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'ScaledBorderAndShadow: yes', 'WrapStyle: 2', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Name,${font.name},${nameSize},&H00FFFFFF,&H00FFFFFF,&H00401808,&H64000000,${font.name === 'DejaVu Sans' ? -1 : 0},0,0,0,100,100,6,0,1,10,3,5,0,0,0,1`,
        `Style: Tag,${font.name},${tagSize},&H00FFC85C,&H00FFC85C,&H00401808,&H64000000,${font.name === 'DejaVu Sans' ? -1 : 0},0,0,0,100,100,4,0,1,5,2,5,0,0,0,1`,
        '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        `Dialogue: 1,0:00:00.00,0:00:05.00,Name,,0,0,0,,{\\pos(${W / 2},${H / 2 - (tag ? 40 : 0)})}${nameText}`,
        ...(tag ? [`Dialogue: 1,0:00:00.00,0:00:05.00,Tag,,0,0,0,,{\\pos(${W / 2},${H / 2 + nameSize * 0.55 * nameRows.length + 50})}${tag.replace(/[{}\\]/g, '').toLocaleUpperCase('ru-RU')}`] : []),
      ].join('\n');
      writeFileSync(join(tmp, 'banner.ass'), ass, 'utf8');
      const banner = join(dir, 'Шапка 2560x1440.png');
      await runFfmpeg([...bgInput, '-frames:v', '1', '-vf', `${bgFilter},ass=banner.ass${fonts}`, banner], { bin: this.bin(), cwd: tmp, signal });

      // аватар: круглая «планета» с инициалами
      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toLocaleUpperCase('ru-RU') || 'С';
      writeFileSync(
        join(tmp, 'avatar.ass'),
        ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 800', 'PlayResY: 800', '', '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          `Style: I,${font.name},330,&H00FFFFFF,&H00FFFFFF,&H00401808,&H64000000,${font.name === 'DejaVu Sans' ? -1 : 0},0,0,0,100,100,0,0,1,8,2,5,0,0,0,1`,
          '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          `Dialogue: 1,0:00:00.00,0:00:05.00,I,,0,0,0,,{\\pos(400,400)}${initials}`].join('\n'),
        'utf8',
      );
      const avatar = join(dir, 'Аватар 800x800.png');
      await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x0a1740:s=800x800:d=1,format=rgb24', '-frames:v', '1', '-vf', `geq=r='clip(10+120*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2)),0,255)':g='clip(20+160*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2)),0,255)':b='clip(60+190*exp(-pow((X-300)/330,2)-pow((Y-260)/330,2)),0,255)',ass=avatar.ass${fonts}`, avatar], { bin: this.bin(), cwd: tmp, signal });
      this.d.audit.record({ actor: 'assistant', action: 'video.channel_art', decision: 'info', details: { ai: !!args.ai } });
      return { banner, avatar };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---------- инструменты ассистента ----------
  registerTools(registry: ToolRegistry): void {
    const base = { domain: 'local', external: false } as const;

    registry.register({
      ...base,
      risk: 'low',
      mutates: false,
      name: 'video_list',
      description: 'Список видеофайлов в папке студии (папка «Видосы для системных» или выбранная пользователем) и уже готовых результатов. Начинай с него, когда просят что-то смонтировать.',
      inputSchema: { type: 'object', properties: {} },
      describe: () => 'Посмотреть видео в папке студии',
      execute: async () => {
        const files = await this.list();
        const res = this.results().slice(0, 8);
        return `Папка: ${this.folder()}\nИсходники (${files.length}):\n${files.map((f) => `• ${f.name} — ${f.durationSec ?? '?'} с, ${f.sizeMb} МБ`).join('\n') || '—'}\n\nГотовое: ${res.map((r) => r.name).join(', ') || 'пока нет'}`;
      },
    });

    registry.register<{ face: string; reference?: string; layout?: string; title?: string; subtitles?: boolean; subStyle?: string; cover?: boolean; name?: string }>({
      ...base,
      risk: 'medium',
      mutates: true,
      name: 'video_montage',
      description:
        'Монтирует вертикальный ролик 1080×1920 из файлов папки студии, показывает монтажный стол на экране. face — ВАШЕ видео (лицо/рассказ). layout: "talk" — только ваше видео; "reaction-split" — экран пополам (сверху показываемое видео, снизу вы, потом ваш рассказ на весь экран); "reaction-pip" — показываемое видео на весь экран, вы в кружке, потом ваш рассказ. ' +
        'Для реакции укажи reference — видео, которое показывают; реакция длится столько, сколько идёт показываемое видео, дальше — ваш рассказ. subtitles — красивые субтитры (речь расшифровывается в OpenAI). title — заголовок в начале. cover — сделать обложку. Файлы называй как в video_list.',
      inputSchema: {
        type: 'object',
        properties: {
          face: { type: 'string' },
          reference: { type: 'string' },
          layout: { type: 'string', enum: ['talk', 'reaction-split', 'reaction-pip'] },
          title: { type: 'string' },
          subtitles: { type: 'boolean' },
          subStyle: { type: 'string', enum: ['bold', 'neon', 'clean'] },
          cover: { type: 'boolean' },
          name: { type: 'string' },
        },
        required: ['face'],
      },
      describe: (i) => `Смонтировать ролик из «${String(i.face).slice(0, 60)}»${i.reference ? ' и «' + String(i.reference).slice(0, 60) + '»' : ''}${i.subtitles === false ? '' : ' (звук будет отправлен в OpenAI для субтитров)'}`,
      execute: async (i, ctx) => {
        const layout = (['talk', 'reaction-split', 'reaction-pip'].includes(String(i.layout)) ? i.layout : i.reference ? 'reaction-split' : 'talk') as VideoSpecDto['layout'];
        const plan = await this.montage({ face: i.face, reference: i.reference, layout, title: i.title, subtitles: i.subtitles !== false, subStyle: (['bold', 'neon', 'clean'].includes(String(i.subStyle)) ? i.subStyle : 'bold') as VideoSpecDto['subStyle'], cover: i.cover !== false, name: i.name }, ctx.signal);
        return `Ролик готов (${Math.round(plan.duration)} с): ${plan.output?.video}\n${plan.output?.cover ? 'Обложка: ' + plan.output.cover + '\n' : ''}${plan.warnings.length ? 'Замечания: ' + plan.warnings.join(' ') : ''}`;
      },
    });

    registry.register<{ video: string; title: string; ai?: boolean; idea?: string; style?: string }>({
      ...base,
      risk: 'medium',
      mutates: true,
      name: 'video_cover',
      description: 'Делает обложку (1080×1920) к готовому ролику из папки «Готово»: кадр из видео и крупный заголовок. ai=true — фон рисует нейросеть по описанию idea (платно).',
      inputSchema: { type: 'object', properties: { video: { type: 'string' }, title: { type: 'string' }, ai: { type: 'boolean' }, idea: { type: 'string' }, style: { type: 'string', enum: ['bold', 'neon', 'clean'] } }, required: ['video', 'title'] },
      describe: (i) => `Сделать обложку «${String(i.title).slice(0, 60)}»${i.ai ? ' (платный запрос к OpenAI)' : ''}`,
      execute: async (i, ctx) => `Обложка сохранена: ${await this.makeCover({ video: i.video, title: i.title, ai: i.ai === true, idea: i.idea, style: (['bold', 'neon', 'clean'].includes(String(i.style)) ? i.style : 'bold') as 'bold' }, ctx.signal)}`,
    });

    registry.register<{ name: string; tagline?: string; ai?: boolean; idea?: string }>({
      ...base,
      risk: 'medium',
      mutates: true,
      name: 'video_channel_art',
      description: 'Оформление YouTube-канала: шапка 2560×1440 (текст в безопасной зоне) и аватар 800×800 в папку «Оформление канала». ai=true — фон рисует нейросеть по описанию idea (платно); иначе рисуется космический фон.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, tagline: { type: 'string' }, ai: { type: 'boolean' }, idea: { type: 'string' } }, required: ['name'] },
      describe: (i) => `Сделать шапку и аватар канала «${String(i.name).slice(0, 40)}»${i.ai ? ' (платный запрос к OpenAI)' : ''}`,
      execute: async (i, ctx) => {
        const r = await this.channelArt({ name: i.name, tagline: i.tagline, ai: i.ai === true, idea: i.idea }, ctx.signal);
        return `Готово. Шапка: ${r.banner}\nАватар: ${r.avatar}\nЗагрузите их в YouTube Studio → Настройка канала → Брендинг.`;
      },
    });

    registry.register<{ dir: string; youtube?: string; instagram?: string }>({
      ...base,
      risk: 'medium',
      mutates: true,
      name: 'video_publish_pack',
      description: 'Сохраняет тексты для публикации (заголовок, описание, хэштеги) рядом с готовым роликом: файл «Публикация.txt». youtube — текст для YouTube Shorts, instagram — для Instagram Reels. Сам ролик в соцсети НЕ загружается — это делает владелец.',
      inputSchema: { type: 'object', properties: { dir: { type: 'string', description: 'Название папки результата в «Готово»' }, youtube: { type: 'string' }, instagram: { type: 'string' } }, required: ['dir'] },
      describe: (i) => `Сохранить тексты для публикации в «${String(i.dir).slice(0, 60)}»`,
      execute: (i) => {
        const r = this.results().find((x) => x.name.toLowerCase().includes(String(i.dir).toLowerCase()));
        if (!r) throw new Error(`В «${DONE_DIR}» нет папки «${i.dir}».`);
        const body = `YOUTUBE SHORTS\n${String(i.youtube ?? '—').slice(0, 4000)}\n\n———\nINSTAGRAM REELS\n${String(i.instagram ?? '—').slice(0, 4000)}\n`;
        writeFileSync(join(r.dir, 'Публикация.txt'), body, 'utf8');
        return `Тексты сохранены: ${join(r.dir, 'Публикация.txt')}`;
      },
    });
  }
}

export type { MediaInfo };
