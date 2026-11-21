import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/core/db/database';
import { ConversationRepo, MemoryRepo, SettingsRepo, validateSettingsPatch } from '../src/core/db/repositories';
import { DEFAULT_SETTINGS } from '../src/shared/types';

describe('миграции и репозитории', () => {
  it('создаёт схему и повторное открытие идемпотентно', () => {
    const db = openDatabase(':memory:');
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThanOrEqual(1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['settings', 'conversations', 'messages', 'memory', 'audit_log']) expect(tables).toContain(t);
  });

  it('настройки: значения по умолчанию, обновление, валидация', () => {
    const repo = new SettingsRepo(openDatabase(':memory:'));
    expect(repo.get()).toEqual(DEFAULT_SETTINGS);
    expect(repo.update({ theme: 'light', memoryEnabled: false }).theme).toBe('light');
    expect(repo.get().memoryEnabled).toBe(false);
    expect(() => repo.update({ provider: 'evil' })).toThrow();
    expect(() => repo.update({ model: 'a b; rm' })).toThrow();
    expect(() => repo.update({ allowProductionWrites: 'yes' })).toThrow();
    expect(validateSettingsPatch({ unknownKey: 1 })).toEqual({});
    expect(() => validateSettingsPatch(null)).toThrow();
  });

  it('диалоги и сообщения: каскадное удаление, порядок', () => {
    const db = openDatabase(':memory:');
    const repo = new ConversationRepo(db);
    const c = repo.create('  ');
    expect(c.title).toBe('Новый диалог');
    repo.addMessage(c.id, 'user', [{ type: 'text', text: 'привет' }]);
    repo.addMessage(c.id, 'assistant', [{ type: 'text', text: 'здравствуйте' }], { provider: 'demo' });
    const msgs = repo.messages(c.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.provider).toBe('demo');
    repo.remove(c.id);
    expect(repo.messages(c.id)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
  });

  it('память: добавление, ограничения, удаление', () => {
    const repo = new MemoryRepo(openDatabase(':memory:'));
    const item = repo.add('project', 'Проект Сайберлос', 'user');
    expect(repo.list()).toHaveLength(1);
    expect(() => repo.add('fact', '   ', 'user')).toThrow();
    expect(() => repo.add('fact', 'x'.repeat(1001), 'user')).toThrow();
    expect(() => repo.add('bad' as never, 'x', 'user')).toThrow();
    expect(repo.remove(item.id)).toBe(true);
    expect(repo.remove(item.id)).toBe(false);
  });
});
