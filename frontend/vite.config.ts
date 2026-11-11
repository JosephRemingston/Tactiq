import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In development the API runs on localhost:3000; on Netlify it is served from the same origin via redirects.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://localhost:3000';
  const key = env.VITE_CLERK_PUBLISHABLE_KEY ?? '';
  if (key && !key.startsWith('pk_')) {
    throw new Error('VITE_CLERK_PUBLISHABLE_KEY must be a publishable key (pk_...). Refusing to build: a secret key would be exposed in the bundle.');
  }
  return {
    plugins: [react()],
    server: { port: 5173, proxy: { '/v1': target, '/healthz': target, '/readyz': target } },
    test: { environment: 'jsdom', globals: false },
  };
});
