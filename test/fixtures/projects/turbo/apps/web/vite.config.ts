import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:3020' }, port: Number(process.env.WEB_PORT ?? 3002) },
});
