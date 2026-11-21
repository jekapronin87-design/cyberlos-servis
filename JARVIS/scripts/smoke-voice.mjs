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
      res.end(JSON.stringify({ text: transcripts.shift() ?? 'Купи хлеба' }));
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
  await page.evaluate(() => window.jarvis.settings.update({ voiceMode: 'wake', ttsMode: 'api' }));
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

  // 5. Голосовое «стоп»
  transcripts = ['Джарвис, забудь 1', 'Стоп'];
  await page.waitForSelector('[role=alertdialog]', { timeout: 40000 });
  // голосом подтвердить нельзя — окно остаётся, пока «стоп» не закроет его
  await page.waitForSelector('[role=alertdialog]', { state: 'detached', timeout: 40000 });
  await page.waitForSelector('button:has-text("Отправить")');
  const mem = await page.evaluate(() => window.jarvis.memory.list());
  assert.equal(mem.length, 1, 'опасное действие не выполнено');
  step('голосовое «стоп» закрывает окно подтверждения; голосом разрешить нельзя');

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
  try { await (await app.firstWindow()).screenshot({ path: join(shots, 'v-failure.png') }); } catch {}
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  server.close();
}
