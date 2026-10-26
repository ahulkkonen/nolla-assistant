import { basename } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ServerMessage } from '@pa/protocol';
import Fastify from 'fastify';
import { authRoutes, requireUser } from './auth/routes.ts';
import { attachBridge, type BridgeDeps } from './bridge.ts';
import type { Config } from './config.ts';
import { exportRoutes } from './export.ts';
import { fileRoutes, MAX_FILE_BYTES, MAX_FILES } from './files.ts';
import type { Integrations } from './integrations.ts';
import { pushRoutes } from './push.ts';
import { sttRoutes } from './stt.ts';
import { treeRoutes, type WorkStore } from './tree.ts';

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
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
].join('; ');

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export async function buildServer({
  config,
  logStream,
  integrations,
  work,
  ...bridge
}: Pick<
  BridgeDeps,
  | 'registry'
  | 'db'
  | 'pseudo'
  | 'rooms'
  | 'agents'
  | 'approvals'
  | 'automations'
  | 'sockets'
  | 'memory'
  | 'push'
  | 'catalog'
  | 'refusals'
> & {
  config: Config;
  integrations: Integrations;
  /** Work-dir sizes and file origins (phase-11). */
  work: WorkStore;
  /** Test hook: receives the pino output instead of stdout. */
  logStream?: { write(line: string): void };
}) {
  const { db } = bridge;
  const { trustProxy: tp } = config;
  const app = Fastify({
    logger: { level: config.logLevel, ...(logStream ? { stream: logStream } : {}) },
    // Fastify 5.12 treats a numeric trustProxy as "trust nothing", so a hop count is a function.
    trustProxy: typeof tp === 'number' ? (_addr: string, hop: number) => hop < tp : tp,
  });
  const auth = requireUser(db, config.cookieSecure);
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
      reply.header('Content-Security-Policy', HTML_CSP);
  });
  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true }));
  authRoutes(app, db, config);
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
        // Browsers always send Origin; non-browser clients may omit it.
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== config.authOrigin) return reply.code(403).send();
        return auth(req, reply);
      },
    },
    (socket, req) => {
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
