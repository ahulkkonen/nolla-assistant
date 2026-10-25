import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

const chromium: PlaywrightTestConfig['use'] = {
  browserName: 'chromium',
  // A fake microphone (a tone) and no permission prompt, for the voice tests.
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
};

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  globalSetup: './src/global-setup.ts',
  projects: [
    { name: 'chromium', use: chromium },
    // The screenshot loop only: `playwright test --project screens`. Every test starts its own
    // server, so the tests of the one file can run in parallel.
    { name: 'screens', testMatch: 'screens.spec.ts', fullyParallel: true, use: chromium },
  ],
});
