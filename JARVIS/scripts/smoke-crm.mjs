// Сквозная проверка подключения к CRM в настоящем Electron: фиктивный сервер CRM из tests/crmFixture.ts.
//   node --experimental-strip-types scripts/smoke-crm.mjs   (Node 22.6+)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startCrmFixture } from '../tests/crmFixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-crm-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const fx = await startCrmFixture();
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

  // 1. Без подключения экран CRM объясняет, что делать
  await page.click('.nav-item:has-text("CRM")');
  await page.waitForSelector('.banner-err:has-text("не подключена")');
  step('без подключения экран CRM подсказывает, что делать');

  // 2. Настройка в интерфейсе
  await page.click('.nav-item:has-text("Настройки")');
  const card = page.locator('#crm-card');
  await card.locator('input[placeholder^="https://api"]').fill(fx.url.replace('http://', 'http://')); // localhost-адрес разрешён
  await card.locator('input[placeholder^="jarvis@"]').fill('jarvis@aquamaster.ru');
  await card.locator('input[type=password]').fill('ro-pass-123');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  await card.locator('button:has-text("Проверить подключение")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Подключено")');
  assert.match(await card.textContent(), /только чтение/);
  await page.screenshot({ path: join(shots, 'r1-settings.png') });
  step('подключение проверено: учётная запись признана безопасной для чтения');

  // 3. Опасная учётная запись — предупреждение
  await card.locator('input[placeholder^="jarvis@"]').fill('power@aquamaster.ru');
  await card.locator('input[type=password]').fill('p');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  await card.locator('button:has-text("Проверить подключение")').click();
  await page.waitForSelector('#crm-card :text("права на изменение данных")');
  await card.locator('input[placeholder^="jarvis@"]').fill('jarvis@aquamaster.ru');
  await card.locator('input[type=password]').fill('ro-pass-123');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  step('учётная запись с правами на изменение — предупреждение');

  // 4. Экран CRM: плитки, менеджеры, замечания
  await page.click('.nav-item:has-text("CRM")');
  await page.waitForSelector('.tile:has-text("Просрочено по SLA")', { timeout: 20000 });
  await page.waitForSelector('td:has-text("Анна Соколова")');
  await page.waitForSelector('.list-item:has-text("Не заполнены обязательные поля")');
  await page.waitForSelector('text=Кому нужно обучение');
  await page.screenshot({ path: join(shots, 'r2-crm.png'), fullPage: true });
  step('экран CRM: плитки, менеджеры, замечания, рекомендации по обучению');

  // 5. Ассистент (демо-режим) видит инструмент, а CRM остаётся только для чтения
  const logins = fx.requests.filter((r) => r.method === 'POST');
  const writes = fx.requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/auth/login'));
  assert.equal(writes.length, 0, 'в CRM не должно уходить ничего, кроме входа и чтения');
  assert.ok(logins.length >= 1);
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  assert.ok(log.includes('crm.configured') && log.includes('crm.test'));
  assert.ok(!log.includes('ro-pass-123'));
  step('в CRM ушли только вход и чтение; пароль не попал в журнал');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('CRM SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('CRM SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'r-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fx.close();
}
