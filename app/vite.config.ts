import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately; the proxy keeps the page and the API on one origin
// so the session cookie and the Origin check behave as in production.
const api = process.env.YUMAKBOT_API ?? 'http://127.0.0.1:4319';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api },
      '/socket.io': { target: api, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
