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
  expect([...lan.wsOrigins]).toEqual([
    'http://laptop.local:3000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://::1:3000',
    'http://[::1]:3000',
  ]);
  expect([...loadConfig(env('https://pa.example.test')).wsOrigins]).toEqual([
    'https://pa.example.test',
  ]);
});

test('production fails closed without PSEUDO_URL, MODELS_DIR or with a short LiteLLM key', () => {
  const prod = { ...env('https://pa.example.test'), NODE_ENV: 'production', MODELS_DIR: '/m' };
  const key = 'k'.repeat(32);
  expect(() => loadConfig({ ...prod, LITELLM_MASTER_KEY: key })).toThrow('PSEUDO_URL');
  expect(() => loadConfig({ ...prod, PSEUDO_URL: 'http://p' })).toThrow('LITELLM_MASTER_KEY');
  const ok = { ...prod, PSEUDO_URL: 'http://p', LITELLM_MASTER_KEY: key };
  expect(loadConfig(ok)).toMatchObject({ pseudoUrl: 'http://p', modelsDir: '/m' });
  expect(() => loadConfig({ ...ok, MODELS_DIR: '' })).toThrow('MODELS_DIR');
});
