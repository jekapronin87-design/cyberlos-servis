// Проверка «цифрового пространства»: голосовые/текстовые переходы без модели, карточки аналитики, город бизнеса.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-space-'));
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
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.hud');
  assert.ok(await page.locator('.starfield').count(), 'космический фон на месте');

  // звуки интерфейса: клик по кнопке действительно запускает звук (счётчик проигранных звуков растёт)
  const p0 = await page.evaluate(() => window.__uiSounds.played);
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForTimeout(300);
  await page.click('.nav-item:has-text("Системно")');
  const p1 = await page.evaluate(() => window.__uiSounds.played);
  assert.ok(p1 > p0, `звуки интерфейса не воспроизводятся: ${p0} → ${p1}`);
  step(`звуки на кнопки работают (проиграно: ${p1 - p0})`);

  await page.fill('.hud-input', 'Открой аналитику');
  await page.press('.hud-input', 'Enter');
  await page.waitForSelector('[data-testid=space] .sp-tile');
  await page.waitForSelector('.space-banner:has-text("ПРИМЕР ДАННЫХ")');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, 's1-analytics.png') });
  assert.ok((await page.locator('.sp-card').count()) >= 8);
  step('«Открой аналитику» → пространство с карточками (без обращения к модели), пример данных помечен');

  await page.click('.space-tabs button:has-text("Город")');
  await page.waitForSelector('.city-canvas');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, 's2-city.png') });
  step('вкладка «Город»: изометрический город бизнеса');

  await page.click('.space-close');
  await page.waitForSelector('.hud');
  await page.fill('.hud-input', 'Покажи наш город');
  await page.press('.hud-input', 'Enter');
  await page.waitForSelector('.city-canvas');
  step('«Покажи наш город» открывает город сразу');

  const msgs = await page.evaluate(async () => (await window.jarvis.conversations.list()).length);
  assert.equal(msgs, 0, 'навигация не должна создавать диалоги и тратить запросы к модели');
  assert.deepEqual(errors, [], 'ошибки: ' + errors.join('; '));
  console.log('SPACE SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('SPACE SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 's-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
