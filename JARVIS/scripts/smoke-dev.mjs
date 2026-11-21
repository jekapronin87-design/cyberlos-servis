// Сквозная проверка этапа 4 в настоящем Electron: проект из шаблона, запуск тестов (npm внутри Electron), Git.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-dev-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const work = join(realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-devwork-'))), 'Work');
mkdirSync(work);
const proj = join(work, 'my-app');

const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const env = {
  ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', JARVIS_E2E_PICK: JSON.stringify({ folder: work }),
  GIT_AUTHOR_NAME: 'Smoke', GIT_AUTHOR_EMAIL: 's@example.com', GIT_COMMITTER_NAME: 'Smoke', GIT_COMMITTER_EMAIL: 's@example.com',
};
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.welcome');
  const send = async (t) => {
    await page.waitForSelector('button:has-text("Отправить")');
    await page.fill('textarea', t);
    await page.press('textarea', 'Enter');
  };
  const dialog = '[role=alertdialog]';
  const allow = () => page.click(`${dialog} >> button:has-text("Разрешить")`);
  const deny = () => page.click(`${dialog} >> button:has-text("Отклонить")`);

  await page.evaluate(() => window.jarvis.computer.addFolder());
  assert.deepEqual((await page.evaluate(() => window.jarvis.computer.get())).folders, [work]);

  // 1. Проект из шаблона — с подтверждением
  await send(`Создай проект node-app ${proj}`);
  await page.waitForSelector(dialog);
  assert.match(await page.textContent(dialog), /Создать проект «node-app»/);
  await deny();
  assert.equal(existsSync(proj), false);
  await send(`Создай проект node-app ${proj}`);
  await page.waitForSelector(dialog);
  await allow();
  await page.waitForSelector('.tool-card:has-text("Проект создан")');
  assert.ok(existsSync(join(proj, 'package.json')));
  step('проект создан из шаблона после подтверждения (отказ — ничего не создаётся)');

  // 2. Обзор проекта и поиск
  await send(`Проанализируй проект ${proj}`);
  await page.waitForSelector('.tool-card:has-text("Node.js-проект")');
  await send(`Найди в коде greet в ${proj}`);
  await page.waitForSelector('.tool-card:has-text("src/greet.js")');
  step('анализ проекта и поиск по коду работают без подтверждений');

  // 3. Запуск тестов: окно показывает точную команду; npm запускается внутри Electron
  await send(`Запусти тесты ${proj}`);
  await page.waitForSelector(dialog);
  const text = await page.textContent(dialog);
  assert.match(text, /npm run test/);
  assert.match(text, /node --test/);
  await page.screenshot({ path: join(shots, 'd1-confirm-test.png') });
  await allow();
  await page.waitForSelector('.tool-card:has-text("код выхода 0")', { timeout: 60000 });
  step('тесты запущены через npm внутри Electron: код выхода 0');

  // 4. «Сломанный» проект: тесты падают, и ассистент сообщает об ошибке
  const f = join(proj, 'src', 'greet.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace('Привет, ${n}!', 'Ой, ${n}!'));
  await send(`Запусти тесты ${proj}`);
  await page.waitForSelector(dialog);
  await allow();
  await page.waitForSelector('.tool-card:has-text("Ошибка: проанализируй вывод")', { timeout: 60000 });
  await page.screenshot({ path: join(shots, 'd2-failed-tests.png') });
  step('падающие тесты: вывод ошибки возвращается ассистенту');
  writeFileSync(f, readFileSync(f, 'utf8').replace('Ой, ${n}!', 'Привет, ${n}!'));

  // 5. Git
  await send(`git init ${proj}`);
  await page.waitForSelector(dialog);
  await allow();
  await page.waitForSelector('.tool-card:has-text("Initialized")');
  await send(`git commit ${proj} Первый коммит`);
  await page.waitForSelector(dialog);
  assert.match(await page.textContent(dialog), /Закоммитить все изменения/);
  await allow();
  await page.waitForSelector('.tool-card:has-text("root-commit")');
  assert.match(execFileSync('git', ['log', '--oneline'], { cwd: proj }).toString(), /Первый коммит/);
  await send(`git status ${proj}`);
  await page.waitForSelector('.tool-card:has-text("## main")');
  await page.screenshot({ path: join(shots, 'd3-git.png') });
  step('Git: init, commit (с подтверждением), status');

  // 6. Журнал
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(500)));
  for (const a of ['project_scaffold', 'run_script', 'git_commit']) assert.ok(log.includes(a), 'нет в журнале: ' + a);
  assert.equal((await page.evaluate(() => window.jarvis.audit.verify())).ok, true);
  step('действия записаны в журнал, цепочка цела');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('DEV SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('DEV SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'd-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
