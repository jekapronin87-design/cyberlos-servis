import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { ToolRegistry } from '../tools/registry';
import type { ComputerAccessRepo } from '../computer/access';
import { AccessError, isProtectedForWrite, isSensitivePath, resolveAllowed } from '../computer/pathguard';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'release', '.turbo']);
const MAX_FILE = 1024 * 1024;

const LANGS: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.js': 'JavaScript', '.jsx': 'JavaScript (React)', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.cs': 'C#', '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.php': 'PHP', '.rb': 'Ruby', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.sql': 'SQL', '.prisma': 'Prisma', '.json': 'JSON', '.md': 'Markdown', '.yml': 'YAML', '.yaml': 'YAML',
};

const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AccessError) throw new Error(e.message);
    throw e;
  }
};

function* walk(dir: string, depth = 0, max = 6): Generator<{ path: string; dir: boolean }> {
  if (depth > max) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name.toLowerCase())) continue;
      yield { path: full, dir: true };
      yield* walk(full, depth + 1, max);
    } else {
      yield { path: full, dir: false };
    }
  }
}

const isText = (p: string): boolean => {
  try {
    const fd = readFileSync(p);
    return !fd.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
};

/** Сводка по проекту: стек, скрипты, структура, объём. */
export function projectOverview(root: string): string {
  const lines: string[] = [];
  const pkgPath = join(root, 'package.json');
  const stack: string[] = [];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; type?: string;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const has = (n: string): boolean => n in deps;
      for (const [n, label] of [['react', 'React'], ['vue', 'Vue'], ['express', 'Express'], ['@prisma/client', 'Prisma'], ['prisma', 'Prisma'], ['vite', 'Vite'], ['typescript', 'TypeScript'], ['electron', 'Electron'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['next', 'Next.js']] as const) {
        if (has(n) && !stack.includes(label)) stack.push(label);
      }
      lines.push(`Node.js-проект «${pkg.name ?? basename(root)}»${pkg.type === 'module' ? ' (ES-модули)' : ''}`);
      lines.push(`Скрипты: ${Object.keys(pkg.scripts ?? {}).join(', ') || 'нет'}`);
      lines.push(`Зависимостей: ${Object.keys(pkg.dependencies ?? {}).length}, dev: ${Object.keys(pkg.devDependencies ?? {}).length}`);
      lines.push(`Установлены ли зависимости (node_modules): ${existsSync(join(root, 'node_modules')) ? 'да' : 'нет — нужен npm_install'}`);
    } catch {
      lines.push('package.json есть, но не читается как JSON');
    }
  }
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) stack.push('Python');
  if (existsSync(join(root, 'prisma', 'schema.prisma'))) stack.push('Prisma (schema.prisma)');
  lines.push(`Git: ${existsSync(join(root, '.git')) ? 'репозиторий есть' : 'нет (git_init)'}`);
  if (stack.length) lines.push(`Стек: ${stack.join(', ')}`);

  const counts = new Map<string, { files: number; lines: number }>();
  let totalFiles = 0;
  const tree: string[] = [];
  for (const e of walk(root)) {
    const rel = relative(root, e.path);
    const depth = rel.split(/[\\/]/).length;
    if (depth <= 2 && tree.length < 80) tree.push(`${'  '.repeat(depth - 1)}${e.dir ? '📁 ' : ''}${basename(e.path)}`);
    if (e.dir) continue;
    totalFiles++;
    const lang = LANGS[extname(e.path).toLowerCase()];
    if (!lang || isSensitivePath(e.path)) continue;
    const st = statSync(e.path);
    const c = counts.get(lang) ?? { files: 0, lines: 0 };
    c.files++;
    if (st.size < 300_000 && isText(e.path)) c.lines += readFileSync(e.path, 'utf8').split('\n').length;
    counts.set(lang, c);
  }
  lines.push(`Файлов (без node_modules и сборки): ${totalFiles}`);
  const langs = [...counts.entries()].sort((a, b) => b[1].lines - a[1].lines).slice(0, 8);
  if (langs.length) lines.push('Языки: ' + langs.map(([l, c]) => `${l} — ${c.files} ф., ~${c.lines} строк`).join('; '));
  lines.push('\nСтруктура:\n' + tree.join('\n'));
  return lines.join('\n');
}

