import type {
  ChatMessage,
  ContentBlock,
  Conversation,
  MemoryItem,
  MemoryKind,
  MessageRole,
  Settings,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { nowIso, type Db } from './database';

// ---------------- Настройки ----------------

const PROVIDERS = ['auto', 'demo', 'anthropic'] as const;
const THEMES = ['dark', 'light', 'system'] as const;

/** Проверка и нормализация настроек. Неизвестные ключи отбрасываются, неверные значения — ошибка. */
export function validateSettingsPatch(patch: unknown): Partial<Settings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new Error('Некорректные настройки');
  }
  const p = patch as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if ('provider' in p) {
    if (!PROVIDERS.includes(p.provider as never)) throw new Error('Неизвестный провайдер');
    out.provider = p.provider as Settings['provider'];
  }
  if ('theme' in p) {
    if (!THEMES.includes(p.theme as never)) throw new Error('Неизвестная тема');
    out.theme = p.theme as Settings['theme'];
  }
  if ('model' in p) {
    if (typeof p.model !== 'string' || !/^[\w.:\-/]{1,100}$/.test(p.model)) throw new Error('Некорректное имя модели');
    out.model = p.model;
  }
  if ('customInstructions' in p) {
    if (typeof p.customInstructions !== 'string' || p.customInstructions.length > 4000) {
      throw new Error('Инструкции: строка до 4000 символов');
    }
    out.customInstructions = p.customInstructions;
  }
  if ('confirmFrom' in p) {
    if (p.confirmFrom !== 'low' && p.confirmFrom !== 'medium') throw new Error('Некорректный порог подтверждения');
    out.confirmFrom = p.confirmFrom;
  }
  if ('voiceMode' in p) {
    if (p.voiceMode !== 'push' && p.voiceMode !== 'wake') throw new Error('Неизвестный режим голоса');
    out.voiceMode = p.voiceMode;
  }
  if ('ttsMode' in p) {
    if (!['off', 'system', 'api'].includes(p.ttsMode as string)) throw new Error('Неизвестный режим озвучки');
    out.ttsMode = p.ttsMode as Settings['ttsMode'];
  }
  if ('voiceBaseUrl' in p) out.voiceBaseUrl = validateVoiceBaseUrl(p.voiceBaseUrl);
  for (const key of ['sttModel', 'ttsModel', 'ttsVoice'] as const) {
    if (key in p) {
      if (typeof p[key] !== 'string' || !/^[\w.:\-/]{1,100}$/.test(p[key] as string)) throw new Error(`Некорректное значение: ${key}`);
      out[key] = p[key] as string;
    }
  }
  for (const key of ['memoryEnabled', 'allowProductionWrites', 'micEnabled'] as const) {
    if (key in p) {
      if (typeof p[key] !== 'boolean') throw new Error(`Поле ${key} должно быть логическим`);
      out[key] = p[key] as boolean;
    }
  }
  return out;
}

/** Адрес API голоса: только https (или localhost для локальных серверов) — чтобы звук не ушёл по открытому каналу. */
export function validateVoiceBaseUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 200) throw new Error('Некорректный адрес API голоса');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error('Некорректный адрес API голоса');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('Адрес API голоса должен начинаться с https:// (http:// — только для localhost)');
  }
  if (u.username || u.password) throw new Error('Адрес не должен содержать логин и пароль');
  return u.toString().replace(/\/+$/, '');
}

export class SettingsRepo {
  constructor(private db: Db) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        /* повреждённое значение — используем значение по умолчанию */
      }
    }
    let validated: Partial<Settings> = {};
    try {
      validated = validateSettingsPatch(stored);
    } catch {
      // Если в БД окажется мусор, отбрасываем по одному ключу.
      for (const [k, v] of Object.entries(stored)) {
        try {
          Object.assign(validated, validateSettingsPatch({ [k]: v }));
        } catch {
          /* пропуск */
        }
      }
    }
    return { ...DEFAULT_SETTINGS, ...validated };
  }

  update(patch: unknown): Settings {
    const clean = validateSettingsPatch(patch);
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [k, v] of Object.entries(clean)) stmt.run(k, JSON.stringify(v), nowIso());
    return this.get();
  }
}

// ---------------- Диалоги и сообщения ----------------

interface ConvRow {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}
interface MsgRow {
  id: number;
  conversation_id: number;
  role: MessageRole;
  content: string;
  provider: string | null;
  model: string | null;
  created_at: string;
}

const toConv = (r: ConvRow): Conversation => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMsg = (r: MsgRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: JSON.parse(r.content) as ContentBlock[],
  createdAt: r.created_at,
  provider: r.provider,
  model: r.model,
});

export class ConversationRepo {
  constructor(private db: Db) {}

  list(): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id DESC')
      .all() as unknown as ConvRow[];
    return rows.map(toConv);
  }

  get(id: number): Conversation | null {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as ConvRow | undefined;
    return r ? toConv(r) : null;
  }

  create(title = 'Новый диалог'): Conversation {
    const t = title.trim().slice(0, 120) || 'Новый диалог';
    const ts = nowIso();
    const res = this.db
      .prepare('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)')
      .run(t, ts, ts);
    return this.get(Number(res.lastInsertRowid))!;
  }

  rename(id: number, title: string): void {
    const t = title.trim().slice(0, 120);
    if (!t) throw new Error('Пустое название');
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  messages(conversationId: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
      .all(conversationId) as unknown as MsgRow[];
    return rows.map(toMsg);
  }

  addMessage(
    conversationId: number,
    role: MessageRole,
    content: ContentBlock[],
    meta: { provider?: string; model?: string } = {},
  ): ChatMessage {
    const ts = nowIso();
    const res = this.db
      .prepare(
        'INSERT INTO messages (conversation_id, role, content, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(conversationId, role, JSON.stringify(content), meta.provider ?? null, meta.model ?? null, ts);
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, conversationId);
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as unknown as MsgRow;
    return toMsg(row);
  }
}

// ---------------- Память ----------------

interface MemRow {
  id: number;
  kind: MemoryKind;
  content: string;
  source: 'user' | 'assistant';
  created_at: string;
}
const KINDS: MemoryKind[] = ['preference', 'project', 'task', 'fact'];

export class MemoryRepo {
  constructor(private db: Db) {}

  list(): MemoryItem[] {
    const rows = this.db.prepare('SELECT * FROM memory ORDER BY id DESC').all() as unknown as MemRow[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, content: r.content, source: r.source, createdAt: r.created_at }));
  }

  add(kind: MemoryKind, content: string, source: 'user' | 'assistant'): MemoryItem {
    if (!KINDS.includes(kind)) throw new Error('Неизвестный тип записи памяти');
    const text = content.trim();
    if (!text) throw new Error('Пустая запись памяти');
    if (text.length > 1000) throw new Error('Запись памяти длиннее 1000 символов');
    const res = this.db
      .prepare('INSERT INTO memory (kind, content, source, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, text, source, nowIso());
    const row = this.db
      .prepare('SELECT * FROM memory WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as unknown as MemRow;
    return { id: row.id, kind: row.kind, content: row.content, source: row.source, createdAt: row.created_at };
  }

  remove(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM memory WHERE id = ?').run(id).changes) > 0;
  }
}
