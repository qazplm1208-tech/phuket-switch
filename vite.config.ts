import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:15720' },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
});
