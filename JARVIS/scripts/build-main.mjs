// Сборка главного процесса и preload в CommonJS (preload в sandbox-режиме обязан быть CJS).
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const common = {
  platform: 'node',
  format: 'cjs',
  bundle: true,
  sourcemap: true,
  target: 'node24',
  external: ['electron', 'playwright-core', 'ffmpeg-static'],
  logLevel: 'info',
};

const jobs = [
  { ...common, entryPoints: [resolve(root, 'src/main/main.ts')], outfile: resolve(root, 'dist/main/main.cjs') },
  { ...common, entryPoints: [resolve(root, 'src/preload/preload.ts')], outfile: resolve(root, 'dist/preload/preload.cjs') },
];

if (watch) {
  for (const job of jobs) await (await context(job)).watch();
} else {
  await Promise.all(jobs.map((j) => build(j)));
}
