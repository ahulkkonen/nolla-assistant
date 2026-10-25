import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { attachBridge, type BridgeDeps, type Socket } from './bridge.ts';

export async function buildServer(
  deps: Omit<BridgeDeps, 'log' | 'rooms'> & { logLevel: string; allowedOrigin: string },
) {
  const { logLevel, allowedOrigin, ...bridge } = deps;
  const app = Fastify({ logger: { level: logLevel } });
  const rooms = new Map<string, Set<Socket>>();
  await app.register(websocket);
  app.get('/healthz', async () => ({ ok: true }));
  // Phase 2 adds static PWA files and auth (getUser) here.
  app.get(
    '/ws',
    {
      websocket: true,
      // Browsers always send Origin; non-browser clients may omit it.
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== allowedOrigin) await reply.code(403).send();
      },
    },
    (socket) => attachBridge(socket, { ...bridge, log: app.log, rooms }),
  );
  return app;
}
