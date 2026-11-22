type Fetch = typeof fetch;

export class YoutubeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'YoutubeApiError';
  }
}

export type YtRef = { kind: 'video'; id: string } | { kind: 'channel'; id: string } | { kind: 'handle'; handle: string };

const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;

/** Видео или канал из ссылки, @имени или идентификатора. null — не похоже на YouTube. */
export function parseYoutubeRef(raw: string): YtRef | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (VIDEO_ID.test(s) && !s.startsWith('@')) return { kind: 'video', id: s };
  if (CHANNEL_ID.test(s)) return { kind: 'channel', id: s };
  if (/^@[\w.\-]{2,60}$/.test(s)) return { kind: 'handle', handle: s.slice(1) };
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0] ?? '';
    return VIDEO_ID.test(id) ? { kind: 'video', id } : null;
  }
  if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return { kind: 'video', id: v };
  const m = /^\/(shorts|live|embed|v)\/([\w-]{11})/.exec(u.pathname);
  if (m) return { kind: 'video', id: m[2]! };
  const c = /^\/channel\/(UC[\w-]{22})/.exec(u.pathname);
  if (c) return { kind: 'channel', id: c[1]! };
  const h = /^\/@([\w.\-]{2,60})/.exec(u.pathname);
  if (h) return { kind: 'handle', handle: h[1]! };
  return null;
}

/** Длительность ISO 8601 (PT1H2M3S) → «1:02:03». */
export function formatDuration(iso: string): string {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return iso || '';
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0), mi = Number(m[3] ?? 0), se = Number(m[4] ?? 0);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return h ? `${h}:${p2(mi)}:${p2(se)}` : `${mi}:${p2(se)}`;
}

/**
 * Клиент YouTube Data API v3 (только чтение, по API-ключу). Ключ передаётся заголовком, а не в адресе, и вырезается из ошибок.
 * Изменять каналы, публиковать и отвечать на комментарии он не может: для этого нужна авторизация владельца канала (OAuth), здесь её нет.
 */
export class YoutubeApi {
  constructor(
    private key: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  async get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
    const u = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(u.toString(), {
        headers: { 'x-goog-api-key': this.key, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch {
      throw new YoutubeApiError(0, 'Нет связи с YouTube. Проверьте интернет.');
    }
    if (res.ok) return (await res.json()) as T;
    const j = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
    const reason = j?.error?.errors?.[0]?.reason ?? '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') throw new YoutubeApiError(res.status, 'Суточная квота YouTube API исчерпана (у Google 10 000 единиц в сутки). Продолжить можно завтра.');
    if (reason === 'keyInvalid' || reason === 'badRequest' && /API key/i.test(j?.error?.message ?? '')) throw new YoutubeApiError(res.status, 'Ключ YouTube API не подошёл. Проверьте его и что включён «YouTube Data API v3».');
    if (reason === 'accessNotConfigured' || reason === 'forbidden' && /not been used|disabled/i.test(j?.error?.message ?? '')) throw new YoutubeApiError(res.status, 'В проекте Google не включён «YouTube Data API v3». Включите его в консоли Google Cloud.');
    if (reason === 'commentsDisabled') throw new YoutubeApiError(res.status, 'У этого видео комментарии отключены.');
    if (res.status === 404 || reason === 'videoNotFound' || reason === 'channelNotFound') throw new YoutubeApiError(404, 'Не найдено (проверьте ссылку или название).');
    throw new YoutubeApiError(res.status, `Ошибка YouTube API (${res.status}${reason ? ', ' + reason : ''}).`);
  }
}
