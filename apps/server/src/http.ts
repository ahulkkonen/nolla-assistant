import { basename } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { SANDBOX_CSP, type ServerMessage } from '@pa/protocol';
import Fastify from 'fastify';
import { adminRoutes } from './admin.ts';
import { authRoutes, requireUser, type SessionSockets } from './auth/routes.ts';
import type { BridgeDeps } from './bridge/connection.ts';
import { attachBridge } from './bridge.ts';
import type { Config } from './config.ts';
import { CSP_REPORT_PATH, cspReportRoutes } from './csp.ts';
import { exportRoutes } from './export.ts';
import { exportJobs } from './export-all.ts';
import { fileRoutes, MAX_FILE_BYTES, MAX_FILES } from './files.ts';
import type { Integrations } from './integrations.ts';
import { pushRoutes } from './push.ts';
import { sttRoutes } from './stt.ts';
import { treeRoutes, type WorkStore } from './tree.ts';

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
/** Methods that change nothing; every other method gets the Origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Phase-16 decision 6: `report-to` for current browsers, `report-uri` for the others.
  `report-uri ${CSP_REPORT_PATH}`,
  'report-to csp',
].join('; ');

/**
 * The artifact sandbox page (phase-19 decision 2). A `srcdoc` frame inherits HTML_CSP, which
 * blocks every inline script, so artifacts load this page with its own policy instead. It writes
 * the one document its opener or parent posts, and only from our own origin (`location.origin`
 * is the URL's origin even under `sandbox`); `sandbox` keeps it on an opaque origin even when it
 * is opened in a tab of its own. Opened directly (no opener, no parent), it does nothing.
 */