function searchContent(root: string, query: string, glob: string | undefined, regex: boolean): string {
  const re = regex ? new RegExp(query, 'i') : null;
  const q = query.toLowerCase();
  const ext = glob?.replace(/^\*/, '').toLowerCase();
  const found: string[] = [];
  let scanned = 0;
  for (const e of walk(root)) {
    if (e.dir) continue;
    if (found.length >= 60 || scanned > 3000) break;
    if (ext && !e.path.toLowerCase().endsWith(ext)) continue;
    if (isSensitivePath(e.path)) continue;
    let st;
    try {
      st = lstatSync(e.path);
    } catch {
      continue;
    }
    if (st.size > 500_000) continue;
    scanned++;
    if (!isText(e.path)) continue;
    const text = readFileSync(e.path, 'utf8').split('\n');
    for (let i = 0; i < text.length && found.length < 60; i++) {
      const hit = re ? re.test(text[i]!) : text[i]!.toLowerCase().includes(q);
      if (hit) found.push(`${relative(root, e.path)}:${i + 1}: ${text[i]!.trim().slice(0, 160)}`);
    }
  }
  return found.length ? found.join('\n') : 'Совпадений нет.';
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

interface Template {
  description: string;
  files: (name: string) => Record<string, string>;
}

export const TEMPLATES: Record<string, Template> = {
  'node-app': {
    description: 'Node.js-приложение (ES-модули) с тестами на встроенном node:test — работает без установки зависимостей',
    files: (name) => ({
      'package.json': JSON.stringify(
        { name, version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test', start: 'node src/index.js' } },
        null,
        2,
      ) + '\n',
      'src/greet.js': "export function greet(name) {\n  const n = String(name ?? '').trim();\n  return n ? `Привет, ${n}!` : 'Привет!';\n}\n",
      'src/index.js': "import { greet } from './greet.js';\n\nconsole.log(greet(process.argv[2]));\n",
      'test/greet.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.js';\n\ntest('приветствует по имени', () => {\n  assert.equal(greet('Анна'), 'Привет, Анна!');\n});\n\ntest('без имени — общее приветствие', () => {\n  assert.equal(greet('  '), 'Привет!');\n});\n",
      'README.md': `# ${name}\n\nЗапуск: \`npm start\`. Тесты: \`npm test\`.\n`,
      '.gitignore': 'node_modules/\n.env\n.env.*\ndist/\n',
    }),
  },
  'static-site': {
    description: 'Статический сайт: index.html + style.css + script.js (открывается двойным щелчком, сборка не нужна)',
    files: (name) => ({
      'index.html': `<!doctype html>\n<html lang="ru">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${name}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>${name}</h1>\n    <p id="msg">Сайт создан.</p>\n    <button id="btn">Нажми меня</button>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
      'style.css': "body { font-family: system-ui, sans-serif; margin: 0; background: #f6f7fb; color: #1b2133; }\nmain { max-width: 720px; margin: 10vh auto; padding: 0 20px; }\nbutton { padding: 10px 18px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 16px; cursor: pointer; }\n",
      'script.js': "document.getElementById('btn').addEventListener('click', () => {\n  document.getElementById('msg').textContent = 'Работает!';\n});\n",
      'README.md': `# ${name}\n\nОткройте index.html в браузере.\n`,
      '.gitignore': '.env\n.env.*\n',
    }),
  },
};

/** Инструменты программиста: обзор, поиск, правка кода, шаблоны проектов. */
export function registerProjectTools(registry: ToolRegistry, access: ComputerAccessRepo): void {
  const roots = (): string[] => access.get().folders;

  registry.register<{ path: string }>({
    name: 'project_overview',
    description: 'Анализ проекта: стек, скрипты package.json, структура папок, языки и объём кода, есть ли Git. Начинай работу над кодом с него.',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    external: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Папка проекта' } }, required: ['path'] },
    describe: (i) => `Проанализировать проект ${i.path}`,
    execute: (i) =>
      wrap(() => {
        const { abs } = resolveAllowed(i.path, roots());
        if (!statSync(abs).isDirectory()) throw new Error('Это не папка');
        return projectOverview(abs);
      }),
  });

  registry.register<{ path: string; query: string; regex?: boolean; glob?: string }>({
    name: 'code_search',
    description: 'Ищет текст (или регулярное выражение) внутри файлов проекта; возвращает файл:строка: фрагмент. Пропускает node_modules, .git, сборку и файлы с секретами.',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    external: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Папка проекта' },
        query: { type: 'string' },
        regex: { type: 'boolean', description: 'Считать query регулярным выражением' },
        glob: { type: 'string', description: 'Расширение файлов, например *.ts' },
      },
      required: ['path', 'query'],
    },
    describe: (i) => `Искать «${i.query}» в коде ${i.path}`,
    execute: (i) =>
      wrap(() => {
        const { abs } = resolveAllowed(i.path, roots());
        if (!i.query) throw new Error('Пустой запрос');
        if (i.regex && i.query.length > 200) throw new Error('Слишком длинное выражение');
        try {
          return searchContent(abs, i.query, i.glob, i.regex === true);
        } catch (e) {
          if (e instanceof SyntaxError) throw new Error('Некорректное регулярное выражение');
          throw e;
        }
      }),
  });

  registry.register<{ path: string; old: string; new: string; all?: boolean }>({
    name: 'code_edit',
    description:
      'Точечная правка файла: заменяет фрагмент `old` на `new`. `old` должен встречаться в файле РОВНО один раз (или укажи all=true). Предпочитай этот инструмент полной перезаписи файла. Перед правкой прочитай файл (fs_read).',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string', description: 'Точный существующий фрагмент (с пробелами и переносами строк)' },
        new: { type: 'string', description: 'На что заменить' },
        all: { type: 'boolean', description: 'Заменить все вхождения' },
      },
      required: ['path', 'old', 'new'],
    },
    describe: (i) => `Изменить файл ${i.path}:\n— ${clip(String(i.old), 300)}\n+ ${clip(String(i.new), 300)}`,
    execute: (i) =>
      wrap(() => {
        const { abs } = resolveAllowed(i.path, roots());
        if (isProtectedForWrite(abs)) throw new Error('Запись в .git и node_modules запрещена');
        const st = statSync(abs);
        if (!st.isFile()) throw new Error('Это не файл');
        if (st.size > MAX_FILE) throw new Error('Файл слишком большой для правки (больше 1 МБ)');
        if (!isText(abs)) throw new Error('Бинарные файлы править нельзя');
        const text = readFileSync(abs, 'utf8');
        const old = String(i.old);
        if (!old) throw new Error('Пустой фрагмент для замены');
        const count = text.split(old).length - 1;
        if (count === 0) throw new Error('Фрагмент не найден. Прочитай файл заново (fs_read) и скопируй текст точно.');
        if (count > 1 && i.all !== true) throw new Error(`Фрагмент встречается ${count} раз. Добавь контекста, чтобы он был уникальным, или укажи all=true.`);
        const next = i.all === true ? text.split(old).join(String(i.new)) : text.replace(old, () => String(i.new));
        if (Buffer.byteLength(next) > MAX_FILE) throw new Error('Результат больше 1 МБ');
        writeFileSync(abs, next);
        return `Файл изменён: ${abs} (замен: ${i.all === true ? count : 1})`;
      }),
  });

  registry.register({
    name: 'project_templates',
    description: 'Список готовых шаблонов проектов для project_scaffold.',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Показать шаблоны проектов',
    execute: () => Object.entries(TEMPLATES).map(([k, t]) => `• ${k} — ${t.description}`).join('\n'),
  });

  registry.register<{ template: string; path: string }>({
    name: 'project_scaffold',
    description: 'Создаёт новый проект из шаблона (см. project_templates) в НОВОЙ папке внутри разрешённой. Существующую непустую папку не трогает.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', enum: Object.keys(TEMPLATES) },
        path: { type: 'string', description: 'Полный путь новой папки проекта' },
      },
      required: ['template', 'path'],
    },
    describe: (i) => `Создать проект «${i.template}» в папке ${i.path}`,
    execute: (i) =>
      wrap(() => {
        const t = TEMPLATES[i.template];
        if (!t) throw new Error('Неизвестный шаблон');
        const { abs } = resolveAllowed(i.path, roots(), { allowMissing: true });
        if (isProtectedForWrite(abs)) throw new Error('Запись в .git и node_modules запрещена');
        if (existsSync(abs) && readdirSync(abs).length > 0) throw new Error('Папка уже существует и не пуста');
        const name = basename(abs).replace(/[^\w.-]+/g, '-').toLowerCase().replace(/^[^a-z0-9]+/, '') || 'app';
        const files = t.files(name);
        for (const [rel, content] of Object.entries(files)) {
          const target = join(abs, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, { flag: 'wx' });
        }
        return `Проект создан: ${abs}\nФайлы:\n${Object.keys(files).map((f) => '  ' + f).join('\n')}`;
      }),
  });
}
