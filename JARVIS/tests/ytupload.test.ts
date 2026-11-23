import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCore } from './helpers';

const CID = 'abcdefghij1234567890-test.apps.googleusercontent.com';
const CSEC = 'GOCSPX-testsecret1234567890';
const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };

interface Rec { url: string; method: string; headers: Headers; body: string }

function fakeGoogle(o: { channels?: 'none' | 'error'; tokenError?: string; videoPrivacy?: string; flaky?: boolean; thumbFails?: boolean; initStatus?: number } = {}) {
  const log: Rec[] = [];
  let received = 0;
  let failedOnce = false;
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const body = init.body instanceof URLSearchParams ? init.body.toString() : typeof init.body === 'string' ? init.body : init.body ? `<${(init.body as Uint8Array).byteLength} bytes>` : '';
    log.push({ url, method: String(init.method ?? 'GET'), headers: h, body });
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      if (o.tokenError) return new Response(JSON.stringify({ error: o.tokenError }), { status: 400 });
      const p = new URLSearchParams(body);
      return new Response(JSON.stringify({ access_token: `at-${p.get('grant_type')}`, refresh_token: p.get('grant_type') === 'authorization_code' ? 'rt-secret-1' : undefined, expires_in: 3600 }), { status: 200 });
    }
    if (u.pathname === '/revoke') return new Response('{}', { status: 200 });
    if (u.pathname === '/youtube/v3/channels') {
      if (o.channels === 'error') return new Response(JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }] } }), { status: 403 });
      if (o.channels === 'none') return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ items: [{ id: 'UCabcdefghijklmnopqrstuv', snippet: { title: 'Евгений Пронин и Системно', customUrl: '@evgeny-sistemno' } }] }), { status: 200 });
    }
    if (u.pathname === '/upload/youtube/v3/videos' && !u.searchParams.get('upload_id')) {
      if (o.initStatus) return new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } }), { status: o.initStatus });
      return new Response('{}', { status: 200, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=UP1' } });
    }
    if (u.searchParams.get('upload_id') === 'UP1') {
      const range = h.get('content-range') ?? '';
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      if (range.startsWith('bytes */')) return new Response('', { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
      if (o.flaky && !failedOnce) {
        failedOnce = true;
        return new Response('', { status: 503 });
      }
      const end = Number(m![2]);
      received = end + 1;
      if (received >= Number(m![3])) return new Response(JSON.stringify({ id: 'VID123', status: { privacyStatus: o.videoPrivacy ?? 'private' } }), { status: 200 });
      return new Response('', { status: 308, headers: { range: `bytes=0-${end}` } });
    }
    if (u.pathname === '/upload/youtube/v3/thumbnails/set') return new Response('{}', { status: o.thumbFails ? 403 : 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, log };
}

/** «Браузер»: открывает ссылку входа и сам возвращает на адрес приложения с кодом (как это делает Google). */
function browser(mode: 'ok' | 'denied' | 'badstate' = 'ok') {
  const seen: { url: URL }[] = [];
  const openExternal = async (url: string): Promise<void> => {
    const u = new URL(url);
    seen.push({ url: u });
    const redirect = u.searchParams.get('redirect_uri')!;
    const state = u.searchParams.get('state')!;
    void (async () => {
      if (mode === 'badstate') {
        const bad = await fetch(`${redirect}/?code=evil&state=wrong`);
        expect(bad.status).toBe(404);
      }
      if (mode === 'denied') await fetch(`${redirect}/?error=access_denied&state=${state}`);
      else await fetch(`${redirect}/?code=auth-code-1&state=${state}`);
    })();
  };
  return { openExternal, seen };
}

function video(mb = 9) {
  const dir = mkdtempSync(join(tmpdir(), 'jv-ytu-'));
  const res = join(dir, 'Готово', 'Мой ролик');
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, 'Мой ролик.mp4'), Buffer.alloc(mb * 1024 * 1024, 7));
  writeFileSync(join(res, 'Обложка.png'), Buffer.alloc(2000, 1));
  return { dir, res };
}

function setup(g = fakeGoogle(), b = browser()) {
  const h = makeCore({ youtubeUploadFetch: g.f, openExternal: b.openExternal });
  return { h, g, b };
}

describe('Загрузка на YouTube', () => {
  it('Client ID/secret проверяются и хранятся в защищённом хранилище; вход через браузер с PKCE; чужой state отклоняется', async () => {
    const { h, g, b } = setup(fakeGoogle(), browser('badstate'));
    expect(() => h.core.ytUpload.saveClient('нет', CSEC)).toThrow(/googleusercontent/);
    expect(() => h.core.ytUpload.saveClient(CID, 'пробел в ключе')).toThrow(/secret/);
    h.core.ytUpload.saveClient(CID, CSEC);
    expect(h.secrets.get('youtubeUpload.clientSecret')).toBe(CSEC);
    expect(h.core.ytUpload.status()).toMatchObject({ hasClient: true, connected: false, clientId: CID });
    const links: (string | null)[] = [];
    h.core.onYtAuthUrl((u) => links.push(u));
    const st = await h.core.ytUpload.connect();
    expect(links[0]).toContain('accounts.google.com'); // ссылку можно скопировать и открыть в другом браузере
    expect(links.at(-1)).toBeNull();
    expect(st).toMatchObject({ connected: true, channel: 'Евгений Пронин и Системно', channelId: 'UCabcdefghijklmnopqrstuv', handle: '@evgeny-sistemno', channelError: null });
    expect(b.seen[0]!.url.searchParams.get('prompt')).toBe('select_account consent'); // Google спрашивает аккаунт и канал
    const au = b.seen[0]!.url;
    expect(au.origin + au.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(au.searchParams.get('code_challenge_method')).toBe('S256');
    expect(au.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(au.searchParams.get('scope')).toContain('youtube.upload');
    expect(au.searchParams.get('access_type')).toBe('offline');
    const exch = new URLSearchParams(g.log.find((r) => r.url.includes('/token'))!.body);
    expect(exch.get('code')).toBe('auth-code-1');
    expect(createHash('sha256').update(exch.get('code_verifier')!).digest('base64url')).toBe(au.searchParams.get('code_challenge'));
    expect(h.secrets.get('youtubeUpload.refresh')).toBe('rt-secret-1');
    expect(JSON.stringify(h.core.listAudit(200))).not.toMatch(/rt-secret-1|GOCSPX/);
  });

  it('канал не определён: понятная причина (нет канала / API не включён), «Проверить канал» перечитывает', async () => {
    const a = setup(fakeGoogle({ channels: 'none' }));
    a.h.core.ytUpload.saveClient(CID, CSEC);
    const s1 = await a.h.core.ytUpload.connect();
    expect(s1).toMatchObject({ connected: true, channel: null });
    expect(s1.channelError).toMatch(/нет YouTube-канала/);
    const b = setup(fakeGoogle({ channels: 'error' }));
    b.h.core.ytUpload.saveClient(CID, CSEC);
    const s2 = await b.h.core.ytUpload.connect();
    expect(s2.channelError).toMatch(/YouTube Data API v3/);
    expect((await b.h.core.ytUpload.refreshStatus(true)).channelError).toMatch(/YouTube Data API v3/);
  });

  it('отказ в окне Google и неверный клиент — понятные ошибки; отключение отзывает доступ', async () => {
    const a = setup(fakeGoogle(), browser('denied'));
    a.h.core.ytUpload.saveClient(CID, CSEC);
    await expect(a.h.core.ytUpload.connect()).rejects.toThrow(/отказали/);
    const b = setup(fakeGoogle({ tokenError: 'invalid_client' }), browser());
    b.h.core.ytUpload.saveClient(CID, CSEC);
    await expect(b.h.core.ytUpload.connect()).rejects.toThrow(/Desktop app|для ПК/);
    const c = setup();
    c.h.core.ytUpload.saveClient(CID, CSEC);
    await c.h.core.ytUpload.connect();
    expect((await c.h.core.ytUpload.disconnect()).connected).toBe(false);
    expect(c.g.log.some((r) => r.url.includes('/revoke'))).toBe(true);
    expect(c.h.secrets.has('youtubeUpload.refresh')).toBe(false);
  });

  it('загрузка по частям: закрытый доступ по умолчанию, #Shorts, теги, обложка, прогресс; сбой 503 — докачка', async () => {
    const { h, g } = setup(fakeGoogle({ flaky: true }));
    h.core.ytUpload.saveClient(CID, CSEC);
    await h.core.ytUpload.connect();
    const { res } = video(9);
    const progress: number[] = [];
    h.core.onUploadProgress((p) => progress.push(p.pct));
    const r = await h.core.ytUpload.upload({ file: join(res, 'Мой ролик.mp4'), thumbnail: join(res, 'Обложка.png'), title: 'Реакция на ролик про септики <b>', description: 'Описание', tags: ['септик', '#монтаж', 'a,b'] });
    expect(r).toMatchObject({ id: 'VID123', privacy: 'private', url: 'https://youtube.com/shorts/VID123' });
    const init = g.log.find((x) => x.url.includes('uploadType=resumable'))!;
    expect(init.headers.get('authorization')).toBe('Bearer at-authorization_code');
    expect(init.headers.get('x-upload-content-length')).toBe(String(9 * 1024 * 1024));
    const meta = JSON.parse(init.body) as { snippet: { title: string; description: string; tags: string[] }; status: { privacyStatus: string; selfDeclaredMadeForKids: boolean } };
    expect(meta.snippet.title).toBe('Реакция на ролик про септики b');
    expect(meta.snippet.description).toContain('#Shorts');
    expect(meta.snippet.tags).toEqual(['септик', 'монтаж', 'ab']);
    expect(meta.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false });
    const puts = g.log.filter((x) => x.method === 'PUT');
    expect(puts.some((p) => p.headers.get('content-range') === `bytes */${9 * 1024 * 1024}`)).toBe(true); // спросили, сколько принято
    expect(puts.some((p) => p.headers.get('content-range') === `bytes ${8 * 1024 * 1024}-${9 * 1024 * 1024 - 1}/${9 * 1024 * 1024}`)).toBe(true);
    expect(g.log.some((x) => x.url.includes('thumbnails/set?videoId=VID123'))).toBe(true);
    expect(progress.at(-1)).toBe(100);
    expect(h.core.youtubeStatus().usedToday).toBe(1650); // 1600 за ролик + 50 за обложку
  });

  it('просьба «открытый» при проекте без аудита: YouTube оставил закрытым — честное предупреждение; обложка отклонена — не ошибка; квота и ошибки API', async () => {
    const { h } = setup(fakeGoogle({ videoPrivacy: 'private', thumbFails: true }));
    h.core.ytUpload.saveClient(CID, CSEC);
    await h.core.ytUpload.connect();
    const { res } = video(1);
    const r = await h.core.ytUpload.upload({ file: join(res, 'Мой ролик.mp4'), thumbnail: join(res, 'Обложка.png'), title: 'T', privacy: 'public' });
    expect(r.warnings.join(' ')).toMatch(/закрытым.*аудит|аудит/);
    expect(r.warnings.join(' ')).toMatch(/Обложку/);
    const q = setup(fakeGoogle({ initStatus: 403 }));
    q.h.core.ytUpload.saveClient(CID, CSEC);
    await q.h.core.ytUpload.connect();
    await expect(q.h.core.ytUpload.upload({ file: join(video(1).res, 'Мой ролик.mp4'), title: 'T' })).rejects.toThrow(/квота/i);
    await expect(q.h.core.ytUpload.upload({ file: '/нет/файла.mp4', title: 'T' })).rejects.toThrow(/не найден/);
    await expect(q.h.core.ytUpload.upload({ file: join(video(1).res, 'Мой ролик.mp4'), title: '   ' })).rejects.toThrow(/название/);
    // суточный предел Google: 9500 единиц
    h.core.youtubeStatus();
    for (let i = 0; i < 4; i++) h.core.youtube.spendHard(1600);
    expect(() => h.core.youtube.spendHard(1600)).toThrow(/квота/i);
  });

  it('инструмент ассистента: высокий риск (каждый раз подтверждение), по названию папки результата; без подключения — понятная ошибка', async () => {
    const { h } = setup();
    const t = h.core.tools.list().find((x) => x.name === 'video_youtube_upload')!;
    expect(t.risk).toBe('high');
    expect(t.mutates).toBe(true);
    const { dir } = video(1);
    h.core.video.setFolder(dir);
    await expect(Promise.resolve().then(() => h.core.tools.get('video_youtube_upload')!.execute({ video: 'Мой ролик', title: 'T' }, ctx))).rejects.toThrow(/не подключён/);
    h.core.ytUpload.saveClient(CID, CSEC);
    await h.core.ytUpload.connect();
    const out = String(await h.core.tools.get('video_youtube_upload')!.execute({ video: 'ролик', title: 'Заголовок', tags: ['а'] }, ctx));
    expect(out).toContain('youtube.com/shorts/VID123');
    expect(out).toContain('канал «Евгений Пронин и Системно»');
    expect(out).toContain('закрытый');
    await expect(Promise.resolve().then(() => h.core.tools.get('video_youtube_upload')!.execute({ video: 'нет такого', title: 'T' }, ctx))).rejects.toThrow(/нет готового ролика/);
  });
});
