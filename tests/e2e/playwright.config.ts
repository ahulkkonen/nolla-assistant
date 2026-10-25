import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  globalSetup: './src/global-setup.ts',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
