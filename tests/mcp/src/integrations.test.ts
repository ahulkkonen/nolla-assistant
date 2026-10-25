// OAuth proxy and connect routes (decision 0005) against the fake workspace server.
import { api, boot, connect, login, runCleanups } from '@pa/server/src/test-utils.ts';
import { afterEach, expect, test } from 'vitest';
import { AUTH_URL, startWorkspaceConfig } from '../fixtures/fake-workspace-server.ts';

afterEach(runCleanups);

async function bootIntegrations(connected: boolean) {
  const { ws, yaml } = await startWorkspaceConfig({ connected }, ['list_calendars']);
  const b = await boot([], { MCP_CONFIG: yaml, SELF_EMAIL: 'user@example.fi' });
  const srv = await b.run();
  const { cookie } = await login(b.config.port);
  return { ...b, srv, ws, cookie, port: b.config.port };
}

test('connect returns the consent URL parsed from the auth-required error', async () => {
  const { port, cookie } = await bootIntegrations(false);
  const post = (c?: string) =>
    api(port, '/api/integrations/google/connect', {
      method: 'POST',
      headers: c ? { cookie: c } : {},
    });
  expect((await post()).status).toBe(401);
  const res = await post(cookie);
  expect(await res.json()).toEqual({ authUrl: AUTH_URL });
  const status = await api(port, '/api/integrations/status', { headers: { cookie } });
  expect(await status.json()).toEqual({ google: { connected: false } });
});

test('callback forwards the query without a cookie, redirects, and the state turns connected', async () => {
  const { port, cookie, ws } = await bootIntegrations(false);
  const c = await connect(port, undefined, cookie);
  expect(await c.next('integrations.state')).toEqual({
    type: 'integrations.state',
    google: { connected: false },
  });
  const res = await api(port, '/api/oauth/google/callback?state=abc123&code=4%2F0Ab&scope=x', {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/?integrations=google');
  expect(ws.state.callbacks).toEqual(['state=abc123&code=4%2F0Ab&scope=x']);
  expect(await c.next('integrations.state')).toEqual({
    type: 'integrations.state',
    google: { connected: true },
  });
  const status = await api(port, '/api/integrations/status', { headers: { cookie } });
  expect(await status.json()).toEqual({ google: { connected: true, email: 'user@example.fi' } });
  const again = await api(port, '/api/integrations/google/connect', {
    method: 'POST',
    headers: { cookie },
  });
  expect(await again.json()).toEqual({ connected: true });
});

test('callback without state or code does not reach the MCP server', async () => {
  const { port, ws } = await bootIntegrations(false);
  for (const q of ['code=x', 'state=x', 'error=access_denied&state=x']) {
    const res = await api(port, `/api/oauth/google/callback?${q}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  }
  expect(ws.state.callbacks).toEqual([]);
});

test('disconnect is not implemented (no server API)', async () => {
  const { port, cookie } = await bootIntegrations(true);
  const res = await api(port, '/api/integrations/google/disconnect', {
    method: 'POST',
    headers: { cookie },
  });
  expect(res.status).toBe(501);
});
