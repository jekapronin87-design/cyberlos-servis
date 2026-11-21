// Сквозная проверка телефонии (симулятор) в настоящем Electron.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-tel-'));
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
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Звонки")');
  await page.waitForSelector('h1:has-text("Звонки наставника")');
  await page.waitForSelector('.banner:has-text("Реальные звонки не подключены")');
  step('честно сказано, что реальных звонков нет (только симулятор)');

  // окно времени на весь день, чтобы проверка не зависела от часа запуска
  const times = page.locator('#limits-card input[type=time]');
  await times.nth(0).fill('00:00');
  await times.nth(1).fill('23:59');
  await page.click('#limits-card button:has-text("Сохранить")');
  await page.waitForSelector('.banner-ok:has-text("Сохранено")');

  await page.fill('#consent-card input[placeholder^="Телефон"]', '8 916 123-45-67');
  await page.fill('#consent-card input[placeholder^="Имя"]', 'Анна Петрова');
  assert.equal(await page.locator('#consent-add').isDisabled(), true, 'без подтверждения согласия кнопка должна быть недоступна');
  await page.check('#consent-confirm');
  await page.click('#consent-add');
  await page.waitForSelector('#consent-card .list-item:has-text("Анна Петрова")');
  step('согласие вносится только с явным подтверждением');

  await page.selectOption('#call-phone', { index: 1 });
  await page.selectOption('#call-lesson', { index: 1 });
  await page.click('#call-start');
  await page.waitForSelector('.call-jarvis:has-text("программа, а не человек")');
  assert.match(await page.textContent('#call-log'), /не записывается/);
  await page.screenshot({ path: join(shots, 't1-call.png') });
  step('Джарвис представляется ИИ и сообщает, что запись не ведётся');

  await page.waitForFunction(() => !document.querySelector('#call-send')?.disabled);
  await page.fill('#call-reply', 'да, удобно');
  await page.click('#call-send');
  await page.waitForSelector('.call-jarvis:has-text("Вопрос.")', { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('#call-send')?.disabled);
  await page.fill('#call-reply', 'стоп');
  await page.click('#call-send');
  await page.waitForSelector('#call-result:has-text("остановил")');
  await page.screenshot({ path: join(shots, 't2-call-done.png') });
  step('«стоп» завершает звонок вежливо');

  await page.click('button:has-text("Закрыть")');
  await page.waitForSelector('.list-item:has-text("остановил")');
  const text = await page.locator('.list-item:has-text("остановил")').first().textContent();
  assert.ok(!text.includes('9161234567'), 'номер в журнале должен быть замаскирован');
  step('в журнале звонок есть, номер замаскирован');

  await page.click('#consent-card button:has-text("Отозвать")');
  await page.waitForSelector('#consent-card .tag:has-text("отозвано")');
  await page.waitForFunction(() => ![...document.querySelectorAll('#call-phone option')].some((o) => o.textContent.includes('Анна')));
  step('после отзыва согласия звонить этому сотруднику нельзя');

  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(200)));
  for (const a of ['telephony.consent_granted', 'telephony.call_started', 'telephony.call_finished', 'telephony.consent_revoked']) assert.ok(log.includes(a), 'нет аудита ' + a);
  assert.ok(!log.includes('9161234567'), 'номер не должен попадать в журнал аудита открытым');
  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('TELEPHONY SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('TELEPHONY SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 't-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