const SANDBOX_HEADER = `sandbox allow-scripts; ${SANDBOX_CSP}; frame-ancestors 'self'`;
const SANDBOX_PAGE = `<!doctype html><meta charset="utf-8"><title>Artefakti</title><script>
var host = opener || parent, done = false;
if (host !== window) {
  addEventListener('message', function (e) {
    if (done || e.source !== host || e.origin !== location.origin || typeof e.data !== 'string')
      return;
    done = true;
    document.open();
    document.write(e.data);
    document.close();
  });
  host.postMessage('sandbox-ready', location.origin);
}
</script>`;

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export async function buildServer({
  config,
  logStream,
  integrations,
  work,
  sendAll,
  reloadAgents,
  mcpNames,
  ...bridge
}: Pick<
  BridgeDeps,
  | 'registry'
  | 'db'
  | 'pseudo'
  | 'rooms'
  | 'agents'
  | 'modes'
  | 'approvals'
  | 'automations'
  | 'sockets'
  | 'memory'
  | 'push'
  | 'catalog'
  | 'refusals'
  | 'collisions'
  | 'fx'
> & {
  config: Config;
  integrations: Integrations;
  /** Work-dir sizes and file origins (phase-11). */
  work: WorkStore;
  /** To every open socket. */
  sendAll: (msg: ServerMessage) => void;
  /** Reloads the agent profiles and sends `agents.state` (phase-15 decision 4). */
  reloadAgents: () => void;
  /** The servers of `infra/mcp.yaml`. */
  mcpNames: string[];
  /** Test hook: receives the pino output instead of stdout. */
  logStream?: { write(line: string): void };
}) {
  const { db } = bridge;
  const { trustProxy: tp } = config;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // No query string: the Files routes carry file names there (AGENTS.md: no real values).
      serializers: { req: (r) => ({ method: r.method, url: r.url.split('?', 1)[0] ?? '' }) },
      ...(logStream ? { stream: logStream } : {}),
    },
    // Fastify 5.12 treats a numeric trustProxy as "trust nothing", so a hop count is a function.
    trustProxy: typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp,
  });
  const auth = requireUser(db, config.cookieSecure);
  // Browsers always send Origin on a WebSocket and a POST; non-browser clients may omit it.
  const foreign = (origin: string | undefined) =>
    origin !== undefined && !config.wsOrigins.has(origin);
  // A page on a sibling subdomain is same-site, so SameSite=Strict lets its POST through (phase 35).
  // The CSP report route has no session and changes nothing.
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || !foreign(req.headers.origin)) return;
    if (req.url.split('?', 1)[0] === CSP_REPORT_PATH) return;
    return reply.code(403).send({ error: 'forbidden_origin' });
  });
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 5, fieldSize: 128, parts: 15 },
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    // The PDF preview (`/api/files/tree/raw`) sets SAMEORIGIN for its own frame.
    if (!reply.hasHeader('x-frame-options')) reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), geolocation=()');
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    // HTML only; /api/files/:id sets its own sandbox CSP and never serves text/html.
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html') && !reply.hasHeader('content-security-policy'))
      reply
        .header('Content-Security-Policy', HTML_CSP)
        .header('Reporting-Endpoints', `csp="${CSP_REPORT_PATH}"`);
  });
  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true }));
  // Static and without data, so no login: the posted document never reaches the server.
  app.get('/api/sandbox', async (_req, reply) =>
    reply
      .header('Content-Security-Policy', SANDBOX_HEADER)
      .header('X-Frame-Options', 'SAMEORIGIN')
      .header('Cache-Control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(SANDBOX_PAGE),
  );
  await cspReportRoutes(app, (msg, data) => app.log.warn(data, msg));
  // Open sockets per session: a revoked session's sockets close (phase-15 decision 12).
  const socketSessions = new Map<{ close(code: number, reason: string): void }, string>();
  const sessionSockets: SessionSockets = {
    revoke: (ids) => {
      for (const [s, id] of socketSessions)
        if (ids.includes(id)) {
          socketSessions.delete(s);
          s.close(4401, 'revoked');
        }
    },
    rename: (from, to) => {
      for (const [s, id] of socketSessions) if (id === from) socketSessions.set(s, to);
    },
  };
  authRoutes(app, db, config, sessionSockets);
  adminRoutes(app, auth, {
    db,
    dataDir: config.dataDir,
    agentsDir: config.agentsDir,
    automationsDir: config.automationsDir,
    skillsDir: config.skillsDir,
    mcpNames,
    catalog: bridge.catalog,
    registry: bridge.registry,
    agents: bridge.agents,
    modes: bridge.modes,
    reloadAgents,
    automations: bridge.automations,
    sendAll,
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
  });
  const exports = exportJobs({
    ...bridge,
    dataDir: config.dataDir,
    work,
    sendAll,
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
  });
  exports.routes(app, auth);
  app.addHook('onClose', async () => exports.close());
  fileRoutes(app, db, config.dataDir, auth, (userId) => work.used(userId));
  treeRoutes(app, auth, {
    db,
    dataDir: config.dataDir,
    work,
    registry: bridge.registry,
    pseudo: bridge.pseudo,
  });
  exportRoutes(app, auth, bridge);
  integrations.routes(app, auth);
  sttRoutes(app, auth, config);
  pushRoutes(app, auth, bridge.push);
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (foreign(req.headers.origin)) return reply.code(403).send();
        return auth(req, reply);
      },
    },
    (socket, req) => {
      socketSessions.set(socket, req.sessionId);
      socket.on('close', () => socketSessions.delete(socket));
      const hello: ServerMessage = { type: 'auth.state', authenticated: true, userId: req.userId };
      socket.send(JSON.stringify(hello));
      socket.send(JSON.stringify(integrations.state()));
      // mcp-workspace starts after pa-server, so the startup probe can miss; a change is broadcast.
      void integrations.refresh();
      attachBridge(socket, {
        ...bridge,
        userId: req.userId,
        dataDir: config.dataDir,
        log: app.log,
      });
    },
  );
  if (config.webDist) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders: (res, path) => {
        if (NO_CACHE.has(basename(path))) res.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      if (
        req.method === 'GET' &&
        !under(path, '/api') &&
        !under(path, '/ws') &&
        req.headers.accept?.includes('text/html')
      )
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }
  return app;
}
