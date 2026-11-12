import { defineConfig } from '@playwright/test';

// Runs against a served build: `netlify dev` (port 8888, default) or a deployed site via BASE_URL.
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:8888', screenshot: 'only-on-failure' },
  reporter: 'list',
});
