// Сквозная проверка ИИ-наставника в настоящем Electron: уроки, проверка практики по тестовой CRM, подсветка, кабинет, база знаний.
//   node --experimental-strip-types scripts/smoke-mentor.mjs
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startCrmFixture } from '../tests/crmFixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-mentor-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const kbFile = join(dataDir, 'скрипт-звонка.txt');
writeFileSync(kbFile, 'Здравствуйте! Меня зовут ... компания «Аквамастер». Удобно ли вам сейчас говорить?\n\nЗадайте один вопрос о потребности клиента и запишите ответ в карточку.');
const fx = await startCrmFixture();
// «сайт CRM» для подсветки
const site = createServer((_, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>CRM</title><nav><button>Начать рабочий день</button></nav><h1>Воронки</h1>'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteHost = `127.0.0.1:${site.address().port}`;
const chromium = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', JARVIS_E2E_PICK: JSON.stringify({ kbFile }), ...(existsSync(chromium) ? { JARVIS_BROWSER_PATH: chromium } : {}) } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.waitForSelector('.hud');
  await page.evaluate(async ({ crm, front, host }) => {
    await window.jarvis.crm.save({ baseUrl: crm, environment: 'test', email: 'jarvis@aquamaster.ru', maskPii: true, frontendUrl: front }, 'ro-pass-123');
    await window.jarvis.computer.addBrowserHost(host);
  }, { crm: fx.url, front: `http://${siteHost}`, host: siteHost });

  await page.click('.nav-item:has-text("Наставник")');
  await page.waitForSelector('h1:has-text("Наставник")');

  // 1. Урок: тесты с обратной связью
  await page.fill('input[placeholder^="anna@"]', 'anna@aquamaster.ru');
  await page.click('button:has-text("Как устроена CRM")');
  await page.waitForSelector('h2:has-text("Как устроена CRM")');
  const q1 = page.locator('.card:has(> strong:has-text("Что означает срок SLA стадии?"))');
  await q1.locator('label:has-text("Сколько стоит обработка заявки") input').check();
  await q1.locator('button:has-text("Ответить")').click();
  await page.waitForSelector('.banner:has-text("Пока нет")');
  await q1.locator('label:has-text("Сколько сделка может находиться на стадии без движения") input').check();
  await q1.locator('button:has-text("Ответить")').click();
  await page.waitForSelector('.banner:has-text("Верно")');
  await page.screenshot({ path: join(shots, 'm1-lesson.png') });
  step('тест: неверный ответ объясняется, верный засчитывается');

  // 2. Практика по тестовой CRM: сделки-тренировки нет → понятная подсказка
  await page.click('button:has-text("Ко всем урокам")');
  await page.click('button:has-text("Взять заявку в работу")');
  await page.waitForSelector('h2:has-text("Взять заявку")');
  await page.click('button:has-text("Проверить в тестовой CRM")');
  await page.waitForSelector('.banner:has-text("Не нашла сделку «Тренировка anna»")');
  step('практика проверяется по тестовой CRM и подсказывает, чего не хватает');

  // 3. Подсветка в CRM
  await page.click('button:has-text("Ко всем урокам")');
  await page.click('button:has-text("Рабочий день и задачи")');
  await page.waitForSelector('h2:has-text("Рабочий день и задачи")');
  if (existsSync(chromium)) {
    await page.click('button:has-text("Показать в CRM")');
    await page.waitForSelector('.banner:has-text("Подсвечено")', { timeout: 30000 });
    step('«Показать в CRM»: кнопка подсвечена в браузере ассистента');
  }
  await page.click('button:has-text("Готово")');
  await page.waitForSelector('.banner:has-text("Отмечено")');

  // 4. Кабинет руководителя
  await page.click('button[role=tab]:has-text("Кабинет руководителя")');
  await page.waitForSelector('td:has-text("Анна Соколова")');
  await page.waitForSelector('td:has-text("Борис Лебедев")');
  await page.waitForSelector('button:has-text("назначить курс")');
  await page.locator('tr:has-text("Анна Соколова") button:has-text("назначить курс")').first().click();
  await page.waitForSelector('tr:has-text("Анна Соколова"):has-text("Работа с заявками")');
  await page.screenshot({ path: join(shots, 'm2-cabinet.png'), fullPage: true });
  step('кабинет руководителя: сотрудники из CRM, рекомендации по ошибкам, назначение курса');

  // 5. База знаний: импорт → черновик → утверждение → наставник находит
  await page.click('button[role=tab]:has-text("База знаний")');
  await page.click('button:has-text("Импорт из файла")');
  await page.waitForSelector('h2:has-text("Новый документ")');
  await page.fill('input[placeholder^="Источник"]', 'Регламент звонков, ред. 2026-11');
  await page.click('button:has-text("Сохранить")');
  await page.waitForSelector('.banner-ok:has-text("черновик")');
  const found0 = await page.evaluate(() => window.jarvis.kb.list().then((l) => l.find((d) => d.title === 'скрипт-звонка')));
  assert.equal(found0.status, 'draft');
  await page.locator('li:has-text("скрипт-звонка") button:has-text("Утвердить")').click();
  await page.waitForSelector('li:has-text("скрипт-звонка"):has-text("утверждён")');
  step('база знаний: импорт → черновик → утверждение');

  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  for (const a of ['mentor.assign', 'kb.save', 'kb.approve']) assert.ok(log.includes(a), 'нет в журнале: ' + a);
  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('MENTOR SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('MENTOR SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'm-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fx.close();
  site.close();
}
