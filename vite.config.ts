import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/reprice': `http://127.0.0.1:${process.env.PORT ?? 3001}` },
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
});
