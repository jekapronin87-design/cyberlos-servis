// Сквозная проверка главного экрана (HUD) и камеры в настоящем Electron с поддельной камерой.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-hud-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const args = ['.', '--use-fake-device-for-media-stream'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1400, height: 860 });

  // 1. HUD
  await page.waitForSelector('.hud');
  await page.waitForSelector('canvas.orb-canvas');
  assert.equal(await page.getAttribute('canvas.orb-canvas', 'data-state'), 'idle');
  const painted = await page.evaluate(() => {
    const c = document.querySelector('canvas.orb-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 20) n++;
    return n;
  });
  assert.ok(painted > 200, 'шар должен быть нарисован, пикселей: ' + painted);
  await page.waitForTimeout(2000); // конец заставки
  await page.screenshot({ path: join(shots, 'u1-hud.png') });
  step('главный экран HUD: шар нарисован, состояние «готов»');

  // 2. Камера заблокирована, пока не включена
  const video = () => page.evaluate(async () => {
    try { (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop()); return 'granted'; } catch (e) { return e.name; }
  });
  assert.equal(await video(), 'NotAllowedError');
  step('камера заблокирована на уровне приложения, пока не разрешена');

  // 3. Включение камеры кнопкой (с подтверждением) → превью и индикатор
  await page.click('[data-testid=hud-cam]');
  await page.waitForSelector('.hud-cam video');
  assert.ok(await page.locator('.flag-on:has-text("КАМ")').count());
  await page.screenshot({ path: join(shots, 'u2-camera.png') });
  step('камера включена: превью и красный индикатор');

  // 4. «Что я делаю?» — Джарвис смотрит без лишних окон подтверждения
  await page.fill('.hud-input', 'Джарвис, посмотри на меня');
  await page.press('.hud-input', 'Enter');
  await page.waitForSelector('.act-ok:has-text("Смотрю на вас")', { timeout: 20000 });
  assert.equal(await page.locator('[role=alertdialog]').count(), 0);
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.tool-card .shot', { timeout: 10000 });
  step('кадр с камеры снят по просьбе, показан миниатюрой, без окна подтверждения');
  await page.click('.nav-item:has-text("Системно")');

  // 5. Камера выключена кнопкой — инструмент отказывает
  await page.click('[data-testid=hud-cam]');
  await page.waitForSelector('.hud-cam', { state: 'detached' });
  await page.fill('.hud-input', 'посмотри на меня');
  await page.press('.hud-input', 'Enter');
  await page.waitForSelector('.act-err:has-text("Смотрю на вас")', { timeout: 20000 });
  step('при выключенной камере ассистент не получает кадр');

  // 6. Главный выключатель
  await page.evaluate(() => window.jarvis.settings.update({ cameraEnabled: false }));
  assert.equal(await video(), 'NotAllowedError');
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(500)));
  assert.ok(log.includes('camera_look'));
  step('главный выключатель закрывает камеру; обращения к камере в журнале');

  // 7. Настройки личности сохраняются
  await page.evaluate(() => window.jarvis.settings.update({ userName: 'Евгений', launchAtLogin: false, ttsVoice: 'onyx' }));
  await page.reload();
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('text=Личность');
  assert.equal(await page.inputValue('input[placeholder="Например: Евгений"]'), 'Евгений');
  await page.screenshot({ path: join(shots, 'u3-settings.png') });
  step('настройки личности, камеры и голоса на месте');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('HUD SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('HUD SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'u-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
