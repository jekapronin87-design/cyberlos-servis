import type { MemoryKind } from '../../shared/types';
import type { MemoryRepo } from '../db/repositories';
import { ToolRegistry } from './registry';

const KINDS: MemoryKind[] = ['preference', 'project', 'task', 'fact'];

/** Встроенные инструменты этапа 1: время и долговременная память. */
export function registerBuiltinTools(registry: ToolRegistry, memory: MemoryRepo): ToolRegistry {
  registry.register({
    name: 'get_datetime',
    description: 'Возвращает текущие дату и время пользователя.',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Узнать текущее время',
    execute: () =>
      new Date().toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'medium' }) +
      ` (часовой пояс: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
  });

  registry.register({
    name: 'list_memory',
    description: 'Показывает всё, что сохранено в долговременной памяти (предпочтения, проекты, задачи, факты).',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Прочитать долговременную память',
    execute: () => {
      const items = memory.list();
      if (items.length === 0) return 'Память пуста.';
      return items.map((m) => `#${m.id} [${m.kind}] ${m.content}`).join('\n');
    },
  });

  registry.register<{ kind: MemoryKind; content: string }>({
    name: 'remember',
    description:
      'Сохраняет в долговременную память важный факт, предпочтение, проект или задачу пользователя. ' +
      'Используй только когда пользователь просит запомнить или явно сообщает устойчивое предпочтение.',
    risk: 'low',
    mutates: true,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS, description: 'Тип записи' },
        content: { type: 'string', description: 'Что запомнить (кратко, до 1000 символов)' },
      },
      required: ['kind', 'content'],
    },
    describe: (i) => `Запомнить (${i.kind}): «${String(i.content).slice(0, 200)}»`,
    execute: (i) => {
      const item = memory.add(KINDS.includes(i.kind) ? i.kind : 'fact', String(i.content), 'assistant');
      return `Сохранено в память под номером #${item.id}.`;
    },
  });

  registry.register<{ id: number }>({
    name: 'forget_memory',
    description: 'Удаляет запись из долговременной памяти по номеру. Требует подтверждения пользователя.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Номер записи памяти' } },
      required: ['id'],
    },
    describe: (i) => `Удалить запись памяти #${i.id}`,
    execute: (i) => (memory.remove(Number(i.id)) ? `Запись #${i.id} удалена.` : `Записи #${i.id} нет.`),
  });

  return registry;
}
