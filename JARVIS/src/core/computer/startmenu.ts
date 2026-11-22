import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LaunchableApp {
  name: string;
  path: string;
  source: 'allowed' | 'startmenu';
}

/** Программы, которые нельзя запускать по имени из меню Пуск: оболочки, редакторы реестра, планировщики, службы и т. п. */
const BLOCK =
  /powershell|power shell|командн[а-я]* строк|command prompt|(^|[ ._-])cmd([ ._-]|$)|терминал|terminal|windows script|wscript|cscript|regedit|редактор реестра|registry|msconfig|конфигурация системы|system configuration|планировщик заданий|task scheduler|(^|[ ])службы([ ]|$)|(^|[ ])services([ ]|$)|управление компьютером|computer management|управление дисками|disk management|диспетчер устройств|device manager|консоль управления|\bmmc\b|\bwsl\b|ubuntu|debian|git bash|git cmd|\bbash\b|\bssh\b|wmi|sysinternals|process hacker|process explorer|autoruns|диспетчер задач|task manager|групповой политики|group policy|локальная политика|local security|монитор ресурсов|resource monitor|просмотр событий|event viewer|rdp|подключение к удал|remote desktop|выполнить|\brun\b/i;
/** Служебные ярлыки в папках программ: удаление, справка, сайт, лицензия. */
const NOISE = /удалить|удаление|uninstall|readme|справк|help|документаци|documentation|веб-сайт|website|лицензи|license|release notes|что нового|подробнее|about|change ?log|support|поддержк/i;

export function isBlockedApp(name: string): boolean {
  return BLOCK.test(name);
}

export function startMenuRoots(env: Record<string, string | undefined> = process.env): string[] {
  const roots: string[] = [];
  if (env.ProgramData) roots.push(join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (env.APPDATA) roots.push(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return roots;
}

/** Ярлыки (.lnk) из меню Пуск; запрещённые и служебные отбрасываются. */
export function scanStartMenu(roots: string[], maxDepth = 3, cap = 600): { name: string; path: string }[] {
  const out = new Map<string, { name: string; path: string }>();
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.size >= cap) return;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < maxDepth && !isBlockedApp(e)) walk(p, depth + 1);
      } else if (/\.lnk$/i.test(e)) {
        const name = e.replace(/\.lnk$/i, '');
        if (isBlockedApp(name) || NOISE.test(name)) continue;
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, path: p });
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, 0);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Разговорные названия → варианты в меню Пуск. */
const ALIASES: Record<string, string[]> = {
  хром: ['chrome'],
  'гугл хром': ['chrome'],
  гугл: ['chrome'],
  эксель: ['excel'],
  ексель: ['excel'],
  ворд: ['word'],
  'пауэр поинт': ['powerpoint'],
  'повер поинт': ['powerpoint'],
  аутлук: ['outlook'],
  телеграм: ['telegram'],
  телега: ['telegram'],
  вотсап: ['whatsapp'],
  вацап: ['whatsapp'],
  ватсап: ['whatsapp'],
  скайп: ['skype'],
  зум: ['zoom'],
  дискорд: ['discord'],
  стим: ['steam'],
  спотифай: ['spotify'],
  пейнт: ['paint'],
  блокнот: ['notepad', 'блокнот'],
  калькулятор: ['calculator', 'калькулятор'],
  эдж: ['edge'],
  едж: ['edge'],
  фаерфокс: ['firefox'],
  фаервокс: ['firefox'],
  яндекс: ['yandex', 'яндекс'],
  'яндекс браузер': ['yandex', 'яндекс'],
  опера: ['opera'],
  обс: ['obs'],
  фотошоп: ['photoshop'],
  'виндовс медиа': ['media player'],
  'код': ['visual studio code', 'vs code'],
  'виз код': ['visual studio code'],
  макс: ['max', 'макс'],
};

const FILLER = /^(пожалуйста|программу|программа|приложение|мне|давай|а|ну|плиз)\s+/;

/**
 * Найти программу по разговорному названию. Возвращает null, если ничего не подошло или подходит несколько разных
 * (тогда решает человек/модель — угадывать запуск нельзя).
 */
export function resolveApp(query: string, apps: LaunchableApp[]): LaunchableApp | null {
  let q = norm(query);
  while (FILLER.test(q + ' ')) q = q.replace(FILLER, '').trim();
  if (!q || q.length < 2) return null;
  const cands = [q, ...(ALIASES[q] ?? [])].map(norm);
  const tiers: ((n: string, c: string) => boolean)[] = [
    (n, c) => n === c,
    (n, c) => n.startsWith(c + ' ') || n.startsWith(c),
    (n, c) => ` ${n} `.includes(` ${c} `),
    (n, c) => c.length >= 4 && n.includes(c),
  ];
  for (const tier of tiers) {
    const hit = apps.filter((a) => cands.some((c) => tier(norm(a.name), c)));
    if (hit.length === 0) continue;
    const names = new Set(hit.map((a) => norm(a.name)));
    if (names.size === 1) return hit.find((a) => a.source === 'allowed') ?? hit[0]!;
    const allowed = hit.filter((a) => a.source === 'allowed');
    if (new Set(allowed.map((a) => norm(a.name))).size === 1) return allowed[0]!;
    return null;
  }
  return null;
}
