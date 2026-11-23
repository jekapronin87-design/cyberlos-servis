import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import type { SecretStore } from '../security/secrets';
import type { ToolRegistry } from '../tools/registry';

export const SECRET_YTU_CLIENT_SECRET = 'youtubeUpload.clientSecret';
export const SECRET_YTU_REFRESH = 'youtubeUpload.refresh';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMB_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const UPLOAD_COST = 1600;
export const THUMB_COST = 50;
const CHUNK = 8 * 1024 * 1024; // кратно 256 КиБ, как требует YouTube
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

export type Privacy = 'private' | 'unlisted' | 'public';

export interface YtUploadStatus {
  hasClient: boolean;
  connected: boolean;
  channel: string | null;
  clientId: string;
}

export interface YtUploadSpec {
  /** Полный путь к mp4 (внутри папки студии). */
  file: string;
  thumbnail?: string | null;
  title: string;
  description?: string;
  tags?: string[];
  privacy?: Privacy;
}

export interface YtUploadResult {
  id: string;
  url: string;
  privacy: Privacy;
  warnings: string[];
}

type Fetch = typeof fetch;
const b64url = (b: Buffer): string => b.toString('base64url');

interface Deps {
  db: Db;
  secrets: SecretStore;
  audit: AuditLog;
  fetchImpl?: Fetch;
  /** Открыть адрес в браузере пользователя (только accounts.google.com). */
  openExternal?: (url: string) => Promise<void>;
  /** Списать единицы квоты YouTube (жёсткий предел 10 000 в сутки). */
  spend: (units: number) => void;
  /** Превращает ссылку на ролик (имя из «Готово» или путь) в файлы. */
  resolveResult?: (ref: string) => { video: string; cover: string | null };
  onProgress?: (p: { pct: number; stage: string }) => void;
  now?: () => number;
}

/**
 * Загрузка роликов на YouTube от имени владельца канала (OAuth 2.0 для приложений ПК: вход в браузере, возврат на 127.0.0.1, PKCE).
 * Ключи Google хранятся в защищённом хранилище, ролики по умолчанию «Закрытые» — владелец сам открывает их в YouTube Studio.
 */
export class YoutubeUploader {
  private access: { token: string; exp: number } | null = null;
  private channelCache: string | null = null;

  constructor(private d: Deps) {}

  private f(): Fetch {
    return this.d.fetchImpl ?? fetch;
  }
  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private clientId(): string {
    const r = this.d.db.prepare('SELECT value FROM settings WHERE key = ?').get('ytu.clientId') as { value: string } | undefined;
    try {
      return r ? (JSON.parse(r.value) as string) : '';
    } catch {
      return '';
    }
  }

  status(): YtUploadStatus {
    const clientId = this.clientId();
    return { hasClient: !!clientId && this.d.secrets.has(SECRET_YTU_CLIENT_SECRET), connected: this.d.secrets.has(SECRET_YTU_REFRESH), channel: this.channelCache, clientId };
  }

  saveClient(clientId: string, clientSecret: string): YtUploadStatus {
    const id = String(clientId ?? '').trim();
    const sec = String(clientSecret ?? '').trim();
    if (!/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/.test(id)) throw new Error('Client ID должен заканчиваться на «.apps.googleusercontent.com» — скопируйте его целиком из Google Cloud (Учётные данные → ваш клиент OAuth).');
    if (sec && !/^[\w-]{10,200}$/.test(sec)) throw new Error('Client secret выглядит неверно (буквы, цифры, «-» и «_», без пробелов).');
    if (!sec && !this.d.secrets.has(SECRET_YTU_CLIENT_SECRET)) throw new Error('Вставьте Client secret.');
    this.d.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run('ytu.clientId', JSON.stringify(id), nowIso());
    if (sec) this.d.secrets.set(SECRET_YTU_CLIENT_SECRET, sec);
    this.d.secrets.delete(SECRET_YTU_REFRESH); // новый клиент — новый вход
    this.access = null;
    this.channelCache = null;
    this.d.audit.record({ actor: 'user', action: 'youtube_upload.client_saved', risk: 'high', decision: 'info' });
    return this.status();
  }

