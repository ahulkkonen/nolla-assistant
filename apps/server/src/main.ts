import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, users } from '@pa/db';
import { PSEUDO_DOWN, PseudoClient, type PseudoLog } from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { loadAgents, watchAgents } from './agents.ts';
import { approvals as approvalStore } from './approval.ts';
import { purgeExpiredSessions } from './auth/session.ts';
import { startAutomations } from './automations.ts';
import { agentsState, type BridgeDeps, broadcast, chatRow, errorMsg } from './bridge.ts';
import { type Config, loadConfig } from './config.ts';
import { buildServer } from './http.ts';
import { memoryStore } from './memory.ts';
import { writeModelsJson } from './pi/models.ts';
import { SessionRegistry } from './pi/registry.ts';
import { indexIdle } from './search.ts';
import { titleJobs } from './topics.ts';

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
  let automations: ReturnType<typeof startAutomations> | undefined;
  const sockets: BridgeDeps['sockets'] = new Set();
  const sendAll = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const s of sockets) {
      try {
        s.send(data);
      } catch {}
    }
  };
  const agentLog = (file: string, err: unknown, level: 'error' | 'warn' = 'error') =>
    app.log[level](
      { file, error: err instanceof Error ? err.message : String(err) },
      'agent profile',
    );
  const checkBash = () => {
    for (const a of agentMap.values())
      if (!config.broker && a.tools.allow.includes('bash'))
        agentLog(a.id, 'bash listed but BROKER_URL/BROKER_TOKEN unset: no bash tool', 'warn');
  };
  // Startup fails without `assistant`; a later bad edit keeps the previous profile versions.
  // `app` does not exist yet, so the first load logs to the console.
  let agentMap = loadAgents(config.agentsDir, (file, err, level) =>
    console[level]('agent profile', file, err instanceof Error ? err.message : err),
  );
  const stopWatch = watchAgents(
    config.agentsDir,
    () => {
      try {
        agentMap = loadAgents(config.agentsDir, agentLog, agentMap);
        checkBash();
        sendAll(agentsState(agentMap));
      } catch (err) {
        agentLog(config.agentsDir, err);
      }
    },
    (err) => agentLog(config.agentsDir, err),
  );
  const agents = () => agentMap;
  const approvals = approvalStore((chatId, msg) => broadcast(rooms, chatId, msg));
  const pseudoLog = (chatId: string, ...[level, msg, data]: Parameters<PseudoLog>) => {
    app.log[level]({ chatId, ...data }, msg);
    // A dropped input starts no turn, so the bridge never sees it; mid-turn failures the bridge
    // reports itself (once per turn).
    if (msg === PSEUDO_DOWN && (data as { hook?: string } | undefined)?.hook === 'input')
      broadcast(rooms, chatId, errorMsg('pseudo_down', chatId));
  };
  // `app` exists by the time any memory callback runs.
  const memory = memoryStore({
    db,
    dataDir: config.dataDir,
    userId: config.userId,
    pseudo,
    litellmUrl: config.litellmUrl,
    litellmMasterKey: config.litellmMasterKey,
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
    sendAll,
  });
  const registry = new SessionRegistry({
    dataDir: config.dataDir,
    userId: config.userId,
    agents,
    getAgentId: (chatId) => chatRow(db, config.userId, chatId)?.agentId,
    approval: { ask: approvals.ask, timeoutMs: config.approvalTimeoutMs },
    skillsDir: config.skillsDir,
    broker: config.broker,
    onSettled: ({ sessionId }) => titles.scheduleTitleJob(sessionId),
    ...(pseudo ? { pseudo: { client: pseudo, log: pseudoLog } } : {}),
    memory: {
      store: memory,
      onChange: (chatId) => broadcast(rooms, chatId, memory.state()),
      log: (chatId, level, msg, data) => app.log[level]({ chatId, ...data }, msg),
    },
    subagents: {
      litellm: { url: config.litellmUrl, key: config.litellmMasterKey },
      pseudoUrl: config.pseudoUrl,
      onState: (chatId, children) =>
        broadcast(rooms, chatId, { type: 'subagent.state', chatId, children }),
      log: (chatId, level, msg, data) => app.log[level]({ chatId, ...data }, msg),
    },
  });
  writeModelsJson(registry.agentDir, config.litellmUrl);
  const app = await buildServer({
    registry,
    db,
    config,
    rooms,
    agents,
    approvals,
    sockets,
    memory,
    automations: () => automations,
    ...(logStream ? { logStream } : {}),
    ...(pseudo ? { pseudo } : {}),
  });
  const titles = titleJobs({
    db,
    registry,
    rooms,
    userId: config.userId,
    litellmUrl: config.litellmUrl,
    litellmMasterKey: config.litellmMasterKey,
    pseudo,
    log: app.log,
  });
  automations = startAutomations({
    dir: config.automationsDir,
    db,
    userId: config.userId,
    registry,
    agents,
    unattended: approvals.unattended,
    prompt: async (chatId, text) => void (await (await registry.get(chatId)).prompt(text)),
    log: app.log,
  });
  checkBash();
  await app.listen({ port: config.port, host: config.host });
  const timer = setInterval(() => void registry.evictIdle(), 5 * 60_000);
  timer.unref();
  const purge = setInterval(() => purgeExpiredSessions(db), 60 * 60_000);
  purge.unref();
  const close = async () => {
    stopWatch();
    automations?.close();
    memory.close();
    clearInterval(timer);
    clearInterval(purge);
    await titles.close();
    await registry.dispose();
    await app.close();
    await indexIdle();
    sqlite.close();
  };
  return { app, registry, db, close };
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
