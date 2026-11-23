import { nowIso, type Db } from '../db/database';
import type { AuditLog } from '../security/audit';
import type { SecretStore } from '../security/secrets';
import type { MailItemDto } from '../../shared/deck';
import { scoreMail, type RawMail } from './rules';

import type { MailAccountDto } from '../../shared/deck';
export type { MailAccountDto };
export type MailProvider = MailAccountDto['provider'];

const HOSTS: Record<MailProvider, { host: string; port: number; label: string; help: string }> = {
  gmail: {
    host: 'imap.gmail.com',
    port: 993,
    label: 'Gmail',
    help: 'Gmail не принял вход. Нужен не обычный пароль, а «пароль приложения»: в аккаунте Google включите двухэтапную проверку, затем «Безопасность → Пароли приложений» и создайте пароль для почты.',
  },
  yandex: {
    host: 'imap.yandex.com',
    port: 993,
    label: 'Яндекс',
    help: 'Яндекс не принял вход. В почте откройте «Настройки → Почтовые программы», включите «С сервера imap.yandex.ru по протоколу IMAP» и создайте «пароль приложения» в «Безопасность → Пароли приложений».',
  },
};

/** Получение писем: только заголовки (отправитель, тема, дата, флаги). Тела писем не читаются и не скачиваются, письма не помечаются прочитанными. */
export type MailFetcher = (conn: { host: string; port: number; user: string; pass: string }, since: Date) => Promise<Omit<RawMail, 'account'>[]>;

export const imapFetcher: MailFetcher = async (c, since) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: c.host, port: c.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 25_000 });
  client.on('error', () => undefined);
  await client.connect();
  const out: Omit<RawMail, 'account'>[] = [];
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = await client.search({ since, seen: false }, { uid: true });
      if (uids && uids.length) {
        for await (const m of client.fetch(uids.slice(-60), { envelope: true, flags: true, labels: true, internalDate: true }, { uid: true })) {
          const a = m.envelope?.from?.[0];
          out.push({
            from: a?.address ?? '',
            fromName: a?.name ?? '',
            subject: m.envelope?.subject ?? '(без темы)',
            date: new Date(m.envelope?.date ?? m.internalDate ?? Date.now()).toISOString(),
            seen: m.flags?.has('\\Seen') ?? false,
            flagged: m.flags?.has('\\Flagged') ?? false,
            labels: m.labels ? [...m.labels] : [],
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
};

const secretKey = (id: string): string => `mail.${id}.password`;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,20}$/;

export class MailService {
  constructor(
    private db: Db,
    private secrets: SecretStore,
    private audit: AuditLog,
    private fetcher: MailFetcher = imapFetcher,
  ) {}

  private readAccounts(): { id: string; provider: MailProvider; email: string }[] {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'briefing.mailAccounts'").get() as { value: string } | undefined;
    try {
      const v = r ? (JSON.parse(r.value) as unknown) : [];
      return Array.isArray(v) ? v.filter((a) => a && typeof a.id === 'string' && (a.provider === 'gmail' || a.provider === 'yandex') && typeof a.email === 'string') : [];
    } catch {
      return [];
    }
  }
  private writeAccounts(list: { id: string; provider: MailProvider; email: string }[]): void {
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('briefing.mailAccounts', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(JSON.stringify(list), nowIso());
  }

  list(): MailAccountDto[] {
    return this.readAccounts().map((a) => ({ ...a, hasPassword: this.secrets.has(secretKey(a.id)) }));
  }

  add(provider: unknown, email: unknown, password: unknown): MailAccountDto[] {
    if (provider !== 'gmail' && provider !== 'yandex') throw new Error('Выберите почту: Gmail или Яндекс.');
    const mail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(mail)) throw new Error('Адрес почты выглядит неверно (пример: name@gmail.com).');
    const pass = typeof password === 'string' ? password.replace(/\s+/g, '') : '';
    if (pass.length < 8 || pass.length > 200) throw new Error('Вставьте «пароль приложения» целиком (не обычный пароль от почты).');
    const list = this.readAccounts();
    if (list.length >= 6 && !list.some((a) => a.email === mail)) throw new Error('Можно подключить не больше 6 почтовых ящиков.');
    const existing = list.find((a) => a.email === mail && a.provider === provider);
    const id = existing?.id ?? `${provider}-${Math.random().toString(36).slice(2, 8)}`;
    if (!existing) list.push({ id, provider, email: mail });
    this.secrets.set(secretKey(id), pass);
    this.writeAccounts(list);
    this.audit.record({ actor: 'user', action: 'mail.account_added', risk: 'high', decision: 'info', details: { provider, email: mail.replace(/^(.).*(@.*)$/, '$1***$2') } });
    return this.list();
  }

  remove(id: string): MailAccountDto[] {
    this.secrets.delete(secretKey(id));
    this.writeAccounts(this.readAccounts().filter((a) => a.id !== id));
    this.audit.record({ actor: 'user', action: 'mail.account_removed', decision: 'info' });
    return this.list();
  }

  private async fetchOne(a: { id: string; provider: MailProvider; email: string }, since: Date): Promise<RawMail[]> {
    const pass = this.secrets.get(secretKey(a.id));
    if (!pass) throw new Error(`${a.email}: не задан пароль приложения.`);
    const h = HOSTS[a.provider];
    try {
      const rows = await this.fetcher({ host: h.host, port: h.port, user: a.email, pass }, since);
      return rows.map((r) => ({ ...r, account: a.email }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const authFail = /auth|credential|login|invalid|password|AUTHENTICATIONFAILED/i.test(msg) || (e as { authenticationFailed?: boolean }).authenticationFailed === true;
      throw new Error(`${a.email}: ${authFail ? h.help : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|Network|EAI_AGAIN/i.test(msg) ? 'нет связи с почтовым сервером.' : `ошибка почты (${msg.slice(0, 120)})`}`);
    }
  }

  /** Проверка для кнопки «Проверить»: сколько непрочитанных за 3 дня. */
  async test(id: string): Promise<string> {
    const a = this.readAccounts().find((x) => x.id === id);
    if (!a) throw new Error('Такого ящика нет.');
    const rows = await this.fetchOne(a, new Date(Date.now() - 3 * 86_400_000));
    this.audit.record({ actor: 'user', action: 'mail.test', decision: 'info', details: { provider: a.provider, unseen: rows.length } });
    return `${HOSTS[a.provider].label}: вход прошёл. Непрочитанных за 3 дня: ${rows.length}. Письма не открываются и не помечаются прочитанными.`;
  }

  /** Непрочитанные за 2 суток со всех ящиков, оценённые по важности. Ошибки одного ящика не мешают остальным. */
  async collect(vip: string[], now = new Date()): Promise<{ items: MailItemDto[]; accounts: number; errors: string[] }> {
    const accounts = this.readAccounts();
    const items: MailItemDto[] = [];
    const errors: string[] = [];
    await Promise.all(
      accounts.map(async (a) => {
        try {
          for (const r of await this.fetchOne(a, new Date(now.getTime() - 2 * 86_400_000))) items.push(scoreMail(r, vip));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }),
    );
    items.sort((a, b) => b.score - a.score || Date.parse(b.date) - Date.parse(a.date));
    return { items, accounts: accounts.length, errors };
  }
}
