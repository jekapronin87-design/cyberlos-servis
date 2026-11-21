import type { ToolRegistry } from '../tools/registry';
import type { ComputerAccessRepo } from './access';
import type { HostServices } from './host';

/** Запуск программ — только из белого списка (встроенные + добавленные пользователем), без аргументов. */
export function registerAppTools(registry: ToolRegistry, access: ComputerAccessRepo, host: HostServices): void {
  registry.register({
    name: 'app_list',
    description: 'Показывает программы, которые разрешено запускать.',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Показать разрешённые программы',
    execute: () => {
      const apps = access.get().apps;
      return apps.length ? apps.map((a) => `• ${a.name}`).join('\n') : 'Разрешённых программ нет.';
    },
  });

  if (!host.launchApp) return;
  const launch = host.launchApp;
  registry.register<{ name: string }>({
    name: 'app_open',
    description: 'Запускает разрешённую программу по имени (из app_list). Аргументы передать нельзя.',
    risk: 'medium',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Имя программы из app_list' } }, required: ['name'] },
    describe: (i) => `Запустить программу «${i.name}»`,
    execute: async (i) => {
      const app = access.get().apps.find((a) => a.name.toLowerCase() === String(i.name).trim().toLowerCase());
      if (!app) throw new Error(`Программа «${i.name}» не в списке разрешённых. Доступные: ${access.get().apps.map((a) => a.name).join(', ') || 'нет'}`);
      await launch(app.path);
      return `Запущено: ${app.name}`;
    },
  });
}
