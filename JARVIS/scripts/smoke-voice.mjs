// Сквозная проверка голоса в настоящем Electron: поддельный микрофон (wav-файл) + поддельный STT/TTS-сервер.
//   xvfb-run -a node scripts/smoke-voice.mjs     (на Windows — просто node scripts/smoke-voice.mjs)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-voice-'));
const shots = process.env.SMOKE_SHOTS ?? join(dataDir, 'shots');
mkdirSync(shots, { recursive: true });

// --- поддельный «голос»: 1.6 с речеподобного сигнала + 2.4 с тишины, по кругу ---
function makeWav() {
  const rate = 16000, secs = 4, n = rate * secs;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = t < 1.6 ? 0.35 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + 0.15 * Math.sin(2 * Math.PI * 880 * t) : 0;
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const wavPath = join(dataDir, 'voice.wav');
writeFileSync(wavPath, makeWav());

// --- поддельный OpenAI-совместимый сервер ---
let transcripts = [];
const seen = { stt: 0, tts: 0, auth: new Set() };
const server = createServer((req, res) => {
  seen.auth.add(req.headers.authorization);
  req.resume();
  req.on('end', () => {
    if (req.url?.endsWith('/audio/transcriptions')) {
      seen.stt++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: transcripts.shift() ?? '' })); // фразы кончились — слышна тишина
    } else if (req.url?.endsWith('/audio/speech')) {
      seen.tts++;
      res.setHeader('content-type', 'audio/mpeg');
      res.end(makeWav());
    } else { res.statusCode = 404; res.end(); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const args = ['.', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`, '--autoplay-policy=no-user-gesture-required'];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu');
const app = await electron.launch({ executablePath: electronPath, args, cwd: root, env: { ...process.env, JARVIS_DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' } });
const errors = [];
const step = (m) => console.log('  ✓', m);
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.setViewportSize({ width: 1180, height: 780 });
  await page.waitForSelector('.hud');
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.welcome');

  await page.evaluate(async (base) => {
    await window.jarvis.voice.setKey('sk-test-voice-key-1234567890');
    await window.jarvis.settings.update({ voiceBaseUrl: base, ttsMode: 'off', voiceMode: 'push' });
  }, base);

  await page.reload();
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.btn-mic');

  // 1. Микрофон по умолчанию заблокирован на уровне приложения
  const denied = await page.evaluate(async () => {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'granted'; } catch (e) { return e.name; }
  });
  assert.equal(denied, 'NotAllowedError', 'микрофон должен быть запрещён, пока не включён в настройках');
  const noVideo = await page.evaluate(async () => {
    try { await navigator.mediaDevices.getUserMedia({ video: true }); return 'granted'; } catch (e) { return e.name; }
  });
  assert.notEqual(noVideo, 'granted', 'камера запрещена всегда');
  // распознавание без включённого микрофона отклоняется ядром
  const blocked = await page.evaluate(() => window.jarvis.voice.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm').then(() => 'ok', (e) => String(e.message)));
  assert.match(blocked, /Микрофон выключен/);
  assert.equal(seen.stt, 0);
  step('микрофон и камера заблокированы, пока не включено в настройках; звук не уходит');

  // 2. Режим «по кнопке»
  transcripts = ['Который час?'];
  await page.click('.btn-mic'); // confirm принимается автоматически
  await page.waitForSelector('.mic-live');
  await page.screenshot({ path: join(shots, 'v1-listening.png') });
  await page.waitForSelector('.tool-card:has-text("get_datetime")', { timeout: 25000 });
  assert.equal(await page.locator('.bubble-user').first().textContent(), 'Который час?');
  await page.waitForSelector('.mic-live', { state: 'detached', timeout: 15000 }); // одна фраза — и микрофон выключился сам
  step('push-режим: фраза распознана, отправлена в чат, микрофон выключился сам');

  // 3. Режим «Джарвис»: чужие фразы игнорируются
  await page.evaluate(() => window.jarvis.settings.update({ voiceMode: 'wake', ttsMode: 'api', voiceSessionSec: 10 }));
  await page.reload();
  await page.click('.nav-item:has-text("Чат")');
  await page.waitForSelector('.btn-mic');
  transcripts = ['Купи хлеба и молока', 'Джарвис, запомни: люблю зелёный чай', 'Привет всем'];
  const before = seen.stt;
  await page.click('.btn-mic');
  await page.waitForSelector('.tool-card:has-text("Сохранено в память")', { timeout: 40000 });
  const userBubbles = await page.locator('.bubble-user').allTextContents();
  assert.ok(!userBubbles.some((t) => t.includes('хлеба')), 'чужой разговор не должен попасть в чат: ' + userBubbles);
  assert.ok(userBubbles.some((t) => t.includes('люблю зелёный чай')));
  assert.ok(seen.stt - before >= 2);
  await page.screenshot({ path: join(shots, 'v2-wake.png') });
  step('wake-режим: без слова «Джарвис» игнор, с ним — команда выполняется');

  // 4. Облачная озвучка ответа на голосовую команду
  for (let i = 0; i < 20 && seen.tts === 0; i++) await page.waitForTimeout(500);
  assert.ok(seen.tts >= 1, 'ответ на голосовую команду должен озвучиваться через API');
  step('ответ на голосовую команду озвучен (запрос синтеза речи ушёл)');

  // 4б. Звук действительно воспроизводится окном (раньше его молча блокировал CSP: нет media-src blob:)
  const played = await page.evaluate(async () => {
    const r = await window.jarvis.voice.speak('проверка');
    const a = new Audio(URL.createObjectURL(new Blob([r.data], { type: r.mime })));
    return await new Promise((res) => { a.onerror = () => res('error'); a.onplaying = () => res('playing'); a.play().catch((e) => res('rejected:' + e.name)); setTimeout(() => res('timeout'), 4000); });
  });
  assert.equal(played, 'playing', 'озвучка не воспроизводится: ' + played);
  step('аудио ответа реально воспроизводится в окне (CSP разрешает blob:)');

  // 5. Голосовое «стоп»
  // Пока Джарвис говорит, он реагирует только на «стоп», а после ответа открывается окно «продолжайте без слова Джарвис» (12 с).
  // settle() ждёт, пока всё затихнет: речь закончилась, запуск завершён, окно закрылось.
  const settle = async () => {
    await page.waitForTimeout(800);
    await page.waitForSelector('.typing:has-text("Слушаю вас")', { state: 'detached', timeout: 30000 }).catch(() => {});
    await page.waitForSelector('button:has-text("Отправить"), .hud-btn.primary', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('audio[data-jv-tts]'), null, { timeout: 30000 });
  };
  await settle();

  // 4в. Главный экран подсказывает, почему он не отвечает: фраза без слова «Джарвис» в режиме ожидания
  await page.click('.nav-item:has-text("Системно")');
  await page.waitForFunction(() => (window.__voiceLog ?? []).some((l) => /Беседа закончилась/.test(l.text)), null, { timeout: 40000 }); // окно «без слова Джарвис» закрыто
  transcripts = ['Купи хлеба и молока'];
  await page.waitForFunction(() => (window.__voiceLog ?? []).some((l) => /нет слова/.test(l.text)), null, { timeout: 30000 });
  assert.equal(await page.locator('.hud-note, .hud-wakehint, .hud-captions').count(), 0, 'на главном экране нет всплывающих подписей');
  step('фраза без слова «Джарвис» не молчит (причина в журнале голоса), а главный экран остаётся чистым');

  // 4г. Второй запрос подряд после озвученного ответа обрабатывается (раньше «после первого ответа тишина»)
  transcripts = ['Джарвис, который час?'];
  await page.waitForSelector('.act-ok:has-text("Время")', { timeout: 40000 });
  step('второй голосовой запрос подряд выполнен');
  await settle();
  await page.click('.nav-item:has-text("Чат")');
  transcripts = ['Джарвис, забудь 1', 'Стоп'];
  await page.waitForSelector('[role=alertdialog]', { timeout: 40000 });
  // голосом подтвердить нельзя — окно остаётся, пока «стоп» не закроет его
  await page.waitForSelector('[role=alertdialog]', { state: 'detached', timeout: 40000 });
  await page.waitForSelector('button:has-text("Отправить")');
  const mem = await page.evaluate(() => window.jarvis.memory.list());
  assert.equal(mem.length, 1, 'опасное действие не выполнено');
  step('голосовое «стоп» закрывает окно подтверждения; голосом разрешить нельзя');

  // 5b. «Живой разговор»: карточка есть, включается; проверка доступа с чужим адресом API честно отказывает, ключ не утекает; кнопка микрофона не зависает
  await page.click('.nav-item:has-text("Настройки")');
  await page.waitForSelector('#realtime-card');
  await page.locator('#rt-enable').click();
  await page.waitForFunction(() => window.jarvis.settings.get().then((s) => s.voiceEngine === 'realtime'));
  await page.locator('#rt-test').click();
  await page.waitForSelector('#realtime-card .banner-err:has-text("только с OpenAI")');
  await page.waitForSelector('#realtime-card .pill.on');
  await page.click('.nav-item:has-text("Системно")');
  assert.match(await page.locator('[data-testid=hud-mic]').textContent(), /Живой разговор/);
  await page.click('[data-testid=hud-mic]');
  await page.waitForTimeout(1200);
  assert.ok((await page.locator('[data-testid=hud-mic].on').count()) === 0, 'при отказе живой разговор не должен «висеть» включённым');
  await page.locator('.hud').waitFor();
  await page.click('.nav-item:has-text("Настройки")');
  await page.click('#rt-disable');
  await page.waitForFunction(() => window.jarvis.settings.get().then((s) => s.voiceEngine === 'classic'));
  await page.click('.nav-item:has-text("Системно")');
  assert.match(await page.locator('[data-testid=hud-mic]').textContent(), /Микрофон/);

  step('живой разговор: карточка, переключатель, понятный отказ при чужом адресе API, микрофон не зависает');

  // 6. Выключение главного выключателя гасит микрофон
  await page.evaluate(() => window.jarvis.settings.update({ micEnabled: false }));
  await page.reload();
  const after = await page.evaluate(async () => {
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); return 'granted'; } catch (e) { return e.name; }
  });
  assert.equal(after, 'NotAllowedError');
  const log = JSON.stringify(await page.evaluate(() => window.jarvis.audit.list(500)));
  assert.ok(log.includes('voice.mic_enabled') && log.includes('voice.mic_disabled') && log.includes('voice.transcribe'));
  assert.ok(!log.includes('sk-test-voice-key'));
  step('выключатель отключает микрофон; журнал без ключей');

  assert.deepEqual(errors, [], 'ошибки рендерера: ' + errors.join('; '));
  console.log('VOICE SMOKE OK. Скриншоты:', shots);
} catch (e) {
  console.error('VOICE SMOKE FAILED:', e);
  try {
    const pg = await app.firstWindow();
    console.error('--- отладка: остаток transcripts =', JSON.stringify(transcripts), 'stt-запросов =', seen.stt);
    console.error('--- текст окна:', (await pg.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 1500));
  } catch {}
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'v-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.close();
}
