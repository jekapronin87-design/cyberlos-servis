// Проверка среды разработки: npm run doctor
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
const ok = (m) => console.log('  [ OK ]', m);
const bad = (m, hint) => (failed++, console.log('  [FAIL]', m + (hint ? ' — ' + hint : '')));
const warn = (m) => console.log('  [WARN]', m);
const run = (c) => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

console.log('JARVIS: проверка среды\n');
console.log(`Платформа: ${process.platform} ${process.arch}`);
const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node}`, 'нужен 22.13+ (https://nodejs.org)');
const npm = run('npm -v');
npm ? ok(`npm ${npm}`) : bad('npm не найден');
const git = run('git --version');
git ? ok(git) : warn('Git не найден (нужен с этапа 4 — ИИ-программист)');
try { await import('node:sqlite'); ok('node:sqlite (встроенный SQLite, без компиляции)'); } catch { bad('node:sqlite недоступен', 'обновите Node.js до 22.13+'); }
existsSync(resolve(root, 'node_modules')) ? ok('зависимости установлены') : bad('node_modules отсутствует', 'выполните npm install');
try {
  const p = require('electron');
  existsSync(p) ? ok(`Electron: ${require('electron/package.json').version}`) : bad('бинарник Electron не скачан', 'удалите node_modules и выполните npm install');
} catch { bad('Electron не установлен', 'npm install'); }
if (process.platform === 'win32') ok('Windows: шифрование секретов через DPAPI доступно');
else warn('Не Windows: целевая платформа JARVIS — Windows 10/11; на других ОС возможен запуск для разработки');
console.log(failed ? `\nПроблем: ${failed}` : '\nСреда готова. Запуск: npm start');
process.exit(failed ? 1 : 0);
