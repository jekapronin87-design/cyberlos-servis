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
