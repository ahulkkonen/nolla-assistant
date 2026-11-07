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
  // The GitHub runner streams replies slower than a laptop: 88 of 89 flows pass there, and the
  // one that fails changes from run to run on the 5 s default.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // Even at 15 s, one test of ~570 times out on some runs, and a different one each time. One
  // retry on CI; the report still lists the test as flaky.
  retries: process.env.CI ? 1 : 0,
  // The html report is what CI uploads on failure (`playwright-report/`).
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './src/global-setup.ts',
  projects: [
    // The flows. The screenshot file is its own project below: in one serial project it took the
    // GitHub runner past the 60-minute job cap, and a full chromium run rewrote every baseline.
    { name: 'chromium', testIgnore: 'screens.spec.ts', use: chromium },
    // The screenshot loop: `playwright test --project screens`. Every test starts its own
    // server, so the tests of the one file can run in parallel.
    { name: 'screens', testMatch: 'screens.spec.ts', fullyParallel: true, use: chromium },
    // Safari check (phase 22): the phone screens in light and dark plus four flows, shot into
    // `screenshots-webkit/`. `pnpm test:webkit`; not part of `pnpm test`.
    {
      name: 'webkit',
      testMatch: /(screens|flows)\.spec\.ts/,
      grep: [
        /screens\.spec\.ts 390 (light|dark) /,
        /flows\.spec\.ts (inline figure|queue: |approval card |model policy: )/,
      ],
      fullyParallel: true,
      use: { browserName: 'webkit' },
    },
  ],
});
