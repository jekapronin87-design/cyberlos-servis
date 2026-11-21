// Сквозная проверка задач по расписанию в настоящем Electron (демо-режим: без модели задача сообщает, что нужен Claude).
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-jobs-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1300, height: 950 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Задачи")');
  await page.waitForSelector('h1:has-text("Задачи по расписанию")');

  await page.click('button:has-text("Утренняя сводка по CRM")');
  await page.waitForSelector('.list-item:has-text("Утренняя сводка по CRM")');
  assert.match(await page.textContent('.list-item'), /по будням в 09:00/);
  step('задача создана из шаблона, расписание показано');

  await page.fill('input[placeholder^="Например: Проверка"]', 'Моя проверка');
  await page.fill('textarea', 'Проверь заявки. Если нет просроченных — ответь «OK».');
  await page.click('button:has-text("Создать")');
  await page.waitForSelector('.list-item:has-text("Моя проверка")');
  step('своя задача создана');

  await page.locator('.list-item:has-text("Моя проверка") button:has-text("Выполнить сейчас")').click();
  await page.waitForSelector('.banner:has-text("нужна модель Claude")');
  await page.waitForSelector('.list-item:has-text("Моя проверка"):has-text("ошибка")');
  await page.screenshot({ path: join(shots, 'j1-jobs.png') });
  step('без ключа Claude задача честно сообщает, что нужна модель');

  await page.locator('.list-item:has-text("Моя проверка") button:has-text("Выключить")').click();
  await page.waitForSelector('.list-item:has-text("Моя проверка"):has-text("выключена")');
  await page.locator('.list-item:has-text("Моя проверка") button:has-text("Удалить")').click();
  await page.waitForSelector('.list-item:has-text("Моя проверка")', { state: 'detached' });
  step('выключение и удаление работают');

  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(200)));
  assert.ok(log.includes('job.create') && log.includes('job.delete'));
  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('JOBS SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('JOBS SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'j-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
