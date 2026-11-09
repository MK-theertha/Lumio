import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packages = resolve(import.meta.dirname, '../../packages');
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@lumio/shared-types': resolve(packages, 'shared-types/src/index.ts'),
      '@lumio/validation': resolve(packages, 'validation/src/index.ts'),
      '@lumio/calc-engine': resolve(packages, 'calc-engine/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': proxyTarget, '/healthz': proxyTarget },
  },
});
