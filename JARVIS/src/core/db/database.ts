import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

/**
 * Миграции. Каждая применяется один раз; номер версии хранится в PRAGMA user_version.
 * Никогда не редактируйте уже выпущенные миграции — добавляйте новые.
 */
const MIGRATIONS: string[] = [
  // 1: ядро
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
    content TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('preference','project','task','fact')),
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user','assistant')),
    created_at TEXT NOT NULL
  );

  -- Журнал действий: только добавление, цепочка хешей для обнаружения подмены.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    risk TEXT,
    decision TEXT NOT NULL,
    details TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  // 2: вложения (снимки экрана) — отдельно от сообщений
  `
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 3: тип вложения (снимок экрана / кадр камеры)
  `
  ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'screen';
  `,
  // 4: досье о пользователе (разделы свободного текста)
  `
  CREATE TABLE profile (
    section TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 5: задачи по расписанию
  `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('daily','weekdays','interval','once')),
    at_time TEXT,
    interval_min INTEGER,
    run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    notify INTEGER NOT NULL DEFAULT 1,
    speak INTEGER NOT NULL DEFAULT 0,
    conversation_id INTEGER,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_summary TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    summary TEXT
  );
  `,
  // 6: ИИ-наставник — база знаний, назначения и результаты обучения
  `
  CREATE TABLE kb_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
    version INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE mentor_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    name TEXT,
    course_id TEXT NOT NULL,
    due_at TEXT,
    assigned_at TEXT NOT NULL,
    UNIQUE (email, course_id)
  );
  CREATE TABLE mentor_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    step_idx INTEGER NOT NULL,
    kind TEXT NOT NULL,
    correct INTEGER NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_attempts ON mentor_attempts (email, course_id, lesson_id);
  `,
  // 7: устройства для доступа с телефона
  `
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    conversation_id INTEGER,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 8: телефония — реестр согласий и журнал учебных звонков
  `
  CREATE TABLE consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    training INTEGER NOT NULL DEFAULT 1,
    recording INTEGER NOT NULL DEFAULT 0,
    granted_at TEXT NOT NULL,
    revoked_at TEXT,
    source TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    name TEXT NOT NULL,
    course_id TEXT NOT NULL,
    lesson_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    recorded INTEGER NOT NULL DEFAULT 0,
    transcript TEXT,
    summary TEXT
  );
  CREATE INDEX idx_calls_phone ON calls (phone, started_at);
  `,
  // 9: Telegram — чаты, сообщения, служебное состояние
  `
  CREATE TABLE tg_chats (
    chat_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    is_owner INTEGER NOT NULL DEFAULT 0,
    autoreply INTEGER NOT NULL DEFAULT 1,
    needs_human INTEGER NOT NULL DEFAULT 0,
    disclosed INTEGER NOT NULL DEFAULT 0,
    last_at TEXT
  );
  CREATE TABLE tg_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES tg_chats(chat_id) ON DELETE CASCADE,
    dir TEXT NOT NULL CHECK (dir IN ('in','out')),
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_tgm_chat ON tg_messages (chat_id, id);
  CREATE TABLE tg_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 10: пользовательские ИИ-агенты и журнал их запусков
  `
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    groups TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read','act')),
    sched_kind TEXT NOT NULL DEFAULT 'none',
    sched_time TEXT,
    sched_interval INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_summary TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    task TEXT NOT NULL DEFAULT '',
    report TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_agent_runs ON agent_runs (agent_id, id);
  `,
  // 11: расход квоты YouTube Data API по дням
  `
  CREATE TABLE yt_usage (day TEXT PRIMARY KEY, units INTEGER NOT NULL DEFAULT 0);
  `,
  // 12: расход токенов ИИ по дням и моделям (для счётчика расходов и дневного лимита)
  `
  CREATE TABLE ai_usage (
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
  );
  `,
];

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export const nowIso = (): string => new Date().toISOString();
