import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Ensure service worker is in root of dist
        manualChunks: (id) => {
          if (id.includes('serviceWorker')) {
            return false; // Don't chunk service worker
          }
        },
      },
    },
  },
});
