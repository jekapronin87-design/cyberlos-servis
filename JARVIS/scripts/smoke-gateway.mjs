// Сквозная проверка доступа с телефона: настоящий Electron + отдельный «телефонный» Chromium с мобильным экраном.
import { _electron as electron, chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const chromePath = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-gw-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
let phoneBrowser;
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1300, height: 950 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('#gateway-card');
  assert.equal(await page.locator('#gateway-mode').inputValue(), 'off');
  assert.equal(await page.locator('#gateway-code-btn').count(), 0, 'при выключенном шлюзе кода быть не должно');
  step('по умолчанию доступ с телефона выключен');

  await page.selectOption('#gateway-mode', 'localhost');
  await page.waitForSelector('#gateway-code-btn');
  const url = (await page.locator('.gw-url').first().textContent())?.trim();
  assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
  step('режим включён, адрес показан: ' + url);

  await page.click('#gateway-code-btn');
  const code = (await page.locator('#gateway-code').textContent())?.trim();
  assert.match(code ?? '', /^\d{6}$/);
  await page.screenshot({ path: join(shots, 'g1-desktop.png') });
  step('код подключения показан только на компьютере');

  phoneBrowser = await chromium.launch({ executablePath: existsSync(chromePath) ? chromePath : undefined, args: ['--no-sandbox'] });
  const ctx = await phoneBrowser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push('phone: ' + e));
  await phone.goto(url);
  await phone.waitForSelector('#pair:not([hidden])');
  await phone.fill('#code', '000000' === code ? '111111' : '000000');
  await phone.fill('#devname', 'Телефон Тест');
  await phone.click('#pairBtn');
  await phone.waitForSelector('#pairErr:has-text("Неверный")');
  step('неверный код на телефоне отвергнут');

  await phone.fill('#code', code);
  await phone.click('#pairBtn');
  await phone.waitForSelector('#app:not([hidden])');
  step('телефон подключён по коду');

  await phone.fill('#text', 'Привет, Джарвис');
  await phone.click('#send');
  await phone.waitForSelector('.m.user:has-text("Привет, Джарвис")');
  await phone.waitForSelector('.m.assistant', { timeout: 20000 });
  await phone.screenshot({ path: join(shots, 'g2-phone.png') });
  step('сообщение с телефона дошло, ответ получен: ' + (await phone.locator('.m.assistant').last().textContent()).slice(0, 60));

  // после перезагрузки страницы — тот же телефон (токен сохранён), история на месте
  await phone.reload();
  await phone.waitForSelector('#app:not([hidden])');
  await phone.waitForSelector('.m.user:has-text("Привет, Джарвис")');
  step('после перезагрузки телефон остаётся подключённым, история сохранена');

  // отзыв на компьютере
  await page.click('#gateway-card button:has-text("Отключить")');
  await page.waitForSelector('#gateway-card :text("Пока нет.")');
  await phone.reload();
  await phone.waitForSelector('#pair:not([hidden])');
  step('отключение на компьютере немедленно лишает телефон доступа');

  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(200)));
  for (const a of ['gateway.start', 'gateway.pair_code_issued', 'gateway.pair_failed', 'gateway.paired', 'gateway.chat', 'gateway.device_revoked']) assert.ok(log.includes(a), 'нет записи аудита ' + a);
  step('все события записаны в журнал');

  await page.selectOption('#gateway-mode', 'off');
  await page.waitForSelector('#gateway-code-btn', { state: 'detached' });
  await phone.reload().then(() => assert.fail('сервер должен быть остановлен')).catch((e) => assert.ok(!(e.code === 'ERR_ASSERTION')));
  step('выключение режима останавливает сервер');

  assert.deepEqual(errors, [], 'ошибки: ' + errors.join('; '));
  console.log('GATEWAY SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('GATEWAY SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'g-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await phoneBrowser?.close().catch(() => {});
  await app.close().catch(() => {});
}
