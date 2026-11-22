// Интерфейс Telegram в настоящем Electron. Сеть Telegram здесь недоступна, поэтому проверяем всё до подключения:
// инструкция, проверку токена, честные ошибки. Логика переписки (с поддельным сервером Telegram) покрыта tests/telegram.test.ts.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-tg-'));
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
  await page.setViewportSize({ width: 1300, height: 950 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Telegram")');
  await page.waitForSelector('#tg-connect');
  assert.match(await page.textContent('#tg-connect'), /BotFather/);
  assert.equal(await page.locator('#tg-connect-btn').isDisabled(), true);
  step('инструкция по созданию бота показана, без токена кнопка недоступна');

  await page.fill('#tg-token', 'abc');
  await page.click('#tg-connect-btn');
  await page.waitForSelector('.banner-err:has-text("Токен выглядит неверно")');
  await page.screenshot({ path: join(shots, 'tg1.png') });
  step('неверный токен отвергается понятным сообщением (в сеть не уходит)');

  const st = await page.evaluate(async () => window.jarvis.telegram.status());
  assert.equal(st.connected, false);
  const code = await page.evaluate(() => window.jarvis.telegram.pairCode().then(() => 'ok', (e) => String(e.message)));
  assert.match(code, /подключите бота/);
  step('код привязки без бота не выдаётся');

  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('#modules-card');
  await page.locator('#modules-card label:has-text("Telegram") input').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.nav-item')].some((n) => n.textContent.includes('Telegram')));
  step('модуль можно отключить — вкладка исчезает');

  assert.deepEqual(errors, [], 'ошибки: ' + errors.join('; '));
  console.log('TELEGRAM SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('TELEGRAM SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'tg-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
