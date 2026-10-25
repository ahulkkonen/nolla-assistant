import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, users } from '@pa/db';
import { PSEUDO_DOWN, PseudoClient, type PseudoLog } from '@pa/pi-ext-pseudo';
import { purgeExpiredSessions } from './auth/session.ts';
import { type BridgeDeps, broadcast, errorMsg } from './bridge.ts';
import { type Config, loadConfig } from './config.ts';
import { buildServer } from './http.ts';
import { writeModelsJson } from './pi/models.ts';
import { SessionRegistry } from './pi/registry.ts';

export async function start(
  config: Config = loadConfig(),
  logStream?: { write(line: string): void },
) {
  const { db, sqlite } = openDb(join(config.dataDir, 'app.db'));
  db.insert(users)
    .values({ id: config.userId, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
  purgeExpiredSessions(db);
  const pseudo = config.pseudoUrl ? new PseudoClient(config.pseudoUrl, config.userId) : undefined;
  const rooms: BridgeDeps['rooms'] = new Map();
  const pseudoLog = (chatId: string, ...[level, msg, data]: Parameters<PseudoLog>) => {
    app.log[level]({ chatId, ...data }, msg);
    // A dropped input starts no turn, so the bridge never sees it; mid-turn failures the bridge
    // reports itself (once per turn).
    if (msg === PSEUDO_DOWN && (data as { hook?: string } | undefined)?.hook === 'input')
      broadcast(rooms, chatId, errorMsg('pseudo_down', chatId));
  };
  const registry = new SessionRegistry({
    dataDir: config.dataDir,
    userId: config.userId,
    model: config.model,
    ...(pseudo ? { pseudo: { client: pseudo, log: pseudoLog } } : {}),
  });
  writeModelsJson(registry.agentDir, config.litellmUrl);
  const app = await buildServer({
    registry,
    db,
    config,
    rooms,
    ...(logStream ? { logStream } : {}),
    ...(pseudo ? { pseudo } : {}),
  });
  await app.listen({ port: config.port, host: config.host });
  const timer = setInterval(() => void registry.evictIdle(), 5 * 60_000);
  timer.unref();
  const purge = setInterval(() => purgeExpiredSessions(db), 60 * 60_000);
  purge.unref();
  const close = async () => {
    clearInterval(timer);
    clearInterval(purge);
    await registry.dispose();
    await app.close();
    sqlite.close();
  };
  return { app, registry, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, close } = await start();
  const shutdown = () => {
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
