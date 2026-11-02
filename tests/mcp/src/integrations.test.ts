// OAuth proxy and connect routes (decision 0005) against the fake workspace server.
import { api, boot, connect, login, runCleanups } from '@nolla/server/src/test-utils.ts';
import { afterEach, expect, test } from 'vitest';
import { AUTH_URL, startWorkspaceConfig } from '../fixtures/fake-workspace-server.ts';

afterEach(runCleanups);

async function bootIntegrations(connected: boolean, authUrl = AUTH_URL) {
  const { ws, yaml } = await startWorkspaceConfig({ connected }, ['list_calendars']);
  // Before boot: the startup probe caches its result for 10 s.
  ws.state.authUrl = authUrl;
  const b = await boot([], { MCP_CONFIG: yaml, SELF_EMAIL: ' User@Example.fi ' });
  const srv = await b.run();
  const { cookie } = await login(b.config.port);
  const callback = (q: string) =>
    api(b.config.port, `/api/oauth/google/callback?${q}`, { redirect: 'manual' });
  const post = (path: string) => api(b.config.port, path, { method: 'POST', headers: { cookie } });
  const status = async () =>
    (await api(b.config.port, '/api/integrations/status', { headers: { cookie } })).json();
  return { ...b, srv, ws, cookie, port: b.config.port, callback, post, status };
}

test('connect returns the consent URL parsed from the auth-required error', async () => {
  const { port, post, status } = await bootIntegrations(false);
  const anon = await api(port, '/api/integrations/google/connect', { method: 'POST' });
  expect(anon.status).toBe(401);
  expect(await (await post('/api/integrations/google/connect')).json()).toEqual({
    authUrl: AUTH_URL,
  });
  expect(await status()).toEqual({ google: { connected: false } });
});

test('connect refuses a consent URL that is not https://accounts.google.com', async () => {
  for (const bad of [
    'https://evil.example/o/oauth2/auth',
    'https://accounts.google.com.evil.example/',
  ]) {
    const { post } = await bootIntegrations(false, bad);
    expect((await post('/api/integrations/google/connect')).status).toBe(502);
    await runCleanups();
  }
});

test('a failed probe means not connected; connect gives 502', async () => {
  const { ws, post, status } = await bootIntegrations(true);
  await ws.close();
  await new Promise((r) => setTimeout(r, 10_100)); // past the probe cache
  expect(await status()).toEqual({ google: { connected: false } });
  expect((await post('/api/integrations/google/connect')).status).toBe(502);
}, 30_000);

test('callback forwards the query without a cookie, redirects, and the state turns connected', async () => {
  const { port, cookie, ws, callback, post, status } = await bootIntegrations(false);
  const c = await connect(port, undefined, cookie);
  expect(await c.next('integrations.state')).toEqual({
    type: 'integrations.state',
    google: { connected: false },
  });
  const res = await callback('state=abc123&code=4%2F0Ab&scope=x');
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/?integrations=google');
  expect(ws.state.callbacks).toEqual(['state=abc123&code=4%2F0Ab&scope=x']);
  expect(await c.next('integrations.state')).toEqual({
    type: 'integrations.state',
    google: { connected: true },
  });
  expect(await status()).toEqual({ google: { connected: true, email: 'user@example.fi' } });
  expect(await (await post('/api/integrations/google/connect')).json()).toEqual({
    connected: true,
  });
});

test('callback: upstream rejection, missing or oversized params go to /?integrations=failed', async () => {
  const { ws, callback } = await bootIntegrations(false);
  const bad = await callback('state=used&code=x');
  expect(bad.headers.get('location')).toBe('/?integrations=failed');
  expect(ws.state.callbacks).toEqual(['state=used&code=x']);
  for (const q of [
    'code=x',
    'state=x',
    'error=access_denied&state=x',
    `state=x&code=${'a'.repeat(2049)}`,
  ]) {
    const res = await callback(q);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?integrations=failed');
  }
  expect(ws.state.callbacks).toHaveLength(1);
});

test('callback is rate limited to 10 per minute per address', async () => {
  const { callback } = await bootIntegrations(false);
  for (let i = 0; i < 10; i++) expect((await callback('code=x')).status).toBe(302);
  expect((await callback('code=x')).status).toBe(429);
});
