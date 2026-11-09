import { defineConfig } from '@playwright/test';

/** Runs against a live stack: docker compose up, then seed with --profile seed. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    screenshot: 'only-on-failure',
  },
});
