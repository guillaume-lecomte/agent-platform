import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the API is on :3000; the dashboard calls it through /api, as nginx does in Docker.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});
