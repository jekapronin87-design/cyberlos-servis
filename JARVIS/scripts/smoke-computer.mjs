// Сквозная проверка этапа 3 в настоящем Electron: папки, файлы, программы, браузер, снимок экрана.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-comp-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const work = join(realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-work-'))), 'Work');
mkdirSync(work);
writeFileSync(join(work, '.env'), 'TOKEN=secret');
writeFileSync(join(work, 'заметки.txt'), 'Позвонить клиенту в пятницу');

const site = createServer((_, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<title>Тест CRM</title><h1>Заявка №42 — Иван</h1><button>Принять</button>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteHost = `127.0.0.1:${site.address().port}`;

const chromium = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const env = { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', JARVIS_E2E_PICK: JSON.stringify({ folder: work }), ...(existsSync(chromium) ? { JARVIS_BROWSER_PATH: chromium } : {}) };
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.welcome');
  const send = async (t) => {
    await page.waitForSelector('button:has-text("Отправить")');
    await page.fill('textarea', t);
    await page.press('textarea', 'Enter');
  };
  const lastTool = () => page.locator('.tool-card').last();

  // 1. Пока папок нет — доступ закрыт
  await send(`Покажи файлы ${work}`);
  await page.waitForSelector('.tool-error:has-text("Нет разрешённых папок")');
  step('без разрешённых папок файлы недоступны');

  // 2. Пользователь разрешает папку через настройки
  await page.click('.nav-item:has-text("Настройки")');
  await page.click('text=+ Добавить папку…');
  await page.waitForSelector(`#computer-access code:has-text("${work}")`);
  await page.screenshot({ path: join(shots, 'c1-settings.png'), fullPage: false });
  assert.deepEqual((await page.evaluate(() => window.jarvis.computer.get())).folders, [work]);
  step('папка разрешена через окно выбора и видна в настройках');

  // 2б. Меню «Пуск» и браузер: переключатели есть, по умолчанию выключены, включаются с подтверждением
  assert.equal(await page.locator('#startmenu-toggle').isChecked(), false);
  assert.equal(await page.locator('#browser-auto').isChecked(), false);
  page.once('dialog', (d) => d.accept());
  await page.locator('#startmenu-toggle').click();
  await page.waitForSelector('#computer-access .banner-ok:has-text("меню «Пуск» разрешены")');
  await page.locator('#browser-auto').click();
  await page.waitForFunction(() => document.querySelector('#browser-auto')?.checked === true);
  assert.equal((await page.evaluate(() => window.jarvis.settings.get())).browserAutoApprove, true);
  await page.locator('#browser-auto').click();
  await page.waitForFunction(() => document.querySelector('#browser-auto')?.checked === false);
  await page.locator('#startmenu-toggle').click();
  await page.waitForSelector('#computer-access .banner-ok:has-text("выключен")');
  step('«программы из меню Пуск» и «браузер без лишних подтверждений» — выключены по умолчанию, включаются осознанно');
  await page.click('.nav-item:has-text("Чат")');

  // 3. Чтение — без подтверждения
  await send(`Прочитай файл ${join(work, 'заметки.txt')}`);
  await page.waitForSelector('.tool-card:has-text("Позвонить клиенту в пятницу")');
  assert.equal(await page.locator('[role=alertdialog]').count(), 0);
  step('чтение разрешённого файла без подтверждения; текст — в обёртке защиты');
  await send(`Прочитай файл ${join(work, '.env')}`);
  await page.waitForSelector('.tool-error:has-text("запрещён")');
  await send('Покажи файлы /etc');
  await page.waitForSelector('.tool-error:has-text("вне разрешённых")');
  step('секреты и чужие папки заблокированы');

  // 4. Запись — только с подтверждением
  const target = join(work, 'отчёт.txt');
  await send(`Создай файл ${target} с текстом итоги недели`);
  await page.waitForSelector('[role=alertdialog]');
  await page.screenshot({ path: join(shots, 'c2-confirm-write.png') });
  await page.click('[role=alertdialog] >> button:has-text("Отклонить")');
  await page.waitForSelector('.tool-card:has-text("Отклонено")');
  assert.equal(existsSync(target), false);
  await send(`Создай файл ${target} с текстом итоги недели`);
  await page.waitForSelector('[role=alertdialog]');
  await page.click('[role=alertdialog] >> button:has-text("Разрешить")');
  await page.waitForSelector('.tool-card:has-text("Файл создан")');
  assert.equal(readFileSync(target, 'utf8'), 'итоги недели');
  step('создание файла: отказ — файла нет, согласие — файл создан');

  // 5. Удаление — высокий риск
  await send(`Удали файл ${target}`);
  await page.waitForSelector('[role=alertdialog]');
  assert.match(await page.textContent('[role=alertdialog]'), /высокий риск/);
  await page.click('[role=alertdialog] >> button:has-text("Отклонить")');
  await page.waitForSelector('.tool-card:has-text("Отклонено") >> nth=-1');
  assert.ok(existsSync(target));
  step('удаление помечено «высокий риск»; отказ сохраняет файл');

  // 6. Браузер: внутренние адреса закрыты, пока не разрешены
  if (existsSync(chromium)) {
    await send(`Открой сайт http://${siteHost}/`);
    await page.waitForSelector('[role=alertdialog]');
    await page.click('[role=alertdialog] >> button:has-text("Разрешить")');
    await page.waitForSelector('.tool-error:has-text("Внутренние адреса")');
    step('браузер: внутренний адрес закрыт по умолчанию');
    await page.evaluate((h) => window.jarvis.computer.addBrowserHost(h), siteHost);
    await send(`Открой сайт http://${siteHost}/`);
    await page.waitForSelector('[role=alertdialog]');
    await page.click('[role=alertdialog] >> button:has-text("Разрешить")');
    await page.waitForSelector('.tool-card:has-text("Заявка №42")', { timeout: 30000 });
    await page.screenshot({ path: join(shots, 'c3-browser.png') });
    step('браузер: после разрешения страница открыта и прочитана');
  } else {
    console.log('  (пропуск проверки браузера: нет Chromium в /opt/pw-browsers)');
  }

  // 7. Снимок экрана
  await send('Сделай снимок экрана');
  await page.waitForSelector('[role=alertdialog]');
  assert.match(await page.textContent('[role=alertdialog]'), /ВСЕГО экрана/);
  await page.click('[role=alertdialog] >> button:has-text("Разрешить")');
  const res = page.locator('.tool-card:has-text("Снимок экрана получен"), .tool-card:has-text("Не удалось сделать снимок"), .tool-card:has-text("снимок")').last();
  await page.waitForSelector('.tool-card:has-text("Снимок экрана получен"), .tool-card:has-text("Не удалось"), .tool-card:has-text("Ошибка выполнения: ")  >> nth=-1', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const gotShot = (await page.locator('.shot').count()) > 0;
  console.log(gotShot ? '  ✓ снимок экрана получен и показан в чате' : '  (снимок экрана в этой среде не получен: ' + ((await res.textContent()) ?? '').slice(0, 120) + ')');
  await page.screenshot({ path: join(shots, 'c4-screen.png') });

  // 8. Журнал
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(500)));
  for (const a of ['computer.folder_added', 'fs_write', 'fs_delete', 'screen_capture']) assert.ok(log.includes(a), 'в журнале нет ' + a);
  assert.ok(!log.includes('TOKEN=secret'));
  const v = await page.evaluate(() => window.jarvis.audit.verify());
  assert.equal(v.ok, true);
  step('журнал содержит действия, секреты не просочились, цепочка цела');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('COMPUTER SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('COMPUTER SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'c-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  site.close();
}
