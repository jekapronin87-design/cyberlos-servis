import { createHash } from 'node:crypto';
import type { AuditDecision, AuditEntry, RiskLevel } from '../../shared/types';
import { nowIso, type Db } from '../db/database';

const SENSITIVE_KEY = /key|token|secret|password|passwd|authorization|cookie/i;
const SECRET_VALUE = /(sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|Bearer\s+[\w.-]{16,})/g;

/** Маскирует секреты в данных, попадающих в журнал. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') {
    const masked = value.replace(SECRET_VALUE, '[скрыто]');
    return masked.length > 500 ? masked.slice(0, 500) + '…' : masked;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[скрыто]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  actor: string;
  action: string;
  target?: string | null;
  risk?: RiskLevel | null;
  decision: AuditDecision;
  details?: Record<string, unknown> | null;
}

interface Row {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  risk: RiskLevel | null;
  decision: AuditDecision;
  details: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function computeHash(prev: string, r: Omit<Row, 'id' | 'hash'>): string {
  return createHash('sha256')
    .update(JSON.stringify([prev, r.ts, r.actor, r.action, r.target, r.risk, r.decision, r.details]))
    .digest('hex');
}

/**
 * Журнал действий: добавление-только (триггеры БД) + цепочка SHA-256.
 * Это обнаруживает правку записей напрямую в файле БД; не заменяет внешний защищённый журнал.
 */
export class AuditLog {
  constructor(private db: Db) {}

  record(input: AuditInput): void {
    const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | undefined;
    const prev = last?.hash ?? GENESIS;
    const base = {
      ts: nowIso(),
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      risk: input.risk ?? null,
      decision: input.decision,
      details: input.details ? JSON.stringify(redact(input.details)) : null,
      prev_hash: prev,
    };
    const hash = computeHash(prev, base);
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, actor, action, target, risk, decision, details, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(base.ts, base.actor, base.action, base.target, base.risk, base.decision, base.details, prev, hash);
  }

  list(limit = 200): AuditEntry[] {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(n) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      target: r.target,
      risk: r.risk,
      decision: r.decision,
      details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
      hash: r.hash,
    }));
  }

  verify(): { ok: boolean; checked: number; brokenAtId?: number } {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as unknown as Row[];
    let prev = GENESIS;
    for (const r of rows) {
      const { id, hash, ...rest } = r;
      if (rest.prev_hash !== prev || computeHash(prev, rest) !== hash) {
        return { ok: false, checked: rows.length, brokenAtId: id };
      }
      prev = hash;
    }
    return { ok: true, checked: rows.length };
  }
}
