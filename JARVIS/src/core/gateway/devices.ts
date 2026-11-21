import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/database';
import { nowIso } from '../db/database';
import type { GatewayDeviceDto } from '../../shared/types';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

interface Row {
  id: number;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked: number;
  conversation_id: number | null;
}

export interface Device {
  id: number;
  name: string;
  conversationId: number | null;
}

/** Сопряжённые телефоны. В базе хранится только хеш токена: утечка базы не даёт доступа. */
export class DeviceRepo {
  private lastTouch = new Map<number, number>();

  constructor(private db: Db) {}

  create(name: string): { id: number; token: string } {
    const clean = name.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60) || 'Телефон';
    const token = randomBytes(32).toString('hex');
    const r = this.db.prepare('INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)').run(clean, hashToken(token), nowIso());
    return { id: Number(r.lastInsertRowid), token };
  }

  authenticate(token: string): Device | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0').get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const last = this.lastTouch.get(row.id) ?? 0;
    if (Date.now() - last > 30_000) {
      this.lastTouch.set(row.id, Date.now());
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    return { id: row.id, name: row.name, conversationId: row.conversation_id };
  }

  setConversation(id: number, convId: number): void {
    this.db.prepare('UPDATE devices SET conversation_id = ? WHERE id = ?').run(convId, id);
  }

  list(): GatewayDeviceDto[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY id DESC').all() as unknown as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      revoked: r.revoked === 1,
    }));
  }

  revoke(id: number): void {
    this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id);
  }
}

/**
 * Одноразовый код подключения. Создаётся только на компьютере (в окне JARVIS), живёт 5 минут,
 * после 5 неверных попыток сгорает — перебор 6 цифр невозможен.
 */
export class PairingCodes {
  private code: string | null = null;
  private expires = 0;
  private fails = 0;

  constructor(private now: () => number = Date.now) {}

  issue(): { code: string; expiresAt: string } {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.expires = this.now() + 5 * 60_000;
    this.fails = 0;
    return { code: this.code, expiresAt: new Date(this.expires).toISOString() };
  }

  /** true — код верный (и сразу погашен). */
  consume(candidate: string): boolean {
    if (!this.code || this.now() > this.expires) {
      this.code = null;
      return false;
    }
    if (typeof candidate === 'string' && candidate.length === 6 && candidate === this.code) {
      this.code = null;
      return true;
    }
    this.fails += 1;
    if (this.fails >= 5) this.code = null;
    return false;
  }

  clear(): void {
    this.code = null;
  }

  get active(): boolean {
    return this.code !== null && this.now() <= this.expires;
  }
}

/** Скользящее окно: не более max событий за windowMs на ключ. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Регистрирует событие; false — лимит превышен. */
  hit(key: string): boolean {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    return true;
  }
}
