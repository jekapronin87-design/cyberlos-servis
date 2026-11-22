import type { ToolRegistry } from '../tools/registry';
import type { ComputerAccessRepo } from './access';
import type { HostServices } from './host';
import { resolveApp, type LaunchableApp } from './startmenu';

/**
 * Программы, которые разрешено запускать: встроенные + добавленные пользователем + (если пользователь разрешил) программы из меню Пуск.
 * Оболочки, редакторы реестра, планировщик и т. п. из меню Пуск исключены. Аргументы передать нельзя.
 */
export class AppCatalog {
  private cache: { at: number; list: { name: string; path: string }[] } | null = null;

  constructor(
    private access: ComputerAccessRepo,
    private host: HostServices,
  ) {}

  async list(): Promise<LaunchableApp[]> {
    const acc = this.access.get();
    const out: LaunchableApp[] = acc.apps.map((a) => ({ name: a.name, path: a.path, source: 'allowed' }));
    if (acc.startMenu && this.host.listStartMenu) {
      if (!this.cache || Date.now() - this.cache.at > 60_000) this.cache = { at: Date.now(), list: await this.host.listStartMenu().catch(() => []) };
      const have = new Set(out.map((a) => a.name.toLowerCase()));
      for (const a of this.cache.list) if (!have.has(a.name.toLowerCase())) out.push({ ...a, source: 'startmenu' });
    }
    return out;
  }

  invalidate(): void {
    this.cache = null;
  }

  async find(name: string): Promise<LaunchableApp | null> {
    const q = name.trim().toLowerCase();
    const all = await this.list();
    return all.find((a) => a.name.toLowerCase() === q) ?? resolveApp(name, all);
  }
}

export function registerAppTools(registry: ToolRegistry, catalog: AppCatalog, host: HostServices): void {
  registry.register({
    name: 'app_list',
    description: 'Показывает программы, которые разрешено запускать (включая программы из меню Пуск, если пользователь это разрешил).',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Показать разрешённые программы',
    execute: async () => {
      const apps = await catalog.list();
      return apps.length ? apps.slice(0, 150).map((a) => `• ${a.name}`).join('\n') + (apps.length > 150 ? `\n…и ещё ${apps.length - 150}` : '') : 'Разрешённых программ нет.';
    },
  });

  if (!host.launchApp) return;
  const launch = host.launchApp;
  registry.register<{ name: string }>({
    name: 'app_open',
    description:
      'Запускает программу по названию (например «Хром», «Блокнот», «Excel»; список — app_list). Аргументы передать нельзя. Если пользователь просит открыть программу — вызывай сразу, без лишних вопросов.',
    risk: 'low',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Название программы' } }, required: ['name'] },
    describe: (i) => `Запустить программу «${i.name}»`,
    execute: async (i) => {
      const app = await catalog.find(String(i.name));
      if (!app) {
        const names = (await catalog.list()).slice(0, 40).map((a) => a.name).join(', ');
        throw new Error(`Программа «${i.name}» не найдена среди разрешённых. Доступные: ${names || 'нет'}. Пользователь может разрешить программы из меню Пуск в «Настройки → Доступ к компьютеру».`);
      }
      await launch(app.path);
      return `Запущено: ${app.name}`;
    },
  });
}
