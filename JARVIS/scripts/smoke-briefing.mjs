// Проверка утренней сводки: голос/текст «покажи утреннюю сводку» → космический показ с тревогами, ботом клуба и чатами; карточка настроек.
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
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-brief-'));
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
const KEY = 'sro_BriefKey1234567890abcdefghijklm';
const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
const mk = (id, pipe, stage, sem, who, updH) => ({ id, number: 1, title: 'Сделка ' + id, stageSemantic: sem, createdAt: iso(500), updatedAt: iso(updH), pipeline: { id: 'p' + pipe, name: pipe }, stage: { id: 's' + stage, name: stage, semantic: sem }, assignee: who ? { id: 'u1', fullName: 'Иван Петров' } : null });
// «Сегодня» и «вчера» по Бангкоку (полдень), чтобы цифры дня не зависели от времени запуска теста
const bkk = (daysAgo) => new Date(`${new Date(Date.now() + 7 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10)}T05:00:00Z`).toISOString();
const dealsEv = [
  { id: 'e1', number: 1, title: 'Новая 1', stageSemantic: 'NEW', createdAt: bkk(0), updatedAt: bkk(0), amountRub: 0, pipeline: { id: 'pp', name: 'Продажа' }, stage: { id: 's', name: 'Новый', semantic: 'NEW' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
  { id: 'e2', number: 2, title: 'Новая 2', stageSemantic: 'NEW', createdAt: bkk(0), updatedAt: bkk(0), amountRub: 0, pipeline: { id: 'pp', name: 'Продажа' }, stage: { id: 's', name: 'Новый', semantic: 'NEW' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
  { id: 'e3', number: 3, title: 'Выиграна', stageSemantic: 'WON', createdAt: bkk(5), updatedAt: bkk(0), amountRub: 150000, pipeline: { id: 'pp', name: 'Продажа' }, stage: { id: 's', name: 'Выиграно', semantic: 'WON' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
  { id: 'e4', number: 4, title: 'Вчера 1', stageSemantic: 'NEW', createdAt: bkk(1), updatedAt: bkk(1), amountRub: 0, pipeline: { id: 'pp', name: 'Продажа' }, stage: { id: 's', name: 'Новый', semantic: 'NEW' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
  { id: 'e5', number: 5, title: 'Позавчера', stageSemantic: 'NEW', createdAt: bkk(2), updatedAt: bkk(2), amountRub: 0, pipeline: { id: 'pp', name: 'Монтаж' }, stage: { id: 's', name: 'План', semantic: 'NEW' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
  { id: 'e6', number: 6, title: 'Выиграна давно', stageSemantic: 'WON', createdAt: bkk(6), updatedAt: bkk(3), amountRub: 80000, pipeline: { id: 'pp', name: 'Продажа' }, stage: { id: 's', name: 'Выиграно', semantic: 'WON' }, assignee: { id: 'u1', fullName: 'Иван Петров' } },
];
const deals = [mk('d1', 'Продажа', 'КП', 'ACTIVE', true, 24), mk('d2', 'Продажа', 'КП', 'ACTIVE', true, 24 * 12), mk('d3', 'Продажа', 'Новый', 'NEW', false, 1), mk('d4', 'Монтаж', 'План', 'SCHEDULED', true, 30)];
const live = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${KEY}` || req.method !== 'GET') { res.statusCode = 401; return res.end('{}'); }
  const p = new URL(req.url, 'http://x').pathname.replace('/api/readonly/', '');
  const list = (data) => res.end(JSON.stringify({ ok: true, count: data.length, nextCursor: null, data }));
  if (p === 'deals') return list([...deals, ...dealsEv]);
  if (p === 'city/summary') return res.end(JSON.stringify({ ok: true, data: { tasks: { open: 14, overdue: 3 }, production: { ordersByStatus: [], materialsBelowMinimum: [] } } }));
  if (p === 'production/orders') return list([{ id: 'o1', number: 57, productName: 'Сайберлос 15', status: 'IN_PROGRESS', plannedFor: iso(72), stages: [] }]);
  if (p === 'tasks') return list([{ id: 't1', completedAt: bkk(0) }]);
  if (p === 'employees') return list([]);
  if (p === 'calls') return list([{ startedAt: bkk(0), direction: 'IN' }, { startedAt: bkk(0), direction: 'OUT' }]);
  if (p === 'club/payments') return list([{ paidAt: bkk(0), amountRub: 4900, memberName: 'Анна К.' }]);
  if (p === 'club/funnel') return res.end(JSON.stringify({ ok: true, data: { total: 120, withAccessNow: 9, paying: 11, paidTotalRub: 33000, byStep: [{ step: 'watch', count: 70, avgDaysInStep: 6.4, stuckOver3Days: 52 }, { step: 'PAYMENT_PENDING', count: 30, avgDaysInStep: 3, stuckOver3Days: 12 }, { step: 'paid', count: 9, avgDaysInStep: 12, stuckOver3Days: 0 }], last7Days: { joined: 14, paid: 7 }, today: { joined: 3, paid: 1, paidRub: 4900 } } }));
  if (p === 'club/members') return list([{ step: 'START', createdAt: iso(24 * 9) }, { step: 'PAYMENT_PENDING', updatedAt: iso(24 * 5) }, { step: 'PAYMENT_PENDING', updatedAt: iso(2) }, { step: 'PAID', paidTotalRub: 9900, accessUntil: new Date(Date.now() + 30 * 86400000).toISOString() }]);
  if (p === 'messages') return list([{ id: 'm1', threadId: 'c1', channel: 'TELEGRAM', direction: 'IN', text: 'Когда приедет монтаж?', contact: { id: 'k1', fullName: 'Алексей' }, assignee: { fullName: 'Мария' }, answeredAt: null, createdAt: iso(6) }, { id: 'm2', threadId: 'c2', channel: 'MAX', direction: 'IN', text: 'Пришлите счёт', contact: { id: 'k2', fullName: 'Ольга' }, answeredAt: null, createdAt: iso(1) }]);
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => live.listen(0, '127.0.0.1', r));

try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector('.hud');
  await page.evaluate(([url, key]) => window.jarvis.aqua.save({ baseUrl: url, maskPii: true }, key), [`http://127.0.0.1:${live.address().port}`, KEY]);

  await hudType(page, 'Покажи утреннюю сводку');
  await page.waitForSelector('[data-testid=show]', { timeout: 20000 });
  await page.waitForSelector('[data-testid=show-slide][data-kind=title]');
  assert.match(await page.locator('[data-testid=show-slide]').textContent(), /Добр(ое утро|ый день|ый вечер|ой ночи)/);
  await page.screenshot({ path: join(shots, 'b1-title.png') });
  step('«Покажи утреннюю сводку» → показ открылся с приветствием');

  const seen = [];
  for (let k = 0; k < 14; k++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1300);
    const kind = await page.locator('[data-testid=show-slide]').getAttribute('data-kind');
    const text = await page.locator('[data-testid=show-slide]').textContent();
    seen.push({ kind, text });
    await page.screenshot({ path: join(shots, `b${k + 2}-${kind}.png`) });
    if (/Главное — коротко/.test(text)) break;
  }
  const all = seen.map((s) => s.text).join(' | ');
  assert.ok(seen.some((s) => s.kind === 'alerts' && /Требует внимания/.test(s.text)), 'слайд тревог');
  assert.match(all, /просрочен/i);
  assert.match(all, /без ответственного/);
  assert.match(all, /Telegram-бот: клуб/);
  assert.match(all, /Воронка бота/);
  assert.match(all, /Зашли за 7 дней/);
  assert.match(all, /Смотрят материалы/);
  assert.match(all, /Рабочие чаты: без ответа/);
  assert.match(all, /Алексей/);
  assert.match(all, /Max/);
  step('в показе: тревоги, цифры CRM, воронка Telegram-бота клуба, рабочие чаты Telegram и Max');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=show]', { state: 'detached' });

  // Вечерний отчёт: просьба БЕЗ глагола, как говорят люди
  await hudType(page, 'вечерний отчет');
  await page.waitForSelector('[data-testid=show]', { timeout: 20000 });
  await page.waitForFunction(() => /Вечерний отчёт/.test(document.querySelector('[data-testid=show-slide]')?.textContent ?? ''));
  const ev = [];
  await page.keyboard.press(' '); // пауза автопоказа, дальше листаем сами
  const total = await page.locator('.show-dots button').count();
  for (let k = 1; k < total; k++) {
    await page.click(`.show-dots button:nth-child(${k + 1})`);
    await page.waitForTimeout(2300);
    const kind = await page.locator('[data-testid=show-slide]').getAttribute('data-kind');
    const text = await page.locator('[data-testid=show-slide]').textContent();
    ev.push({ kind, text });
    await page.screenshot({ path: join(shots, `e${k + 1}-${kind}.png`) });
    if (/Итоги дня/.test(text)) break;
  }
  const evKinds = ev.map((x) => x.kind);
  for (const k of ['kpis', 'gauges', 'trend', 'funnel', 'alerts', 'text']) assert.ok(evKinds.includes(k), `в вечернем отчёте нет слайда «${k}»`);
  const evAll = ev.map((x) => x.text).join(' | ');
  assert.match(evAll, /Сегодня в CRM/);
  assert.match(evAll, /Темп дня/);
  assert.match(evAll, /Курс «Системно»/);
  assert.match(evAll, /Оплатили сегодня/);
  assert.match(evAll, /Анна К\./);
  step('«вечерний отчет» (без глагола) → показ: итоги CRM, спидометры, график за неделю, курс «Системно» с оплатами за сегодня');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=show]', { state: 'detached' });

  // Озвучка слайдов: голос включён → на каждом слайде читается его текст, и показ сам листает, когда реплика закончилась
  await page.evaluate(() => window.jarvis.settings.update({ ttsMode: 'system' }));
  await page.reload();
  await page.waitForSelector('.hud');
  await page.evaluate(() => {
    window.__said = [];
    window.speechSynthesis.speak = (u) => {
      window.__said.push(u.text);
      setTimeout(() => u.onend && u.onend(new Event('end')), 400);
    };
    window.speechSynthesis.getVoices = () => [];
  });
  await hudType(page, 'покажи вечерний отчет');
  await page.waitForSelector('[data-testid=show]', { timeout: 20000 });
  await page.waitForFunction(() => window.__said.length >= 4, null, { timeout: 25000 });
  const said = await page.evaluate(() => window.__said);
  assert.match(said.join(' '), /вечерний отч[её]т/i);
  assert.match(said.join(' '), /Сегодня в CRM/);
  const idx = await page.locator('[data-testid=show-count]').textContent();
  assert.ok(!/^1 \//.test(idx), `показ сам листает под озвучку (сейчас ${idx})`);
  step(`озвученный показ: прочитано реплик ${said.length}, слайды листаются сами под голос`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=show]', { state: 'detached' });
  await page.evaluate(() => window.jarvis.settings.update({ ttsMode: 'off' }));

  // Карточка настроек
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('#briefing-card');
  await page.locator('#briefing-card').scrollIntoViewIfNeeded();
  assert.equal(await page.inputValue('#briefing-time'), '10:00');
  await page.fill('#briefing-time', '09:30');
  await page.fill('#briefing-vip', 'банк, партнёр');
  await page.click('#briefing-save');
  await page.waitForSelector('#briefing-card .banner-ok:has-text("09:30")');
  await page.fill('#mail-email', 'не почта');
  await page.fill('#mail-pass', 'abcdefghijkl');
  await page.click('#briefing-card button:has-text("Добавить")');
  await page.waitForSelector('#briefing-card .banner-err');
  await page.screenshot({ path: join(shots, 'b-settings.png') });
  const st = await page.evaluate(() => window.jarvis.briefing.get());
  assert.equal(st.config.time, '09:30');
  assert.deepEqual(st.config.vip, ['банк', 'партнёр']);
  step('карточка «Утренняя сводка и тревоги»: время и важные отправители сохраняются, неверная почта отклоняется понятным текстом');

  assert.deepEqual(errors, [], 'ошибок в консоли окна быть не должно');
  console.log('BRIEFING SMOKE OK');
} catch (e) {
  console.error('BRIEFING SMOKE FAILED:', e);
  process.exitCode = 1;
} finally {
  live.close();
  await app.close();
}
