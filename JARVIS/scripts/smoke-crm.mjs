// Сквозная проверка подключения к CRM в настоящем Electron: фиктивный сервер CRM из tests/crmFixture.ts.
//   node --experimental-strip-types scripts/smoke-crm.mjs   (Node 22.6+)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startCrmFixture } from '../tests/crmFixture.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-crm-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const fx = await startCrmFixture();
const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1300, height: 950 });
  await page.waitForSelector('.hud');

  // 1. Без подключения экран CRM объясняет, что делать
  await page.click('.nav-item:has-text("CRM")');
  await page.waitForSelector('.banner-err:has-text("не подключена")');
  step('без подключения экран CRM подсказывает, что делать');

  // 2. Настройка в интерфейсе
  await page.click('.nav-item:has-text("Настройки")');
  const card = page.locator('#crm-card');
  await card.locator('input[placeholder^="https://app"]').fill(fx.url.replace('http://', 'http://')); // localhost-адрес разрешён
  await card.locator('input[placeholder^="jarvis@"]').fill('jarvis@aquamaster.ru');
  await card.locator('input[type=password]').fill('ro-pass-123');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  await card.locator('button:has-text("Проверить подключение")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Подключено")');
  assert.match(await card.textContent(), /только чтение/);
  await page.screenshot({ path: join(shots, 'r1-settings.png') });
  step('подключение проверено: учётная запись признана безопасной для чтения');

  // 3. Опасная учётная запись — предупреждение
  await card.locator('input[placeholder^="jarvis@"]').fill('power@aquamaster.ru');
  await card.locator('input[type=password]').fill('p');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  await card.locator('button:has-text("Проверить подключение")').click();
  await page.waitForSelector('#crm-card :text("права на изменение данных")');
  await card.locator('input[placeholder^="jarvis@"]').fill('jarvis@aquamaster.ru');
  await card.locator('input[type=password]').fill('ro-pass-123');
  await card.locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('#crm-card .banner-ok:has-text("Сохранено")');
  step('учётная запись с правами на изменение — предупреждение');

  // 4. Экран CRM: плитки, менеджеры, замечания
  await page.click('.nav-item:has-text("CRM")');
  await page.waitForSelector('.tile:has-text("Просрочено по SLA")', { timeout: 20000 });
  await page.waitForSelector('td:has-text("Анна Соколова")');
  await page.waitForSelector('.list-item:has-text("Не заполнены обязательные поля")');
  await page.waitForSelector('text=Кому нужно обучение');
  await page.screenshot({ path: join(shots, 'r2-crm.png'), fullPage: true });
  step('экран CRM: плитки, менеджеры, замечания, рекомендации по обучению');

  // 5. Ассистент (демо-режим) видит инструмент, а CRM остаётся только для чтения
  const logins = fx.requests.filter((r) => r.method === 'POST');
  const writes = fx.requests.filter((r) => r.method !== 'GET' && !(r.method === 'POST' && r.path === '/auth/login'));
  assert.equal(writes.length, 0, 'в CRM не должно уходить ничего, кроме входа и чтения');
  assert.ok(logins.length >= 1);
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  assert.ok(log.includes('crm.configured') && log.includes('crm.test'));
  assert.ok(!log.includes('ro-pass-123'));
  step('в CRM ушли только вход и чтение; пароль не попал в журнал');

  // 6. Живая CRM «Аквамастер»: вставляем API-ключ — подключается; неверный ключ объясняется; в журнал ключ не попадает
  const AQUA_KEY = 'sro_SmokeKey1234567890abcdefghijkl';
  const aquaReqs = [];
  const aquaSrv = createServer((req, res) => {
    aquaReqs.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${AQUA_KEY}`) { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/api/readonly/health') return res.end('{"ok":true}');
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => aquaSrv.listen(0, '127.0.0.1', r));
  const aquaUrl = `http://127.0.0.1:${aquaSrv.address().port}`;
  await page.click('.nav-item:has-text("Настройки")');
  const aqua = page.locator('#aqua-card');
  await aqua.locator('#aqua-url').fill(aquaUrl);
  await aqua.locator('#aqua-key').fill('Qwerty12345');
  await aqua.locator('#aqua-save').click();
  await page.waitForSelector('#aqua-card .banner-err:has-text("sro_")');
  await aqua.locator('#aqua-key').fill(AQUA_KEY);
  await aqua.locator('#aqua-save').click();
  await page.waitForSelector('#aqua-card .banner-ok:has-text("Сохранено")');
  await aqua.locator('#aqua-test').click();
  await page.waitForSelector('#aqua-card .banner-ok:has-text("ключ принят")');
  await page.screenshot({ path: join(shots, 'r3-aqua.png') });
  assert.ok(aquaReqs.length >= 1 && aquaReqs.every((r) => r.method === 'GET' && r.url.startsWith('/api/readonly')), 'к «Аквамастер» уходят только GET под /api/readonly');
  const log2 = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  assert.ok(log2.includes('aqua.configured') && !log2.includes(AQUA_KEY));
  assert.equal((await page.evaluate(() => window.jarvis.aqua.get())).hasKey, true);
  await aqua.locator('button:has-text("Удалить ключ")').click();
  await page.waitForFunction(() => window.jarvis.aqua.get().then((s) => !s.hasKey));
  aquaSrv.close();
  step('CRM «Аквамастер»: ключ принят, только GET /api/readonly, ключ не в журнале, удаление работает');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('CRM SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('CRM SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'r-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fx.close();
}
