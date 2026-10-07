import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only: the dev client must not be reachable from the LAN.
    host: '127.0.0.1',
    port: 3000,
    proxy: {
      // Proxying keeps the browser on a single origin, so Phase 2 needs no CORS
      // configuration and the client can call `/health` directly.
      '/health': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
