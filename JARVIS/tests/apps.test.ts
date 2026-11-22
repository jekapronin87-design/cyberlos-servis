import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBlockedApp, resolveApp, scanStartMenu, type LaunchableApp } from '../src/core/computer/startmenu';
import { chat, makeCore } from './helpers';

const A = (name: string, source: LaunchableApp['source'] = 'startmenu'): LaunchableApp => ({ name, path: `C:\\x\\${name}.lnk`, source });

describe('меню Пуск: поиск программы по разговорному названию', () => {
  const apps = [A('Google Chrome'), A('Microsoft Edge'), A('Excel'), A('Word'), A('Telegram'), A('Калькулятор', 'allowed'), A('Блокнот', 'allowed'), A('Paint', 'allowed'), A('Visual Studio Code'), A('Steam'), A('Яндекс Браузер'), A('Яндекс Музыка')];
  it('находит по русским названиям и синонимам', () => {
    expect(resolveApp('хром', apps)?.name).toBe('Google Chrome');
    expect(resolveApp('Эксель', apps)?.name).toBe('Excel');
    expect(resolveApp('телеграм', apps)?.name).toBe('Telegram');
    expect(resolveApp('калькулятор', apps)?.name).toBe('Калькулятор');
    expect(resolveApp('программу блокнот', apps)?.name).toBe('Блокнот');
    expect(resolveApp('пейнт', apps)?.name).toBe('Paint');
    expect(resolveApp('вс код', apps)).toBeNull(); // не угадываем
    expect(resolveApp('код', apps)?.name).toBe('Visual Studio Code');
  });
  it('если подходит несколько разных программ или ничего — null (решает модель)', () => {
    expect(resolveApp('яндекс', apps)).toBeNull();
    expect(resolveApp('сайт компании', apps)).toBeNull();
    expect(resolveApp('', apps)).toBeNull();
    expect(resolveApp('я', apps)).toBeNull();
  });
  it('запрещённые программы отсеиваются', () => {
    for (const n of ['Windows PowerShell', 'Командная строка', 'Terminal', 'Редактор реестра', 'Планировщик заданий', 'Диспетчер задач', 'Службы', 'Ubuntu', 'Git Bash', 'Управление компьютером', 'Remote Desktop Connection']) expect(isBlockedApp(n), n).toBe(true);
    for (const n of ['Google Chrome', 'Excel', 'Telegram', 'Блокнот']) expect(isBlockedApp(n), n).toBe(false);
  });
  it('сканирование меню Пуск: ярлыки найдены, служебные и опасные исключены', () => {
    const root = mkdtempSync(join(tmpdir(), 'jv-sm-'));
    mkdirSync(join(root, 'Office'), { recursive: true });
    mkdirSync(join(root, 'Windows PowerShell'), { recursive: true });
    for (const f of ['Google Chrome.lnk', 'Office/Excel.lnk', 'Office/Удалить Office.lnk', 'Windows PowerShell/Windows PowerShell.lnk', 'Telegram.lnk', 'readme.txt', 'Справка по программе.lnk']) writeFileSync(join(root, f), 'x');
    expect(scanStartMenu([root]).map((a) => a.name)).toEqual(['Excel', 'Google Chrome', 'Telegram']);
  });
});

function setup(startMenu: { name: string; path: string }[]) {
  const launched: string[] = [];
  const h = makeCore({ host: { launchApp: async (p) => void launched.push(p), listStartMenu: async () => startMenu } });
  return { h, launched };
}

describe('запуск программ голосом', () => {
  const menu = [{ name: 'Google Chrome', path: 'C:\\chrome.lnk' }, { name: 'Excel', path: 'C:\\excel.lnk' }];

  it('без разрешения меню Пуск программы оттуда недоступны', async () => {
    const { h, launched } = setup(menu);
    expect(await h.core.launchAppByName('хром')).toMatchObject({ matched: false });
    expect(launched).toHaveLength(0);
  });

  it('после разрешения «открой хром» запускает программу без окна подтверждения; всё попадает в журнал', async () => {
    const { h, launched } = setup(menu);
    h.core.setStartMenuAccess(true);
    const r = await h.core.launchAppByName('хром');
    expect(r).toMatchObject({ matched: true, ok: true, message: 'Запускаю Google Chrome.' });
    expect(launched).toEqual(['C:\\chrome.lnk']);
    expect(h.confirms).toHaveLength(0);
    const audit = JSON.stringify(h.core.listAudit(50));
    expect(audit).toContain('app_open');
    expect(audit).toContain('computer.startmenu_enabled');
    expect(await h.core.startMenuApps()).toEqual(['Google Chrome', 'Excel']);
    h.core.setStartMenuAccess(false);
    expect(await h.core.launchAppByName('хром')).toMatchObject({ matched: false });
  });

  it('модель тоже может запустить программу из меню Пуск по названию; неизвестную — нет', async () => {
    const { h, launched } = setup(menu);
    h.core.setStartMenuAccess(true);
    const tool = h.core.tools.get('app_open')!;
    const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };
    await tool.execute({ name: 'Excel' }, ctx);
    expect(launched).toEqual(['C:\\excel.lnk']);
    await expect(tool.execute({ name: 'cmd' }, ctx)).rejects.toThrow(/не найдена/);
    await expect(tool.execute({ name: 'PowerShell' }, ctx)).rejects.toThrow(/не найдена/);
  });

  it('при отключённом модуле «Управление компьютером» голосовой запуск не работает', async () => {
    const { h, launched } = setup(menu);
    h.core.setStartMenuAccess(true);
    h.core.updateSettings({ disabledModules: ['computer'] });
    expect(await h.core.launchAppByName('хром')).toMatchObject({ matched: false });
    expect(launched).toHaveLength(0);
    void chat;
  });
});
