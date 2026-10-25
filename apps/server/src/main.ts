import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, users } from '@pa/db';
import { purgeExpiredSessions } from './auth/session.ts';
import { type Config, loadConfig } from './config.ts';
import { buildServer } from './http.ts';
import { writeModelsJson } from './pi/models.ts';
import { SessionRegistry } from './pi/registry.ts';

export async function start(config: Config = loadConfig()) {
  const { db, sqlite } = openDb(join(config.dataDir, 'app.db'));
  db.insert(users)
    .values({ id: config.userId, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
  purgeExpiredSessions(db);
  const registry = new SessionRegistry({
    dataDir: config.dataDir,
    userId: config.userId,
    model: config.model,
  });
  writeModelsJson(registry.agentDir, config.litellmUrl);
  const app = await buildServer({ registry, db, config });
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
