import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RiskLevel } from '../../shared/types';
import type { ComputerAccessRepo } from '../computer/access';
import { AccessError, resolveAllowed } from '../computer/pathguard';
import type { ToolRegistry } from '../tools/registry';
import { findNpmCli, formatRun, nodeCommand, runProcess, scrubbedEnv } from './process';

/** Скрипты package.json, которые разрешено запускать. `start`/`dev` не входят: это долгоживущие серверы. */
export const ALLOWED_SCRIPTS = ['test', 'test:unit', 'build', 'lint', 'typecheck', 'check', 'format', 'format:check'];

/** Признаки того, что команда делает что-то помимо сборки/тестов. Повышают риск до «высокого» и подсвечиваются в окне подтверждения. */
const SUSPICIOUS: [RegExp, string][] = [
  [/\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|bitsadmin|certutil)\b/i, 'скачивает данные из интернета'],
  [/\b(powershell|pwsh|cmd\s*\/c|bash\s+-c|sh\s+-c|eval)\b/i, 'запускает произвольную оболочку'],
  [/\b(rm\s+-rf?|rmdir\s+\/s|del\s+\/[sfq]|rd\s+\/s|format\s+[a-z]:|Remove-Item)\b/i, 'удаляет файлы'],
  [/\b(reg\s+(add|delete)|schtasks|sc\s+(create|config)|netsh|net\s+user|setx)\b/i, 'меняет настройки системы'],
  [/(\|\s*(sh|bash|node|python)\b|>\s*\/dev\/)/i, 'передаёт данные в интерпретатор'],
  [/(\.ssh|\.aws|\.env|credentials|id_rsa|api[_-]?key|token)/i, 'обращается к секретам'],
  [/\bgit\s+(push|remote|config)\b/i, 'меняет настройки или отправляет код в Git'],
  [/\bnpm\s+(publish|login|token|adduser)\b/i, 'публикует пакет или меняет учётные данные npm'],
];

export function suspiciousReasons(cmd: string): string[] {
  return SUSPICIOUS.filter(([re]) => re.test(cmd)).map(([, why]) => why);
}

function readScripts(project: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]{0,100}(@[\w.^~<>=*|-]{1,40})?$/i;

export function registerRunTools(registry: ToolRegistry, access: ComputerAccessRepo): void {
  const roots = (): string[] => access.get().folders;
  const project = (p: unknown): string => {
    try {
      const { abs } = resolveAllowed(p, roots());
      if (!statSync(abs).isDirectory()) throw new Error('Это не папка');
      if (!existsSync(join(abs, 'package.json'))) throw new Error('В папке нет package.json — это не Node.js-проект');
      return abs;
    } catch (e) {
      if (e instanceof AccessError) throw new Error(e.message);
      throw e;
    }
  };
  const npm = (args: string[], cwd: string, signal: AbortSignal, timeoutMs: number): ReturnType<typeof runProcess> => {
    const cli = findNpmCli();
    if (!cli) throw new Error('Не найден npm. Установите Node.js (https://nodejs.org) и перезапустите JARVIS.');
    const n = nodeCommand();
    return runProcess({ cmd: n.cmd, args: [cli, ...args], cwd, env: scrubbedEnv(process.env, n.env), timeoutMs, signal });
  };

  registry.register<{ path: string; script: string }>({
    name: 'run_script',
    description:
      'Запускает скрипт из package.json проекта: test, test:unit, build, lint, typecheck, check, format, format:check. Возвращает вывод и код выхода. ' +
      'Выполняется код проекта с правами пользователя — всегда требует подтверждения; окно показывает точную команду скрипта.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    external: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Папка проекта' },
        script: { type: 'string', enum: ALLOWED_SCRIPTS },
      },
      required: ['path', 'script'],
    },
    describe: (i) => {
      let cmd = '(не найден)';
      try {
        cmd = readScripts(project(i.path))[i.script] ?? '(скрипта нет в package.json)';
      } catch {
        /* покажем как есть */
      }
      return `Запустить «npm run ${i.script}» в ${i.path}\nКоманда скрипта: ${cmd}`;
    },
    assess: (i) => {
      try {
        const cmd = readScripts(project(i.path))[i.script] ?? '';
        const why = suspiciousReasons(cmd);
        return why.length ? { risk: 'high', warning: `Скрипт ${why.join('; ')}. Проверьте команду выше!` } : undefined;
      } catch {
        return undefined;
      }
    },
    execute: async (i, ctx) => {
      const dir = project(i.path);
      const cmd = readScripts(dir)[i.script];
      if (cmd === undefined) throw new Error(`В package.json нет скрипта «${i.script}»`);
      if (!ALLOWED_SCRIPTS.includes(i.script)) throw new Error('Этот скрипт запускать нельзя');
      const r = await npm(['run', i.script, '--silent'], dir, ctx.signal, 180_000);
      return formatRun(r, `npm run ${i.script}`) + (r.code === 0 ? '' : '\n\n(Ошибка: проанализируй вывод, исправь код и запусти снова.)');
    },
  });

  registry.register<{ path: string; packages?: string[]; allowScripts?: boolean }>({
    name: 'npm_install',
    description:
      'Устанавливает зависимости проекта (npm install) или добавляет пакеты. По умолчанию БЕЗ запуска скриптов установки пакетов (--ignore-scripts). ' +
      'Опасно: скачивает код из интернета — всегда требует подтверждения.',
    risk: 'high',
    mutates: true,
    domain: 'local',
    external: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        packages: { type: 'array', description: 'Пакеты для добавления, например ["express"]; пусто — установить из package.json' },
        allowScripts: { type: 'boolean', description: 'Разрешить скрипты установки пакетов (только если без них не работает)' },
      },
      required: ['path'],
    },
    describe: (i) =>
      `Установить зависимости в ${i.path}${i.packages?.length ? `: ${i.packages.join(', ')}` : ' (по package.json)'}${i.allowScripts ? '\n⚠ ВКЛЮЧАЯ запуск скриптов установки пакетов' : ' (без запуска скриптов пакетов)'}`,
    execute: async (i, ctx) => {
      const dir = project(i.path);
      const pkgs = (i.packages ?? []).map(String);
      if (pkgs.length > 10) throw new Error('Не больше 10 пакетов за раз');
      for (const p of pkgs) if (!NPM_NAME.test(p) || p.startsWith('-')) throw new Error(`Недопустимое имя пакета: ${p}`);
      const args = ['install', ...pkgs, '--no-audit', '--no-fund', '--loglevel=error', ...(i.allowScripts ? [] : ['--ignore-scripts'])];
      const r = await npm(args, dir, ctx.signal, 300_000);
      return formatRun(r, 'npm install');
    },
  });
}
