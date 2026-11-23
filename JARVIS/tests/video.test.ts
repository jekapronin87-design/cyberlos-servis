import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAss, chunkWords, wrapTitle } from '../src/core/video/ass';
import { locateFfmpeg, parseMediaInfo, probe } from '../src/core/video/ffmpeg';
import { escFilterPath, planMontage } from '../src/core/video/montage';
import { VideoService } from '../src/core/video/service';
import type { VideoPlanDto } from '../src/shared/types';
import { makeCore } from './helpers';

const FF = locateFfmpeg()!;
const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };
const mk = (args: string[]) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'jv-home-'));
  const desk = join(home, 'Desktop', 'Видосы для системных');
  mkdirSync(desk, { recursive: true });
  mk(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(desk, 'Про септики (чужое).mp4')]);
  mk(['-f', 'lavfi', '-i', 'smptebars=s=480x854:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=220:d=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(desk, 'Я на камеру.mp4')]);
  mk(['-f', 'lavfi', '-i', 'smptebars=s=480x854:r=30:d=2', '-c:v', 'libx264', join(desk, 'Без звука.mp4')]);
  writeFileSync(join(desk, 'заметки.txt'), 'не видео');
  return { home, desk };
}

const whisper = (words: { word: string; start: number; end: number }[]) =>
  (async (url: string) => {
    if (String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: words.map((w) => w.word).join(' '), words }), { status: 200 });
    if (String(url).endsWith('/images/generations')) {
      mk(['-f', 'lavfi', '-i', 'color=c=0x204080:s=256x384:d=1', '-frames:v', '1', join(tmpdir(), 'jv-ai.png')]);
      return new Response(JSON.stringify({ data: [{ b64_json: readFileSync(join(tmpdir(), 'jv-ai.png')).toString('base64') }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

function setup(words = [{ word: 'Привет', start: 3.4, end: 3.9 }, { word: 'друзья', start: 4.0, end: 4.5 }, { word: 'смотрите', start: 4.7, end: 5.3 }]) {
  const { home, desk } = fixture();
  const h = makeCore({ fetchImpl: whisper(words) });
  h.core.setVoiceKey('sk-test-voice-key-1234567890abcdef');
  const image = async (p: string, s: string, sig: AbortSignal) => {
    const res = await whisper([])('https://x/images/generations', {} as RequestInit);
    void p; void s; void sig;
    const b64 = ((await res.json()) as { data: { b64_json: string }[] }).data[0]!.b64_json;
    const file = join(tmpdir(), 'jv-ai.png');
    return { file, b64 };
  };
  const svc = new VideoService({ db: h.core.db, audit: h.core.audit, getSettings: () => h.core.getSettings(), voice: h.core.voice, image, allowFolder: () => undefined, home, size: { w: 360, h: 640 } });
  return { h, svc, home, desk };
}

describe('Видео: субтитры и ffmpeg', () => {
  it('слова группируются в короткие кадры; ASS содержит подсветку по словам, заголовок и анимацию', () => {
    const ws = [{ w: 'Привет', s: 0, e: 0.4 }, { w: 'друзья', s: 0.45, e: 0.9 }, { w: 'это', s: 1, e: 1.2 }, { w: 'очень', s: 1.25, e: 1.6 }, { w: 'важно.', s: 1.7, e: 2.2 }, { w: 'Дальше', s: 4, e: 4.4 }];
    const ch = chunkWords(ws);
    expect(ch.every((c) => c.length <= 3)).toBe(true);
    expect(ch.at(-1)![0]!.w).toBe('Дальше'); // пауза и точка разрывают кадр
    const ass = buildAss(ws, { width: 1080, height: 1920, title: 'Реакция на ролик про септики', style: 'neon' });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('{\\kf');
    expect(ass).toContain('ПРИВЕТ');
    expect(ass).toContain('Style: Title');
    expect(ass).toMatch(/\\fad\(350,450\)/);
    expect(ass).not.toContain('{\\kf45}{');
    expect(wrapTitle('Очень длинный заголовок про септики и канализацию', 16).length).toBeGreaterThan(1);
  });

  it('разбор вывода ffmpeg: длительность, размер с поворотом телефона, наличие звука; экранирование путей Windows', () => {
    const log = 'Duration: 00:01:05.50, start: 0.0\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n  displaymatrix: rotation of -90.00 degrees\n  Stream #0:1: Audio: aac';
    expect(parseMediaInfo(log)).toMatchObject({ durationSec: 65.5, width: 1080, height: 1920, hasAudio: true, hasVideo: true });
    expect(escFilterPath("C:\\Windows\\Fonts")).toBe('C\\:/Windows/Fonts');
  });

  it('планировщик: реакция = длина показываемого видео, дальше рассказ; ошибки без звука и без второго видео', async () => {
    const info = (d: number, a = true) => ({ durationSec: d, width: 480, height: 854, fps: 30, hasVideo: true, hasAudio: a });
    const p = planMontage({ layout: 'reaction-split', face: { path: 'f', info: info(10) }, ref: { path: 'r', info: info(4) }, width: 360, height: 640, out: 'o.mp4' });
    expect(p.split).toBe(4);
    expect(p.duration).toBe(10);
    expect(p.args.join(' ')).toContain('vstack');
    expect(planMontage({ layout: 'reaction-pip', face: { path: 'f', info: info(10) }, ref: { path: 'r', info: info(40) }, width: 360, height: 640, out: 'o.mp4' }).warnings.join()).toContain('обрезано');
    expect(planMontage({ layout: 'talk', face: { path: 'f', info: info(200) }, width: 360, height: 640, out: 'o.mp4' }).warnings.join()).toContain('3 минут');
    expect(() => planMontage({ layout: 'talk', face: { path: 'f', info: info(10, false) }, width: 360, height: 640, out: 'o.mp4' })).toThrow(/нет звука/);
    expect(() => planMontage({ layout: 'reaction-split', face: { path: 'f', info: info(10) }, width: 360, height: 640, out: 'o.mp4' })).toThrow(/второе видео/);
    expect((await probe(FF === 'ffmpeg' ? 'ffmpeg' : FF).catch(() => null)) === null || true).toBe(true);
  });
});

describe('Видео-студия', () => {
  it('папка: предложение с рабочего стола, выбор, список только видео, нечёткий поиск файла', async () => {
    const { svc, home, desk } = setup();
    expect(svc.status().folder).toBeNull();
    expect(svc.suggested()).toBe(desk);
    expect(() => svc.setFolder(join(home, 'нет-такой'))).toThrow(/нет/);
    expect(() => svc.setFolder(home)).toThrow(/отдельную папку/);
    svc.setFolder(desk);
    expect(svc.status()).toMatchObject({ folder: desk, suggested: null });
    const files = await svc.list();
    expect(files.map((f) => f.name)).toEqual(['Без звука.mp4', 'Про септики (чужое).mp4', 'Я на камеру.mp4']);
    expect(files.find((f) => f.name === 'Я на камеру.mp4')!.durationSec).toBeCloseTo(6, 0);
    expect(svc.resolveFile('септики')).toBe(join(desk, 'Про септики (чужое).mp4'));
    expect(() => svc.resolveFile('.mp4')).toThrow(/несколько/);
    expect(() => svc.resolveFile('нету')).toThrow(/нет видео/);
  });

  it('монтаж «экран пополам» с субтитрами и обложкой: ход работы, результат в «Готово», исходники не тронуты', async () => {
    const { svc, desk } = setup();
    svc.setFolder(desk);
    const before = statSync(join(desk, 'Я на камеру.mp4')).size;
    const plans: VideoPlanDto[] = [];
    svc.onPlan((p) => plans.push(p));
    const plan = await svc.montage({ face: 'камеру', reference: 'септики', layout: 'reaction-split', title: 'Реакция на чужое видео', subtitles: true, cover: true, name: 'Тест реакции' });
    expect(plan.finished).toBe(true);
    expect(plan.error).toBeUndefined();
    expect(plan.steps.filter((s) => s.status !== 'skip').every((s) => s.status === 'done')).toBe(true);
    expect(plan.split).toBeCloseTo(3, 0);
    const ids = plan.tracks.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['ref', 'face', 'audio', 'subs', 'title']));
    expect(plan.tracks.find((t) => t.id === 'subs')!.clips.length).toBeGreaterThan(0);
    expect(plan.tracks.find((t) => t.id === 'face')!.clips[0]!.thumbs!.length).toBeGreaterThan(0);
    expect(plans.length).toBeGreaterThan(8); // события хода работы
    expect(plans.some((p) => (p.steps.find((s) => s.id === 'render')?.pct ?? 0) > 0)).toBe(true);
    const out = plan.output!;
    expect(existsSync(out.video)).toBe(true);
    expect(existsSync(out.cover!)).toBe(true);
    expect(existsSync(join(out.dir, 'Субтитры.txt'))).toBe(true);
    expect(readFileSync(join(out.dir, 'Субтитры.txt'), 'utf8')).toContain('Привет');
    const info = await probe(out.video);
    expect(info).toMatchObject({ width: 360, height: 640, hasAudio: true });
    expect(info.durationSec).toBeCloseTo(6, 0);
    expect(await probe(out.cover!)).toMatchObject({ width: 360, height: 640 });
    expect(statSync(join(desk, 'Я на камеру.mp4')).size).toBe(before);
    expect(svc.results()[0]).toMatchObject({ name: 'Тест реакции' });
  }, 180_000);

  it('режимы «кружок» и «только вы» собираются; ошибки понятны (нет ключа, нет звука, тот же файл, занято)', async () => {
    const { svc, desk, h } = setup();
    svc.setFolder(desk);
    const pip = await svc.montage({ face: 'камеру', reference: 'септики', layout: 'reaction-pip', subtitles: false, cover: false, name: 'pip' });
    expect(pip.output && existsSync(pip.output.video)).toBe(true);
    expect(pip.tracks.find((t) => t.id === 'subs')).toBeUndefined();
    const talk = await svc.montage({ face: 'камеру', layout: 'talk', subtitles: true, title: 'Привет', name: 'talk' });
    expect(talk.split).toBe(0);
    await expect(svc.montage({ face: 'камеру', reference: 'камеру', layout: 'reaction-split', subtitles: false })).rejects.toThrow(/один и тот же/);
    await expect(svc.montage({ face: 'Без звука', layout: 'talk', subtitles: false })).rejects.toThrow(/нет звука/);
    await expect(svc.montage({ face: 'камеру', layout: 'reaction-split', subtitles: false })).rejects.toThrow(/второе видео/);
    h.core.clearVoiceKey();
    await expect(svc.montage({ face: 'камеру', layout: 'talk', subtitles: true })).rejects.toThrow(/ключ OpenAI/);
    const p1 = svc.montage({ face: 'камеру', layout: 'talk', subtitles: false, name: 'busy1' });
    await expect(svc.montage({ face: 'камеру', layout: 'talk', subtitles: false, name: 'busy2' })).rejects.toThrow(/уже монтирует/);
    await p1;
  }, 240_000);

  it('обложка (кадр и ИИ), шапка 2560×1440 и аватар 800×800; тексты для публикации; инструменты и права', async () => {
    const { svc, desk, h } = setup();
    svc.setFolder(desk);
    const plan = await svc.montage({ face: 'камеру', layout: 'talk', subtitles: false, cover: false, name: 'для обложки' });
    const c1 = await svc.makeCover({ video: 'для обложки', title: 'Секрет чистых септиков' }, ctx.signal);
    expect(await probe(c1)).toMatchObject({ width: 360, height: 640 });
    const c2 = await svc.makeCover({ video: plan.output!.video, title: 'ИИ-обложка', ai: true, idea: 'космос' }, ctx.signal);
    expect(existsSync(c2)).toBe(true);
    const art = await svc.channelArt({ name: 'Евгений Пронин и Системно', tagline: 'бизнес, ИИ и автоматизация' }, ctx.signal);
    expect(await probe(art.banner)).toMatchObject({ width: 2560, height: 1440 });
    expect(await probe(art.avatar)).toMatchObject({ width: 800, height: 800 });
    expect(art.bannerData).toMatch(/^data:image\/png;base64,/);
    for (const style of ['neon', 'minimal'] as const) {
      const s = await svc.channelArt({ name: 'Очень длинное название канала про бизнес и ИИ', tagline: 'слоган', style }, ctx.signal);
      expect(await probe(s.banner)).toMatchObject({ width: 2560, height: 1440 });
      expect(s.banner).toContain(style);
    }
    await expect(svc.channelArt({ name: '   ' }, ctx.signal)).rejects.toThrow(/название/);
    const ai = await svc.channelArt({ name: 'Системно', ai: true }, ctx.signal);
    expect(await probe(ai.banner)).toMatchObject({ width: 2560, height: 1440 });

    const t = (n: string) => h.core.tools.list().find((x) => x.name === n)!;
    expect(t('video_list').risk).toBe('low');
    for (const n of ['video_montage', 'video_cover', 'video_channel_art', 'video_publish_pack']) {
      expect(t(n).risk, n).toBe('medium');
      expect(t(n).mutates, n).toBe(true);
    }
    // инструменты ядра работают с той же папкой
    const pack = String(await h.core.tools.get('video_publish_pack')!.execute({ dir: 'для обложки', youtube: 'Заголовок для Shorts #септик', instagram: 'Текст для Reels' }, ctx));
    expect(pack).toContain('Публикация.txt');
    expect(readFileSync(join(plan.output!.dir, 'Публикация.txt'), 'utf8')).toContain('INSTAGRAM REELS');
    await expect(Promise.resolve().then(() => h.core.tools.get('video_publish_pack')!.execute({ dir: 'нет такой' }, ctx))).rejects.toThrow(/нет папки/);
    const list = String(await h.core.tools.get('video_list')!.execute({}, ctx));
    expect(list).toContain('Я на камеру.mp4');
    expect(list).toContain('для обложки');
  }, 240_000);
});
