import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',
  globalSetup: './src/global-setup.ts',
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // A fake microphone (a tone) and no permission prompt, for the voice tests.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
});
