import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on Vite and forwards /api to the daemon.
// Override the target with RAH_DAEMON_URL when the daemon is not on localhost:8787.
const daemon = process.env.RAH_DAEMON_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: daemon, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // Keep the published UI available if a build fails or is interrupted.
    emptyOutDir: false,
    sourcemap: false,
  },
});
