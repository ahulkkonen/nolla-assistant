import { McpClient, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { ServerMessage } from '@nolla/protocol';
import type { FastifyBaseLogger, FastifyInstance, preHandlerHookHandler } from 'fastify';
import { limiter } from './auth/routes.ts';
import type { McpServer } from './mcp.ts';

/** Text google_workspace_mcp 2.1.0 returns when no token is stored (`auth/google_auth.py`). */
const AUTH_URL = /Authorization URL: (\S+)/;
const MAX_PARAM = 2048;
const CACHE_MS = 10_000;
const LANDING = '/?integrations=google';
const FAILED = '/?integrations=failed';

type Check = { connected: true } | { connected: false; authUrl: string };

/** The consent URL, only when it is an https URL on accounts.google.com. */
function consentUrl(text: string): string | undefined {
  const raw = AUTH_URL.exec(text)?.[1];
  if (!raw || raw.length > MAX_PARAM || !URL.canParse(raw)) return undefined;
  const u = new URL(raw);
  return u.protocol === 'https:' && u.hostname === 'accounts.google.com' ? raw : undefined;
}

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
  // `timeout` of the server in mcp.yaml, as for Pi's calls; 90 s (the shipped value) when unset.
  const timeoutMs = (workspace?.timeout ?? 90) * 1000;
  let connected = false;
  let cached: { at: number; result: Promise<Check | undefined> } | undefined;

  const check = async (url: string): Promise<Check> => {
    const client = new McpClient({ name: 'pa-server', version: '1', requestTimeoutMs: timeoutMs });
    try {
      await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
      const r = await client.callTool('list_calendars', {});
      if (!r.isError) return { connected: true };
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const authUrl = consentUrl(text);
      if (!authUrl) throw new Error('list_calendars failed without a valid authorization URL');
      return { connected: false, authUrl };
    } finally {
      await client.close().catch(() => {});
    }
  };
  const state = (): ServerMessage => ({ type: 'integrations.state', google: { connected } });
  const set = (value: boolean) => {
    if (value === connected) return;
    connected = value;
    opts.sendAll(state());
  };
  /**
   * One probe in flight, its result reused for 10 s. A failure counts as not connected and is
   * logged. Resolves `undefined` on failure; never rejects.
   */
  const probe = (): Promise<Check | undefined> => {
    if (!workspace) return Promise.resolve(undefined);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
    const result = check(workspace.url).then(
      (r) => {
        set(r.connected);
        return r;
      },
      (err: unknown) => {
        opts
          .log()
          .warn({ error: err instanceof Error ? err.message : String(err) }, 'mcp workspace');
        set(false);
        return undefined;
      },
    );
    cached = { at: Date.now(), result };
    return result;
  };
  const refresh = async () => void (await probe());

  const routes = (app: FastifyInstance, auth: preHandlerHookHandler) => {
    const callbackLimit = limiter(app, 10);
    app.get('/api/integrations/status', { preHandler: auth }, async () => {
      await probe();
      return {
        google: { connected, ...(connected && opts.selfEmail ? { email: opts.selfEmail } : {}) },
      };
    });
    app.post('/api/integrations/google/connect', { preHandler: auth }, async (_req, reply) => {
      if (!workspace) return reply.code(503).send({ error: 'not_configured' });
      const r = await probe();
      if (!r) return reply.code(502).send({ error: 'upstream' });
      return r.connected ? { connected: true } : { authUrl: r.authUrl };
    });
    // Google redirects here. No session check: the sameSite=strict cookie is not sent on this
    // cross-site navigation. The MCP server checks the single-use `state` and holds the PKCE
    // verifier. `logLevel: warn` keeps the authorization code out of the request log.
    app.get('/api/oauth/google/callback', { logLevel: 'warn' }, async (req, reply) => {
      if (callbackLimit.blocked(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      callbackLimit.fail(req.ip);
      const url = req.raw.url ?? '';
      const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const params = new URLSearchParams(query);
      const code = params.get('code') ?? '';
      const st = params.get('state') ?? '';
      if (!base || !code || !st || code.length > MAX_PARAM || st.length > MAX_PARAM)
        return reply.redirect(FAILED);
      let ok = false;
      try {
        const res = await fetch(`${base}/oauth2callback?${query}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
        ok = res.ok;
        if (!ok) app.log.warn({ status: res.status }, 'google oauth callback failed');
        await res.body?.cancel();
      } catch (err) {
        app.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'google oauth');
      }
      cached = undefined;
      void probe();
      return reply.redirect(ok ? LANDING : FAILED);
    });
  };

  return { state, refresh, routes };
}
export type Integrations = ReturnType<typeof integrations>;
