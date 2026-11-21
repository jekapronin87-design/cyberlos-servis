// Дымовой тест настоящего приложения: запускает Electron, проходит основные сценарии, делает скриншоты.
//   npm run build && node scripts/smoke.mjs        (Linux: xvfb-run -a node scripts/smoke.mjs)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-smoke-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });

const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu'); // root в контейнере

const app = await electron.launch({
  executablePath: electronPath,
  args,
  cwd: root,
  env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' },
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1180, height: 780 });
  await page.waitForSelector('.welcome');
  const step = (m) => console.log('  ✓', m);

  // 1. Безопасность окна
  const isolation = await page.evaluate(() => ({
    node: typeof require !== 'undefined' || typeof process !== 'undefined',
    api: Object.keys(window.jarvis).sort().join(','),
  }));
  assert.equal(isolation.node, false, 'в рендерере не должно быть Node');
  assert.equal(isolation.api, 'app,audit,chat,confirm,conversations,memory,secrets,settings');
  step('рендерер изолирован, API узкий');

  // 2. Демо-режим
  assert.match(await page.textContent('.banner-demo'), /Демо-режим/);
  await page.screenshot({ path: join(shots, '1-welcome.png') });
  step('демо-режим включён без ключа');

  // 3. Чат
  const send = async (t) => {
    await page.waitForSelector('button:has-text("Отправить")'); // предыдущий запуск завершён
    await page.fill('textarea', t);
    await page.press('textarea', 'Enter');
  };
  await send('Привет, Джарвис');
  await page.waitForSelector('.bubble-assistant:has-text("демонстрационном режиме")');
  step('ответ получен');

  // 4. Инструмент без подтверждения
  await send('Который час?');
  await page.waitForSelector('.tool-card:has-text("get_datetime")');
  step('безопасный инструмент вызван');

  // 5. Память + подтверждение опасного действия
  await send('Запомни: люблю короткие ответы');
  await page.waitForSelector('.tool-card:has-text("Сохранено в память")');
  await send('Забудь 1');
  await page.waitForSelector('[role=alertdialog]');
  await page.screenshot({ path: join(shots, '2-confirm.png') });
  await page.click('text=Отклонить');
  await page.waitForSelector('.tool-card:has-text("Отклонено")');
  step('подтверждение: отказ блокирует действие');
  await send('Забудь 1');
  await page.waitForSelector('[role=alertdialog]');
  await page.click('text=Разрешить');
  await page.waitForSelector('.tool-card:has-text("удалена")');
  step('подтверждение: «Разрешить» выполняет действие');
  await page.screenshot({ path: join(shots, '3-chat.png') });

  // 6. Стоп во время подтверждения
  await send('Запомни: ещё один факт');
  await page.waitForSelector('.tool-card:has-text("#2")');
  await send('Забудь 2');
  await page.waitForSelector('[role=alertdialog]');
  await page.click('[role=alertdialog] >> text=Остановить задачу');
  await page.waitForSelector('[role=alertdialog]', { state: 'detached' });
  await page.waitForSelector('button:has-text("Отправить")');
  step('«Стоп» закрывает подтверждение и останавливает запуск');

  // 7. Настройки, журнал
  await page.click('.nav-item:has-text("Настройки")');
  await page.selectOption('select >> nth=1', 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.screenshot({ path: join(shots, '4-settings.png') });
  await page.selectOption('select >> nth=1', 'dark');
  await page.fill('input[type=password]', 'коротко');
  await page.click('.card:has-text("API-ключ") button:has-text("Сохранить") >> nth=-1').catch(() => {});
  await page.click('.nav-item:has-text("Журнал")');
  await page.click('text=Проверить целостность');
  await page.waitForSelector('text=Целостность подтверждена');
  await page.screenshot({ path: join(shots, '5-audit.png') });
  step('настройки и журнал работают, цепочка журнала цела');

  // 8. История переживает перезапуск
  await app.close();
  const app2 = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
  const p2 = await app2.firstWindow();
  await p2.waitForSelector('.bubble-user');
  assert.ok((await p2.locator('.bubble-user').count()) >= 4);
  assert.equal(await p2.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await app2.close();
  step('история и настройки сохранились после перезапуска');

  assert.deepEqual(errors, [], 'ошибки в консоли рендерера: ' + errors.join('; '));
  console.log('SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('SMOKE FAILED:', e);
  try {
    const w = await app.firstWindow();
    await w.screenshot({ path: join(shots, 'failure.png') });
  } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
