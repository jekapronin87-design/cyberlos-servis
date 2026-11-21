// Режим разработки: vite dev server + пересборка main/preload + Electron.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

await new Promise((res, rej) => {
  const p = spawn(process.execPath, [resolve(root, 'scripts/build-main.mjs')], { stdio: 'inherit' });
  p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build-main failed'))));
});

const server = await createServer({ configFile: resolve(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5173/';

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
