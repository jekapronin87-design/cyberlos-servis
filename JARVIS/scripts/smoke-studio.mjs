// Видео-студия в настоящем Electron: выбор папки, исходники, монтаж «экран пополам» с субтитрами и обложкой, монтажный стол.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const electronPath = req('electron');
const FF = req('ffmpeg-static');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-studio-'));
const folder = join(mkdtempSync(join(tmpdir(), 'jarvis-vids-')), 'Видосы для системных'); // вне каталога данных программы
mkdirSync(folder, { recursive: true });
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });
const mk = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
mk(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(folder, 'Про септики.mp4')]);
mk(['-f', 'lavfi', '-i', 'smptebars=s=480x854:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=220:d=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', join(folder, 'Я на камеру.mp4')]);

// поддельный OpenAI: расшифровка со словами
let stt = 0;
const server = createServer((r, res) => {
  r.resume();
  r.on('end', () => {
    if (r.url?.endsWith('/audio/transcriptions')) {
      stt++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'Привет друзья смотрите', words: [{ word: 'Привет', start: 3.4, end: 3.9 }, { word: 'друзья', start: 4, end: 4.5 }, { word: 'смотрите', start: 4.7, end: 5.3 }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const args = ['.'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', JARVIS_E2E_PICK: JSON.stringify({ folder }) } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForSelector('.hud');
  await page.evaluate(async (b) => { await window.jarvis.voice.setKey('sk-test-voice-key-1234567890'); await window.jarvis.settings.update({ voiceBaseUrl: b }); }, base);

  await page.click('.nav-item:has-text("Студия")');
  await page.waitForSelector('[data-testid=studio]');
  await page.click('#studio-pick');
  await page.waitForSelector('[data-testid=studio-file]');
  assert.equal(await page.locator('[data-testid=studio-file]').count(), 2);
  await page.screenshot({ path: join(shots, 'st1-files.png') });
  step('студия: выбрана папка, видны два исходника с миниатюрами и длительностью');

  // Оформление канала: три стиля, предпросмотр с безопасной зоной, файлы в «Оформление канала»
  await page.click('[data-art=neon]');
  await page.click('#art-go');
  await page.waitForSelector('[data-testid=art-result] img', { timeout: 60000 });
  await page.waitForSelector('.art-g-safe');
  const artDir = join(folder, 'Оформление канала');
  assert.ok(existsSync(artDir) && readdirSync(artDir).some((f) => f.startsWith('Шапка neon')) && readdirSync(artDir).some((f) => f.startsWith('Аватар neon')), 'шапка и аватар сохранены');
  await page.locator('#art-card').scrollIntoViewIfNeeded();
  await page.locator('#art-card').screenshot({ path: join(shots, 'st0-art.png') });
  step('оформление канала: шапка и аватар (неон) сделаны, видна безопасная зона, файлы в «Оформление канала»');

  // YouTube: карточка настройки проверяет ввод и ведёт к входу (сам вход — в браузере, здесь не проверяется)
  await page.waitForSelector('#yt-upload-card');
  assert.equal(await page.locator('#yt-upload-card .yt-steps li').count(), 6, 'мастер настройки: шесть шагов с кнопками «Открыть страницу Google»');
  await page.fill('#yt-upload-card input[placeholder^="Client ID"]', 'не-тот-формат');
  await page.fill('#yt-upload-card input[type=password]', 'GOCSPX-testsecret1234567890');
  await page.click('#yt-upload-card button:has-text("Сохранить")');
  await page.waitForSelector('#yt-upload-card .banner-err:has-text("googleusercontent")');
  await page.fill('#yt-upload-card input[placeholder^="Client ID"]', 'abcdefghij1234567890-test.apps.googleusercontent.com');
  await page.click('#yt-upload-card button:has-text("Сохранить")');
  await page.waitForSelector('#yt-connect');
  step('YouTube: карточка проверяет Client ID, после сохранения предлагает «Подключить YouTube»');

  // «Экран пополам»: я — «Я на камеру», показываю — «Про септики»
  await page.locator('[data-testid=studio-file]', { hasText: 'Я на камеру' }).locator('button:has-text("Это я")').click();
  await page.click('[data-layout=reaction-split]');
  await page.locator('[data-testid=studio-file]', { hasText: 'Про септики' }).locator('button:has-text("Показываю")').click();
  await page.fill('input[placeholder^="Например"]', 'Реакция на видео про септики');
  await page.click('#studio-go');
  await page.waitForSelector('[data-testid=timeline]');
  await page.waitForSelector('.tl-step[data-status=done]');
  await page.screenshot({ path: join(shots, 'st2-working.png') });
  await page.waitForSelector('.studio-done', { timeout: 150000 });
  await page.waitForSelector('.tl-lane.kind-subs .tl-clip');
  assert.equal(await page.locator('.tl-step[data-status=error]').count(), 0);
  assert.ok(await page.locator('.tl-lane.kind-ref').count() && await page.locator('.tl-lane.kind-face').count(), 'на столе есть дорожки видео и вас');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, 'st3-done.png') });
  await page.locator('.studio-table').scrollIntoViewIfNeeded();
  await page.locator('.studio-table').screenshot({ path: join(shots, 'st4-timeline.png') });
  step('монтаж: монтажный стол с дорожками, раскадровкой, субтитрами; ролик готов');

  const res = join(folder, 'Готово');
  assert.ok(existsSync(res), 'папка «Готово» создана');
  const sub = readdirSync(res)[0];
  const files = readdirSync(join(res, sub));
  assert.ok(files.some((f) => f.endsWith('.mp4')) && files.includes('Обложка.png') && files.includes('Субтитры.txt'), 'результат: ' + files.join(','));
  assert.ok(stt >= 1, 'речь расшифрована через API');
  assert.equal(readdirSync(folder).filter((f) => f.endsWith('.mp4')).length, 2, 'исходники на месте');
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(300)));
  assert.ok(log.includes('video.montage') && log.includes('video.folder_set') && !log.includes('sk-test-voice-key'));
  step('«Готово»: ролик, обложка, субтитры; исходники не тронуты; ключ не в журнале');

  await page.click('.nav-item:has-text("Системно")');
  await page.click('[data-testid=hud-type]');
  await page.fill('.hud-input', 'Открой студию');
  await page.press('.hud-input', 'Enter');
  await page.waitForSelector('[data-testid=studio]');
  step('«Открой студию» голосом/текстом переходит в студию');
  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('STUDIO SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('STUDIO SMOKE FAILED:', e);
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'st-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.close();
}
