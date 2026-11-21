import { isIP } from 'node:net';

export class UrlError extends Error {}

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10/8
  [0x64400000, 0x647fffff], // 100.64/10 (CGNAT)
  [0x7f000000, 0x7fffffff], // 127/8
  [0xa9fe0000, 0xa9feffff], // 169.254/16 (link-local, облачные метаданные)
  [0xac100000, 0xac1fffff], // 172.16/12
  [0xc0a80000, 0xc0a8ffff], // 192.168/16
  [0xe0000000, 0xffffffff], // multicast и выше
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);
}

/** Внутренний/локальный адрес? */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (!h.includes('.') && isIP(h) === 0) return true; // однословные имена (intranet)
  const kind = isIP(h);
  if (kind === 4) {
    const n = v4ToInt(h);
    return PRIVATE_V4.some(([a, b]) => n >= a && n <= b);
  }
  if (kind === 6) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true; // ULA, link-local
    // IPv4 внутри IPv6: ::ffff:127.0.0.1 и нормализованная форма ::ffff:7f00:1
    const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isInternalHost(dotted[1]!);
    const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return isInternalHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // Любые другие формы встраивания IPv4 (::127.0.0.1, 64:ff9b::…) считаем внутренними — безопаснее.
    if (/^(::\d|64:ff9b:)/.test(h)) return true;
    return false;
  }
  // нестандартные формы IPv4 (0x7f.1, 2130706433, 017700000001)
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h)) return true;
  return false;
}

/**
 * Проверка адреса для браузера ассистента: только http/https, без логина в адресе,
 * внутренние адреса — лишь если пользователь явно добавил их в список разрешённых.
 */
export function checkUrl(raw: unknown, allowedHosts: string[]): URL {
  if (typeof raw !== 'string' || raw.length > 2000) throw new UrlError('Некорректный адрес');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new UrlError('Некорректный адрес (нужен полный адрес вида https://example.com)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UrlError('Разрешены только адреса http и https');
  if (u.username || u.password) throw new UrlError('Адреса с логином и паролем запрещены');
  const hostPort = u.host.toLowerCase();
  const allowed = allowedHosts.map((h) => h.toLowerCase());
  if (isInternalHost(u.hostname) && !allowed.includes(hostPort) && !allowed.includes(u.hostname.toLowerCase())) {
    throw new UrlError('Внутренние адреса (localhost, локальная сеть) закрыты. Их можно разрешить в «Настройки → Доступ к компьютеру».');
  }
  return u;
}
