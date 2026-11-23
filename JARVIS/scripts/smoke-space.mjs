// Проверка «цифрового пространства»: голосовые/текстовые переходы без модели, карточки аналитики, город бизнеса.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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
const hudType = async (page, text) => {
  if (!(await page.locator('.hud-input').count())) await page.click('[data-testid=hud-type]');
  await page.fill('.hud-input', text);
  await page.press('.hud-input', 'Enter');
};

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

  await hudType(page, 'Открой аналитику');
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
  await hudType(page, 'Покажи наш город');
  await page.waitForSelector('.city-canvas');
  step('«Покажи наш город» открывает город сразу');

  const msgs = await page.evaluate(async () => (await window.jarvis.conversations.list()).length);
  assert.equal(msgs, 0, 'навигация не должна создавать диалоги и тратить запросы к модели');

  // Живые данные: ключ «Аквамастер» → «Город» и карточки строятся из CRM (фиктивный сервер), примера больше нет
  const KEY = 'sro_SpaceKey1234567890abcdefghijkl';
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const mk = (id, pipe, stage, sem, who, upd) => ({ id, number: 1, title: 'Сделка ' + id, stageSemantic: sem, lostReason: null, createdAt: iso(20), updatedAt: iso(upd), pipeline: { id: 'p' + pipe, name: pipe }, stage: { id: 's' + stage, name: stage, semantic: sem }, assignee: who ? { id: 'u1', fullName: 'Иван Петров' } : null });
  const deals = [mk('d1', 'Продажа', 'КП', 'ACTIVE', true, 1), mk('d2', 'Продажа', 'КП', 'ACTIVE', true, 12), mk('d3', 'Продажа', 'Новый', 'NEW', false, 0), mk('d4', 'Монтаж', 'План', 'SCHEDULED', true, 2), mk('d5', 'Продажа', 'Выиграно', 'WON', true, 4)];
  const live = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${KEY}` || req.method !== 'GET') { res.statusCode = 401; return res.end('{}'); }
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.replace('/api/readonly/', '');
    const list = (data) => res.end(JSON.stringify({ ok: true, count: data.length, nextCursor: null, data }));
    if (p === 'deals') return list(deals);
    if (p === 'city/summary') return res.end(JSON.stringify({ ok: true, data: { tasks: { open: 14, overdue: 3 }, production: { ordersByStatus: [{ status: 'IN_PROGRESS', count: 4 }], materialsBelowMinimum: [] } } }));
    if (p === 'production/orders') return list([{ id: 'o1', number: 57, productName: 'Сайберлос 15', status: 'IN_PROGRESS', plannedFor: iso(3), finishedAt: null, cancelledAt: null, stages: [{ name: 'Раскрой', status: 'DONE' }, { name: 'Сварка', status: 'IN_PROGRESS', assigneeName: 'Алексей' }] }]);
    if (p === 'tasks') return list([{ id: 't1', type: 'CALL', title: 'Перезвонить по КП', dueAt: iso(2), completedAt: null, assignedUserId: 'u1', assigneeName: 'Иван Петров' }]);
    if (p === 'employees') return list([]);
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  await page.evaluate(([url, key]) => window.jarvis.aqua.save({ baseUrl: url, maskPii: true }, key), [`http://127.0.0.1:${live.address().port}`, KEY]);
  await page.click('.space-close');
  await page.waitForSelector('.hud');
  await hudType(page, 'Открой аналитику');
  await page.waitForSelector('[data-testid=space-live]');
  assert.equal(await page.locator('.space-banner:has-text("ПРИМЕР ДАННЫХ")').count(), 0, 'пример не должен показываться при живых данных');
  assert.match(await page.locator('.sp-tile', { hasText: 'Без движения' }).textContent(), /1/);
  assert.match(await page.locator('.sp-tile', { hasText: 'Задач просрочено' }).textContent(), /3/);
  await page.waitForSelector('.sp-fn-title:has-text("Продажа")');
  await page.screenshot({ path: join(shots, 's3-live-analytics.png') });
  await page.click('.space-tabs button:has-text("Город")');
  await page.waitForSelector('.city-canvas');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, 's4-live-city.png') });
  step('с ключом «Аквамастер» карточки и город строятся из живых данных (простой, задачи, воронки), пример не показывается');

  // Нажатие: плитка и здание открывают таблицу из CRM
  await page.click('.space-tabs button:has-text("Карточки")');
  await page.click('.sp-tile:has-text("Без движения")');
  await page.waitForSelector('[data-testid=space-drawer] .sp-table tbody tr');
  assert.match(await page.locator('[data-testid=space-drawer]').textContent(), /Сделка d2/);
  await page.screenshot({ path: join(shots, 's5-drawer.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=space-drawer]', { state: 'detached' });
  await page.click('.space-tabs button:has-text("Город")');
  await page.waitForSelector('.city-canvas');
  await page.waitForTimeout(600);
  // клик по зданию города: ищем точку внутри любого здания перебором по сетке
  const box = await page.locator('.city-canvas').boundingBox();
  let opened = false;
  for (let yy = 0.2; yy < 0.9 && !opened; yy += 0.04) {
    for (let xx = 0.2; xx < 0.8 && !opened; xx += 0.04) {
      await page.mouse.click(box.x + box.width * xx, box.y + box.height * yy);
      opened = (await page.locator('[data-testid=space-drawer]').count()) > 0;
    }
  }
  assert.ok(opened, 'клик по зданию города должен открывать список');
  await page.waitForSelector('[data-testid=space-drawer] .sp-table tbody tr');
  step('нажатие на плитку и на здание города открывает таблицу из CRM (только чтение)');
  await page.keyboard.press('Escape');
  // Голос/текст: «покажи, что у нас в производстве» открывает раздел и запускает рассказ
  await page.click('.space-close');
  await page.waitForSelector('.hud');
  await hudType(page, 'Покажи, что у нас в производстве');
  await page.waitForSelector('[data-testid=space-drawer]');
  await page.waitForSelector('[data-testid=space-drawer] :text("Сайберлос 15")');
  assert.match(await page.locator('[data-testid=space-drawer]').textContent(), /Сварка \(Алексей\)/);
  await page.screenshot({ path: join(shots, 's6-production.png') });
  step('«Покажи, что у нас в производстве» → открылся раздел «Производство» с заказами и текущим этапом');
  await page.evaluate(() => window.jarvis.aqua.disconnect());
  live.close();


  assert.deepEqual(errors, [], 'ошибки: ' + errors.join('; '));
  console.log('SPACE SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('SPACE SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 's-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
