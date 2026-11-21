import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Рендерер (React). Главный процесс и preload собираются отдельно (scripts/build-main.mjs).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
});
