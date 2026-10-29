import { expect, test } from 'vitest';
import { loadConfig } from './config.ts';

const env = (origin: string, lan?: string) => ({
  DATA_DIR: '/tmp',
  LITELLM_URL: 'http://x',
  LITELLM_MASTER_KEY: 'k',
  AUTH_ORIGIN: origin,
  COOKIE_SECRET: 'x'.repeat(32),
  AUTH_INSECURE_LAN: lan,
});

test('phase-22 decision 8: http on a LAN host only with AUTH_INSECURE_LAN=1', () => {
  expect(loadConfig(env('http://localhost:3000')).cookieSecure).toBe(false);
  expect(loadConfig(env('https://pa.example.test')).cookieSecure).toBe(true);
  expect(() => loadConfig(env('http://laptop.local:3000'))).toThrow('AUTH_INSECURE_LAN=1');
  expect(() => loadConfig(env('http://192.168.1.20:3000', 'yes'))).toThrow('AUTH_INSECURE_LAN=1');
  const lan = loadConfig(env('http://laptop.local:3000', '1'));
  expect(lan).toMatchObject({ authOrigin: 'http://laptop.local:3000', cookieSecure: false });
});
