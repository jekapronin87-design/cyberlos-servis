// Раздел «Агенты» в настоящем Electron: заготовка → сохранение → список → понятная причина отказа без модели → удаление.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-ag-'));
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
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Агенты")');
  await page.waitForSelector('#agent-templates');
  assert.ok((await page.locator('#agent-templates button').count()) >= 8);
  step('раздел «Агенты» открыт, заготовки на месте');

  await page.click('#agent-templates button:has-text("Аналитик CRM")');
  await page.waitForSelector('#agent-editor #agent-instructions');
  assert.match(await page.inputValue('#agent-instructions'), /crm_overview/);
  assert.equal(await page.locator('[data-group=crm]').isChecked(), true);
  assert.equal(await page.locator('[data-group=files]').isChecked(), false);
  assert.equal(await page.inputValue('#agent-mode'), 'read');
  await page.click('#agent-save');
  await page.waitForSelector('.banner-ok:has-text("Агент сохранён")');
  await page.waitForSelector('[data-agent="Аналитик CRM"]');
  await page.screenshot({ path: join(shots, 'a1-agent.png') });
  step('агент из заготовки создан: права только на CRM, режим «только чтение»');

  await page.click('#agent-run');
  await page.waitForSelector('.banner-err:has-text("нужна настоящая модель")');
  step('без модели запуск честно отказывает с причиной');

  // свой агент с правами на файлы и режимом «с действиями»
  await page.click('#agent-new');
  await page.fill('#agent-name', 'Мой помощник');
  await page.fill('#agent-instructions', 'Помогай мне с файлами в рабочей папке: ищи и читай документы.');
  await page.locator('[data-group=files]').check();
  await page.selectOption('#agent-mode', 'act');
  await page.click('#agent-save');
  await page.waitForSelector('[data-agent="Мой помощник"]');
  const list = await page.evaluate(() => window.jarvis.agents.list());
  const mine = list.find((a) => a.name === 'Мой помощник');
  assert.deepEqual(mine.groups, ['files']);
  assert.equal(mine.mode, 'act');
  step('свой агент создан с правами на файлы');

  await page.click('#agent-save'); // повторное сохранение того же агента не создаёт дубль
  await page.waitForTimeout(300);
  assert.equal((await page.evaluate(() => window.jarvis.agents.list())).length, 2);

  // пустая инструкция — понятная ошибка
  await page.click('#agent-new');
  await page.fill('#agent-name', 'Пустой');
  await page.click('#agent-save');
  await page.waitForSelector('.banner-err:has-text("Инструкция агента")');
  step('проверка ввода: пустая инструкция отклонена');

  await page.locator('[data-agent="Мой помощник"]').click();
  await page.click('#agent-editor button:has-text("Удалить")');
  await page.waitForSelector('[data-agent="Мой помощник"]', { state: 'detached' });
  step('агента можно удалить');

  // заготовки для YouTube и Telegram
  await page.click('#agent-templates button:has-text("YouTube-аналитик")');
  await page.waitForSelector('#agent-editor #agent-instructions');
  assert.equal(await page.locator('[data-group=youtube]').isChecked(), true);
  assert.equal(await page.locator('[data-group=telegram]').isChecked(), false);
  assert.equal(await page.inputValue('#agent-mode'), 'read');
  await page.click('#agent-templates button:has-text("Контент YouTube и Telegram")');
  assert.equal(await page.locator('[data-group=youtube]').isChecked(), true);
  assert.equal(await page.locator('[data-group=telegram]').isChecked(), true);
  assert.equal(await page.inputValue('#agent-mode'), 'act');
  await page.screenshot({ path: join(shots, 'a2-youtube-agent.png') });
  step('заготовки «YouTube-аналитик» (только чтение) и «Контент YouTube и Telegram» (с подтверждением) на месте');

  // карточка YouTube в настройках
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('#youtube-card');
  assert.match(await page.textContent('#youtube-card'), /YouTube Data API v3/);
  await page.fill('#yt-key', '123');
  await page.click('#yt-save');
  await page.waitForSelector('#youtube-card .banner-err:has-text("Ключ выглядит некорректно")');
  step('карточка YouTube: инструкция по ключу, неверный ключ отвергается');

  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(200)));
  assert.ok(log.includes('agent.create') && log.includes('agent.delete'));
  await page.waitForSelector('#modules-card');
  await page.locator('#modules-card label:has-text("Свои ИИ-агенты") input').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.nav-item')].some((n) => n.textContent.includes('Агенты')));
  step('модуль «Агенты» отключается — вкладка исчезает');

  assert.deepEqual(errors, [], 'ошибки: ' + errors.join('; '));
  console.log('AGENTS SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('AGENTS SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'a-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
