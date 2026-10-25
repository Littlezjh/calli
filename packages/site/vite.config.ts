import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5174 },
  // The product's VNC client (noVNC) uses top-level await.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: {
    target: ['chrome89', 'edge89', 'firefox89', 'safari15'],
    outDir: 'dist',
    rollupOptions: {
      input: {
        home: fileURLToPath(new URL('./index.html', import.meta.url)),
        demo: fileURLToPath(new URL('./demo/index.html', import.meta.url)),
      },
    },
  },
});
