import { describe, expect, it } from 'vitest';
import { checkUrl, isInternalHost } from '../src/core/computer/urlguard';

describe('проверка адресов браузера', () => {
  it('публичные http/https разрешены', () => {
    expect(checkUrl('https://example.com/path?q=1', []).hostname).toBe('example.com');
    expect(checkUrl('http://1.1.1.1', []).hostname).toBe('1.1.1.1');
  });
  it('не http/https запрещены', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', 'ftp://x.com', 'about:blank', 'view-source:https://a.com', 'не адрес', '']) {
      expect(() => checkUrl(u, [])).toThrow();
    }
  });
  it('внутренние адреса запрещены по умолчанию (в том числе хитрые формы)', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '[::1]', '[fd00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', 'intranet', 'printer.local', 'db.internal', '2130706433', '0x7f.0.0.1', '017700000001']) {
      expect(isInternalHost(h.replace(/^\[|\]$/g, '')), h).toBe(true);
      expect(() => checkUrl(`http://${h}/`, []), h).toThrow(/Внутренние|Некорректный/);
    }
    expect(isInternalHost('172.32.0.1')).toBe(false);
    expect(isInternalHost('8.8.8.8')).toBe(false);
  });
  it('внутренний адрес — только если пользователь добавил его', () => {
    expect(checkUrl('http://localhost:5173/x', ['localhost:5173']).port).toBe('5173');
    expect(() => checkUrl('http://localhost:9999/x', ['localhost:5173'])).toThrow();
  });
  it('логин в адресе запрещён', () => {
    expect(() => checkUrl('https://user:pw@example.com', [])).toThrow(/логином/);
  });
});
