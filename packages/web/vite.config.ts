import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The page and the intake server share one origin. In development the API routes are proxied to the server
// (the real one, or the mock in dev/mock-server.ts) on INTAKE_SERVER (default http://127.0.0.1:47831).
const target = process.env.INTAKE_SERVER || 'http://127.0.0.1:47831';
const routes = ['/hello', '/state', '/settings', '/files', '/run', '/cancel', '/commit', '/events', '/results', '/results.csv', '/open'];

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: Object.fromEntries(routes.map((route) => [route, { target, changeOrigin: false }])),
  },
});
