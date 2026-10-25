import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { ServerMessage } from '@pa/protocol';
import type { FastifyBaseLogger, FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { McpServer } from './mcp.ts';

/** Text google_workspace_mcp 2.1.0 returns when no token is stored (`auth/google_auth.py`). */
const AUTH_URL = /Authorization URL: (https:\/\/accounts\.google\.com\/\S+)/;
const TIMEOUT_MS = 30_000;
export const LANDING = '/?integrations=google';

type Check = { connected: true } | { connected: false; authUrl: string };

/**
 * Google account link through the `workspace` MCP server (decision 0005). The server has no
 * status API, so `list_calendars` is the probe: success means a token is stored, the
 * auth-required error carries the consent URL.
 */
export function integrations(opts: {
  workspace?: McpServer | undefined;
  /** Origin of the MCP container for `/oauth2callback`; default: origin of the workspace URL. */
  callbackBase?: string | undefined;
  selfEmail?: string | undefined;
  sendAll: (msg: ServerMessage) => void;
  log: () => FastifyBaseLogger;
}) {
  const { workspace } = opts;
  const base = opts.callbackBase ?? (workspace ? new URL(workspace.url).origin : undefined);
  let connected = false;

  const check = async (url: string): Promise<Check> => {
    const client = new McpClient({ name: 'pa-server', version: '1', requestTimeoutMs: TIMEOUT_MS });
    try {
      await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
      const r = await client.callTool('list_calendars', {});
      if (!r.isError) return { connected: true };
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const authUrl = AUTH_URL.exec(text)?.[1];
      if (!authUrl) throw new Error('list_calendars failed without an authorization URL');
      return { connected: false, authUrl };
    } finally {
      await client.close().catch(() => {});
    }
  };
  const set = (value: boolean) => {
    if (value === connected) return;
    connected = value;
    opts.sendAll(state());
  };
  const state = (): ServerMessage => ({ type: 'integrations.state', google: { connected } });
  /** Probes the server and broadcasts a change. Never throws. */
  const refresh = async () => {
    if (!workspace) return;
    try {
      set((await check(workspace.url)).connected);
    } catch (err) {
      opts.log().warn({ error: err instanceof Error ? err.message : String(err) }, 'mcp workspace');
    }
  };

  const routes = (app: FastifyInstance, auth: preHandlerHookHandler) => {
    app.get('/api/integrations/status', { preHandler: auth }, async () => {
      await refresh();
      return {
        google: { connected, ...(connected && opts.selfEmail ? { email: opts.selfEmail } : {}) },
      };
    });
    app.post('/api/integrations/google/connect', { preHandler: auth }, async (_req, reply) => {
      if (!workspace) return reply.code(503).send({ error: 'not_configured' });
      try {
        const r = await check(workspace.url);
        set(r.connected);
        return r.connected ? { connected: true } : { authUrl: r.authUrl };
      } catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'mcp workspace');
        return reply.code(502).send({ error: 'upstream' });
      }
    });
    // The server has no API to delete its token file: docs/deploy.md "Integrations".
    app.post('/api/integrations/google/disconnect', { preHandler: auth }, async (_req, reply) =>
      reply.code(501).send({ error: 'not_implemented' }),
    );
    // Google redirects here. No session check: the sameSite=strict cookie is not sent on this
    // cross-site navigation. The MCP server checks the single-use `state` and holds the PKCE
    // verifier. `logLevel: warn` keeps the authorization code out of the request log.
    app.get('/api/oauth/google/callback', { logLevel: 'warn' }, async (req, reply) => {
      const query = req.raw.url?.split('?')[1] ?? '';
      const params = new URLSearchParams(query);
      if (!base || !params.get('state') || !params.get('code')) return reply.redirect(LANDING);
      try {
        const res = await fetch(`${base}/oauth2callback?${query}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) app.log.warn({ status: res.status }, 'google oauth callback failed');
        await res.body?.cancel();
      } catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'google oauth');
      }
      void refresh();
      return reply.redirect(LANDING);
    });
  };

  return { state, refresh, routes };
}
export type Integrations = ReturnType<typeof integrations>;
