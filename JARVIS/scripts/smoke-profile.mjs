// Сквозная проверка досье о пользователе и скорости речи в настоящем Electron.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-prof-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const notes = join(dataDir, 'о-себе.txt');
writeFileSync(notes, 'Меня зовут Евгений. Развиваю CRM для сервиса станций. Жена Анна.');
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', JARVIS_E2E_PICK: JSON.stringify({ file: notes }) } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.waitForSelector('.hud');

  // 1. Досье: пустое, ручное заполнение
  await page.click('.nav-item:has-text("Досье")');
  await page.waitForSelector('h1:has-text("Досье")');
  const about = page.locator('.card:has(h2:has-text("Обо мне")) textarea');
  await about.fill('Евгений, Москва. Люблю кофе без сахара.');
  await page.click('.card:has(h2:has-text("Обо мне")) button:has-text("Сохранить")');
  await page.waitForSelector('.banner-ok:has-text("Сохранено")');
  await page.screenshot({ path: join(shots, 'p1-profile.png') });
  step('раздел досье сохраняется');

  // 2. Секреты не принимаются
  await page.locator('.card:has(h2:has-text("Работа")) textarea').fill('пароль от банка: Qwerty12345');
  await page.click('.card:has(h2:has-text("Работа")) button:has-text("Сохранить")');
  await page.waitForSelector('.banner-err:has-text("секреты")');
  step('пароль в досье не принимается');

  // 3. Импорт из файла: текст уходит в диалог (демо-режим отвечает шаблоном)
  await page.click('button:has-text("Импорт из файла")');
  await page.waitForSelector('.hud');
  await page.waitForSelector('.cap-user:has-text("Меня зовут Евгений")', { timeout: 15000 });
  step('импорт из файла: текст отправлен Джарвису для выделения важного');

  // 4. Досье сохранено на диске и видно после перезапуска окна
  await page.reload();
  await page.click('.nav-item:has-text("Досье")');
  await page.waitForSelector('textarea:has-text("Люблю кофе без сахара")');
  step('досье сохраняется между перезапусками');

  // 5. Скорость речи в настройках и выключатель досье
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('text=Скорость речи');
  await page.waitForSelector('#update-card button:has-text("Проверить обновления")');
  assert.match(await page.textContent('.field:has-text("Скорость речи")'), /×1\.15/);
  await page.screenshot({ path: join(shots, 'p2-settings.png') });
  step('скорость речи по умолчанию ×1.15, настройка на месте');

  // 6. Очистка и журнал без текста
  await page.click('.nav-item:has-text("Досье")');
  await page.click('button:has-text("Очистить всё")');
  await page.waitForSelector('.banner-ok:has-text("очищено")');
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  assert.ok(log.includes('profile.update') && log.includes('profile.clear'));
  assert.ok(!log.includes('кофе без сахара'));
  step('очистка работает; в журнале нет текста досье');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('PROFILE SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('PROFILE SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'p-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