  // ---------- вход ----------
  async connect(): Promise<YtUploadStatus> {
    const clientId = this.clientId();
    const clientSecret = this.d.secrets.get(SECRET_YTU_CLIENT_SECRET);
    if (!clientId || !clientSecret) throw new Error('Сначала сохраните Client ID и Client secret.');
    if (!this.d.openExternal) throw new Error('Не удалось открыть браузер для входа.');
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const redirect = `http://127.0.0.1:${port}`;
    try {
      const url = `${AUTH_URL}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state })}`;
      const codeP = new Promise<string>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('Вход не завершён за 5 минут. Нажмите «Подключить» ещё раз.')), 300_000);
        server.on('request', (req, res) => {
          const u = new URL(req.url ?? '/', redirect);
          if (u.searchParams.get('state') !== state && !u.searchParams.has('error')) {
            res.statusCode = 404;
            return void res.end();
          }
          const err = u.searchParams.get('error');
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(`<meta charset="utf-8"><body style="font:18px sans-serif;background:#050a1c;color:#dff4ff;display:grid;place-items:center;height:100vh"><div>${err ? 'Вход отменён.' : '✓ Готово — YouTube подключён. Это окно можно закрыть и вернуться в Системно.'}</div></body>`);
          clearTimeout(to);
          if (err) reject(new Error(err === 'access_denied' ? 'Вы отказали в доступе в окне Google.' : `Google вернул ошибку: ${err.slice(0, 80)}`));
          else if (u.searchParams.get('code')) resolve(u.searchParams.get('code')!);
        });
      });
      await this.d.openExternal(url);
      const code = await codeP;
      const tok = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: clientId, client_secret: clientSecret });
      if (!tok.refresh_token) throw new Error('Google не выдал постоянный доступ. Откройте myaccount.google.com/permissions, удалите приложение и подключите заново.');
      this.d.secrets.set(SECRET_YTU_REFRESH, tok.refresh_token);
      this.access = { token: tok.access_token, exp: this.now() + (tok.expires_in - 60) * 1000 };
      this.channelCache = await this.channelTitle().catch(() => null);
      this.d.audit.record({ actor: 'user', action: 'youtube_upload.connected', risk: 'high', decision: 'info' });
      return this.status();
    } finally {
      server.close();
    }
  }

  async disconnect(): Promise<YtUploadStatus> {
    const r = this.d.secrets.get(SECRET_YTU_REFRESH);
    if (r) await this.f()(`${REVOKE_URL}?token=${encodeURIComponent(r)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    this.d.secrets.delete(SECRET_YTU_REFRESH);
    this.access = null;
    this.channelCache = null;
    this.d.audit.record({ actor: 'user', action: 'youtube_upload.disconnected', decision: 'info' });
    return this.status();
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const res = await this.f()(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) }).catch(() => {
      throw new Error('Нет связи с Google. Проверьте интернет.');
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_client') throw new Error('Google не принял Client ID/Client secret. Проверьте, что клиент OAuth создан с типом «Приложение для ПК» (Desktop app), и вставьте значения заново.');
      if (j.error === 'invalid_grant') {
        this.d.secrets.delete(SECRET_YTU_REFRESH);
        this.access = null;
        throw new Error('Доступ к YouTube истёк или отозван. Нажмите «Подключить YouTube» ещё раз. (Если проект Google в режиме «Тестирование», доступ живёт всего 7 дней — переведите проект в «В production» на экране согласия OAuth.)');
      }
      throw new Error(`Google отклонил вход (${j.error ?? res.status})${j.error_description ? ': ' + j.error_description.slice(0, 120) : ''}.`);
    }
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in ?? 3600 };
  }

  private async bearer(): Promise<string> {
    if (this.access && this.access.exp > this.now()) return this.access.token;
    const refresh = this.d.secrets.get(SECRET_YTU_REFRESH);
    const clientId = this.clientId();
    const clientSecret = this.d.secrets.get(SECRET_YTU_CLIENT_SECRET);
    if (!refresh || !clientId || !clientSecret) throw new Error('YouTube не подключён: раздел «Студия» → «YouTube» → «Подключить».');
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret });
    this.access = { token: t.access_token, exp: this.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  private async channelTitle(): Promise<string | null> {
    const r = await this.f()(CHANNELS_URL, { headers: { Authorization: `Bearer ${await this.bearer()}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => ({}))) as { items?: { snippet?: { title?: string } }[] };
    return j.items?.[0]?.snippet?.title ?? null;
  }

  async refreshStatus(): Promise<YtUploadStatus> {
    if (this.d.secrets.has(SECRET_YTU_REFRESH) && !this.channelCache) this.channelCache = await this.channelTitle().catch(() => null);
    return this.status();
  }

  // ---------- загрузка ----------
  async upload(spec: YtUploadSpec, signal?: AbortSignal): Promise<YtUploadResult> {
    if (!existsSync(spec.file)) throw new Error('Файл ролика не найден.');
    const size = statSync(spec.file).size;
    if (size <= 0 || size > MAX_BYTES) throw new Error('Размер ролика должен быть от 1 байта до 4 ГБ.');
    const privacy: Privacy = spec.privacy && ['private', 'unlisted', 'public'].includes(spec.privacy) ? spec.privacy : 'private';
    const title = spec.title.replace(/[<>]/g, '').trim().slice(0, 100);
    if (!title) throw new Error('Укажите название ролика.');
    let description = (spec.description ?? '').replace(/[<>]/g, '').slice(0, 4900);
    if (!/#shorts/i.test(title + description)) description = `${description}\n\n#Shorts`.trim();
    const tags: string[] = [];
    let tagChars = 0;
    for (const t of spec.tags ?? []) {
      const c = String(t).replace(/[<>,]/g, '').replace(/^#/, '').trim().slice(0, 40);
      if (c && tagChars + c.length < 450) {
        tags.push(c);
        tagChars += c.length + 1;
      }
    }
    const warnings: string[] = [];
    this.d.spend(UPLOAD_COST);
    this.d.onProgress?.({ pct: 0, stage: 'Подключаюсь к YouTube' });
    const token = await this.bearer();
    const f = this.f();
    const init = await f(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
      body: JSON.stringify({ snippet: { title, description, tags, categoryId: '22', defaultLanguage: 'ru' }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new Error('Нет связи с YouTube. Проверьте интернет.');
    });
    if (!init.ok) throw await this.apiError(init, 'не удалось начать загрузку');
    const session = init.headers.get('location');
    if (!session || !/^https:\/\/[\w.-]*googleapis\.com\//.test(session)) throw new Error('YouTube не вернул адрес загрузки.');

    // по частям: можно докачать после сбоя сети
    const fd = openSync(spec.file, 'r');
    let sent = 0;
    let video: { id?: string; status?: { privacyStatus?: string } } | null = null;
    try {
      while (!video) {
        if (signal?.aborted) throw new Error('Загрузка остановлена.');
        const len = Math.min(CHUNK, size - sent);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, sent);
        let attempt = 0;
        for (;;) {
          try {
            const res = await f(session, {
              method: 'PUT',
              headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${sent}-${sent + len - 1}/${size}`, 'Content-Type': 'video/mp4' },
              body: buf,
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
            });
            if (res.status === 308) {
              const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
              sent = m ? Number(m[1]) + 1 : sent;
            } else if (res.status === 200 || res.status === 201) {
              video = (await res.json().catch(() => ({}))) as { id?: string };
              sent = size;
            } else if (res.status >= 500 && attempt < 3) {
              throw new Error(`сервер ответил ${res.status}`);
            } else throw await this.apiError(res, 'сбой при загрузке');
            break;
          } catch (e) {
            if (signal?.aborted) throw new Error('Загрузка остановлена.');
            if (e instanceof Error && /не удалось|сбой при загрузке|квота|доступ/i.test(e.message) && !/сервер ответил/.test(e.message)) throw e;
            if (++attempt > 3) throw new Error('Связь с YouTube прервалась во время загрузки. Попробуйте ещё раз.');
            // спрашиваем, сколько YouTube уже получил, и продолжаем с этого места
            const st = await f(session, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
            if (st?.status === 308) sent = /bytes=0-(\d+)/.exec(st.headers.get('range') ?? '') ? Number(/bytes=0-(\d+)/.exec(st.headers.get('range') ?? '')![1]) + 1 : 0;
            else if (st && (st.status === 200 || st.status === 201)) {
              video = (await st.json().catch(() => ({}))) as { id?: string };
              sent = size;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000 * attempt));
          }
        }
        this.d.onProgress?.({ pct: Math.round((sent / size) * 100), stage: 'Загружаю ролик' });
      }
    } finally {
      closeSync(fd);
    }
    if (!video?.id) throw new Error('YouTube принял файл, но не вернул номер ролика.');

    if (spec.thumbnail && existsSync(spec.thumbnail)) {
      try {
        this.d.spend(THUMB_COST);
        this.d.onProgress?.({ pct: 99, stage: 'Ставлю обложку' });
        const tr = await f(`${THUMB_URL}?videoId=${encodeURIComponent(video.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': /\.jpe?g$/i.test(spec.thumbnail) ? 'image/jpeg' : 'image/png' }, body: readFileSync(spec.thumbnail), signal: AbortSignal.timeout(60_000) });
        if (!tr.ok) warnings.push('Обложку YouTube не принял (для своих обложек канал должен быть подтверждён по телефону; у Shorts обложка выбирается кадром). Поставьте её вручную в YouTube Studio.');
      } catch {
        warnings.push('Обложку поставить не удалось — загрузите её вручную в YouTube Studio.');
      }
    }
    const actual = (video.status?.privacyStatus as Privacy | undefined) ?? privacy;
    if (privacy !== 'private' && actual === 'private') warnings.push('YouTube оставил ролик закрытым: проекты Google без проверки (аудита YouTube API) не могут публиковать ролики открыто. Откройте его вручную в YouTube Studio или пройдите проверку проекта.');
    this.d.onProgress?.({ pct: 100, stage: 'Готово' });
    this.d.audit.record({ actor: 'user', action: 'youtube_upload.uploaded', risk: 'high', decision: 'info', details: { id: video.id, privacy: actual, bytes: size } });
    return { id: video.id, url: `https://youtube.com/shorts/${video.id}`, privacy: actual, warnings };
  }

  private async apiError(res: Response, what: string): Promise<Error> {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = j.error?.errors?.[0]?.reason ?? '';
    if (res.status === 401) return new Error('YouTube не принял доступ (401). Подключите YouTube заново.');
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return new Error('Суточная квота YouTube API исчерпана (на загрузку уходит 1600 из 10 000 единиц). Повторите завтра.');
    if (reason === 'uploadLimitExceeded') return new Error('YouTube: превышен суточный лимит загрузок канала.');
    if (reason === 'youtubeSignupRequired' || reason === 'forbidden') return new Error('YouTube: у аккаунта нет канала или нет прав. Войдите тем Google-аккаунтом, у которого создан канал.');
    return new Error(`YouTube: ${what} (${res.status}${reason ? ', ' + reason : ''})${j.error?.message ? ': ' + j.error.message.slice(0, 120) : ''}.`);
  }

  registerTools(registry: ToolRegistry): void {
    registry.register<{ video: string; title: string; description?: string; tags?: string[]; privacy?: string }>({
      name: 'video_youtube_upload',
      description:
        'Загружает готовый ролик из папки «Готово» на YouTube-канал владельца (как Shorts). ВНЕШНЕЕ ДЕЙСТВИЕ: каждый раз с подтверждением. privacy: private (по умолчанию, безопасно — владелец откроет в YouTube Studio), unlisted или public — public только если пользователь прямо попросил. title до 100 знаков, description, tags. Обложка из папки результата ставится сама.',
      risk: 'high',
      mutates: true,
      domain: 'local',
      inputSchema: { type: 'object', properties: { video: { type: 'string', description: 'Название папки результата в «Готово»' }, title: { type: 'string' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, privacy: { type: 'string', enum: ['private', 'unlisted', 'public'] } }, required: ['video', 'title'] },
      describe: (i) => `ЗАГРУЗИТЬ на YouTube-канал ролик «${String(i.video).slice(0, 60)}» с названием «${String(i.title).slice(0, 80)}» (доступ: ${i.privacy === 'public' ? 'ОТКРЫТЫЙ' : i.privacy === 'unlisted' ? 'по ссылке' : 'закрытый'})`,
      execute: async (i, ctx) => {
        if (!this.d.resolveResult) throw new Error('Студия недоступна.');
        const r = this.d.resolveResult(i.video);
        const res = await this.upload({ file: r.video, thumbnail: r.cover, title: i.title, description: i.description, tags: i.tags, privacy: i.privacy as Privacy }, ctx.signal);
        return `Загружено на YouTube: ${res.url} (доступ: ${res.privacy === 'private' ? 'закрытый — откройте в YouTube Studio' : res.privacy}).${res.warnings.length ? ' ' + res.warnings.join(' ') : ''}`;
      },
    });
  }
}
