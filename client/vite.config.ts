import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// In development the Vite dev server proxies API + Socket.IO traffic to the game server,
// so the browser sees a single origin (no CORS configuration required).
const serverTarget = process.env.DEV_SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared/src') } },
  build: { outDir: path.resolve(import.meta.dirname, '../dist/client'), emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: serverTarget, ws: true },
      '/api': serverTarget,
      '/healthz': serverTarget,
    },
  },
});
