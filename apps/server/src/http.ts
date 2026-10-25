import { basename } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ServerMessage } from '@pa/protocol';
import Fastify from 'fastify';
import { authRoutes, requireUser } from './auth/routes.ts';
import { attachBridge, type BridgeDeps, type Socket } from './bridge.ts';
import type { Config } from './config.ts';
import { fileRoutes, MAX_FILE_BYTES, MAX_FILES } from './files.ts';

const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);

export async function buildServer({
  config,
  ...bridge
}: Pick<BridgeDeps, 'registry' | 'db'> & { config: Config }) {
  const { db } = bridge;
  const app = Fastify({ logger: { level: config.logLevel } });
  const rooms = new Map<string, Set<Socket>>();
  const auth = requireUser(db, config.cookieSecure);
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(multipart, { limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES } });
  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true }));
  authRoutes(app, db, config);
  fileRoutes(app, db, config.dataDir, auth);
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
      attachBridge(socket, {
        ...bridge,
        userId: req.userId,
        dataDir: config.dataDir,
        log: app.log,
        rooms,
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
        !path.startsWith('/api') &&
        !path.startsWith('/ws') &&
        req.headers.accept?.includes('text/html')
      )
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }
  return app;
}
