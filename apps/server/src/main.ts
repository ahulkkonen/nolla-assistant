import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, users } from '@pa/db';
import {
  PSEUDO_COLLISION,
  PSEUDO_COLLISION_DROPPED,
  PSEUDO_DOWN,
  PseudoClient,
  type PseudoLog,
} from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { liveAgentId, loadAgents, watchAgents } from './agents.ts';
import { approvals as approvalStore } from './approval.ts';
import { purgeExpiredSessions } from './auth/session.ts';
import { startAutomations } from './automations.ts';
import {
  agentsState,
  type BridgeDeps,
  broadcast,
  chatRow,
  errorMsg,
  transcript,
  vaultState,
} from './bridge.ts';
import { branchPoint, claimStore } from './claims.ts';
import { collisionWaits } from './collisions.ts';
import { BUNDLED_AGENTS, BUNDLED_AUTOMATIONS, type Config, loadConfig } from './config.ts';
import { fxRates } from './fx.ts';
import { buildServer } from './http.ts';
import { integrations as integrationStore } from './integrations.ts';
import { loadMcp } from './mcp.ts';
import { memoryStore } from './memory.ts';
import { loadModes, modesDir } from './modes.ts';
import { modelCatalog, writeModelsJson } from './pi/models.ts';
import { SessionRegistry } from './pi/registry.ts';
import { pushService } from './push.ts';
import { indexIdle } from './search.ts';
import { searcher } from './search-tool.ts';
import { seedDir } from './seed.ts';
import { taskSmall, titleJobs } from './topics.ts';
import { purgeTrash, workStore } from './tree.ts';
import { usageRecorder } from './usage.ts';

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
    for (const a of agentMap.values())
      for (const n of a.tools.mcp ?? [])
        if (!mcp.has(n)) agentLog(a.id, `MCP server ${n} not in ${config.mcpConfig}`, 'warn');
    for (const a of agentMap.values())
      for (const m of a.modes.default)
        if (!modeMap.has(m)) agentLog(a.id, `mode ${m} not found`, 'warn');
  };
  // Editable copies under DATA_DIR start as the image's folders (phase-15 decision 4); unedited
  // files follow later images (phase-16 decision 21). `app` does not exist yet: console.
  const seedWarn = (msg: string, data?: object) => console.warn(msg, data ?? {});
  seedDir(config.agentsDir, BUNDLED_AGENTS, 'agent', seedWarn);
  seedDir(config.automationsDir, BUNDLED_AUTOMATIONS, 'automation', seedWarn);
  // Startup fails without `assistant`; a later bad edit keeps the previous profile versions.
  // `app` does not exist yet, so the first load logs to the console.
  let agentMap = loadAgents(config.agentsDir, (file, err, level) =>
    console[level]('agent profile', file, err instanceof Error ? err.message : err),
  );
  // Phase-23 decision 1: a bad mode file keeps its previous version, like a profile.
  let modeMap = loadModes(modesDir(config.agentsDir), (file, err) =>
    console.error('mode file', file, err instanceof Error ? err.message : err),
  );
  /** The watcher's reload; the agent editor calls it after each write. Mode files too. */
  const reloadAgents = () => {
    try {
      const next = loadAgents(config.agentsDir, agentLog, agentMap);
      const nextModes = loadModes(modesDir(config.agentsDir), agentLog, modeMap);
      // Unchanged profiles and modes keep their objects: nothing to tell the screens.
      const same = <T>(a: Map<string, T>, b: Map<string, T>) =>
        a.size === b.size && [...a].every(([id, p]) => b.get(id) === p);
      const unchanged = same(next, agentMap) && same(nextModes, modeMap);
      agentMap = next;
      modeMap = nextModes;
      if (unchanged) return;
      checkBash();
      sendAll(agentsState(agentMap, modeMap));
    } catch (err) {
      agentLog(config.agentsDir, err);
    }
  };
  const stopWatch = watchAgents(config.agentsDir, reloadAgents, (err) =>
    agentLog(config.agentsDir, err),
  );
  const agents = () => agentMap;
  const modes = () => modeMap;
  const mcp = loadMcp(config.mcpConfig);
  const integrations = integrationStore({
    workspace: mcp.get('workspace'),
    callbackBase: config.mcpWorkspaceUrl,
    selfEmail: config.selfEmail,
    sendAll,
    log: () => app.log,
  });
  const push = pushService({ db, userId: config.userId, config, log: () => app.log });
  const approvals = approvalStore((chatId, msg) => {
    broadcast(rooms, chatId, msg);
    if (msg.type === 'approval.request') void push.notify(chatId, 'approval');
  });
  const pseudoLog = (chatId: string, ...[level, msg, data]: Parameters<PseudoLog>) => {
    app.log[level]({ chatId, ...data }, msg);
    // A dropped input starts no turn and a failed leak scan aborts one before the model, so the
    // bridge sees neither; restore failures the bridge reports itself (once per turn).
    const hook = (data as { hook?: string } | undefined)?.hook;
    if (msg === PSEUDO_DOWN && (hook === 'input' || hook === 'context_with_system'))
      broadcast(rooms, chatId, errorMsg('pseudo_down', chatId));
    // The message waits (`chat.held` came from the wait): show the item on every screen.
    if (msg === PSEUDO_COLLISION) vaultToAll(chatId);
    if (msg === PSEUDO_COLLISION_DROPPED)
      collisions.gaveUp(chatId, (data as { pendingIds: number[] }).pendingIds);
  };
  const vaultToAll = (chatId?: string) =>
    pseudo &&
    vaultState(pseudo).then(sendAll, (err: unknown) =>
      app.log.warn({ chatId, error: String(err) }, 'vault state after collision failed'),
    );
  // Phase-12 decisions 7 and 8: holds, and the pending items a dropped hold closes.
  const collisions = collisionWaits({
    notify: (chatId, m) => broadcast(rooms, chatId, m),
    expire: (ids) => {
      if (!pseudo) return;
      Promise.allSettled(ids.map((id) => pseudo.vaultPending(id, 'expire'))).then(() =>
        vaultToAll(),
      );
    },
  });
  // Model calls into `usage` and the chat totals (phase-13 decision 13).
  const recordUsage = usageRecorder(
    db,
    config.userId,
    (msg, data) => app.log.warn(data ?? {}, msg),
    undefined,
    (id) => liveAgentId(agentMap, id),
  );
  // ECB rate (phase-13 "Egress"); `start` below runs once `app` exists.
  const fx = fxRates({
    dataDir: config.dataDir,
    source: config.ecbRates,
    onChange: (rate) => sendAll({ type: 'fx.state', rate }),
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
  });
  // `app` exists by the time any memory callback runs.
  const claimsDb = claimStore({
    db,
    userId: config.userId,
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
    pseudo,
    ask: taskSmall(config.litellmUrl, config.litellmMasterKey, recordUsage),
    // Defined below; runs only after startup.
    onProfileChange: () => memory.consolidate(),
  });
  const memory = memoryStore({
    db,
    dataDir: config.dataDir,
    userId: config.userId,
    pseudo,
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
    sendAll,
    claims: claimsDb,
  });
  // Pi entries per catalog model (phase-10 decision 8); `start` below runs once `app` exists.
  const catalog = modelCatalog({
    dataDir: config.dataDir,
    source: config.openrouterCatalog,
    onChange: (models) => {
      writeModelsJson(registry.agentDir, config.litellmUrl, models);
      registry.resetModels();
    },
    warn: (msg, data) => app.log.warn(data ?? {}, msg),
  });
  const work = workStore(db, config.dataDir);
  const registry = new SessionRegistry({
    dataDir: config.dataDir,
    userId: config.userId,
    work: {
      used: () => work.used(config.userId),
      written: (path, chatId, messageId) => work.written(config.userId, path, chatId, messageId),
    },
    agents,
    modes,
    getChat: (chatId) => chatRow(db, config.userId, chatId),
    catalog,
    approval: { ask: approvals.ask, timeoutMs: config.approvalTimeoutMs },
    skillsDir: config.skillsDir,
    broker: config.broker,
    mcp,
    mcpWarn: (chatId, missing) => app.log.warn({ chatId, missing }, 'mcp tools missing'),
    onSettled: ({ sessionId }) => titles.scheduleTitleJob(sessionId),
    onUsage: recordUsage,
    search: searcher({
      litellmUrl: config.litellmUrl,
      litellmKey: config.litellmMasterKey,
      onUsage: recordUsage,
      warn: (msg, data) => app.log.warn(data ?? {}, msg),
    }),
    ...(pseudo
      ? { pseudo: { client: pseudo, log: pseudoLog, awaitCollision: collisions.wait } }
      : {}),
    memory: {
      store: memory,
      claims: claimsDb,
      onChange: (chatId) => {
        broadcast(rooms, chatId, memory.state());
        sendAll(claimsDb.state());
      },
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
  const app = await buildServer({
    registry,
    db,
    config,
    rooms,
    agents,
    modes,
    approvals,
    sockets,
    memory,
    push,
    automations: () => automations,
    integrations,
    work,
    catalog,
    refusals: new Map(),
    collisions,
    fx,
    sendAll,
    reloadAgents,
    mcpNames: [...mcp.keys()],
    ...(logStream ? { logStream } : {}),
    ...(pseudo ? { pseudo } : {}),
  });
  await catalog.start();
  fx.start();
  const titles = titleJobs({
    db,
    registry,
    rooms,
    userId: config.userId,
    litellmUrl: config.litellmUrl,
    litellmMasterKey: config.litellmMasterKey,
    pseudo,
    log: app.log,
    onUsage: recordUsage,
  });
  automations = startAutomations({
    dir: config.automationsDir,
    db,
    userId: config.userId,
    registry,
    agents,
    unattended: approvals.unattended,
    prompt: async (chatId, text) => void (await (await registry.get(chatId)).prompt(text)),
    notify: (chatId) => push.notify(chatId, 'automation'),
    log: app.log,
  });
  checkBash();
  await claimsDb.importMemory(memory.read('memory'));
  const claimsTask = claimsDb.schedule(() =>
    claimsDb
      .sweep(
        async (chatId, through) => {
          const session = await registry.get(chatId);
          if (!session.isIdle) return undefined;
          const messages = transcript(session);
          const path = through ? session.sessionManager.getBranch(through) : [];
          return { messages, at: branchPoint(messages, path) };
        },
        (chatId, activated) =>
          broadcast(rooms, chatId, { type: 'claims.activated', chatId, claims: activated }),
      )
      .catch((err: unknown) =>
        app.log.warn(
          { error: err instanceof Error ? err.message : 'unknown' },
          'claims sweep failed',
        ),
      ),
  );
  if (!pseudo) app.log.warn('memory disabled: PSEUDO_URL unset');
  if (!push.enabled) app.log.info('push disabled: VAPID_PUBLIC/VAPID_PRIVATE/VAPID_SUBJECT unset');
  const selfSeed = new AbortController();
  // After `app` exists: a sidecar that is still booting rejects at once. A restart drops every held message: close their items, and release the chats to new sockets.
  if (pseudo)
    pseudo.vaultList().then(
      ({ pending }) => {
        const open = pending.filter((p) => p.reason === 'collision');
        collisions.orphan([...new Set(open.map((p) => p.session_id))]);
        for (const p of open) void pseudo.vaultPending(p.id, 'expire').catch(() => {});
      },
      (err: unknown) => app.log.warn({ error: String(err) }, 'collision cleanup at startup failed'),
    );
  if (pseudo && config.selfEmail)
    void allowlistSelf(pseudo, config.selfEmail, app.log, selfSeed.signal);
  if (mcp.has('workspace') && !config.selfEmail)
    app.log.warn(
      'SELF_EMAIL unset: your Google address reaches the model unmasked in tool schemas',
    );
  void integrations.refresh();
  await app.listen({ port: config.port, host: config.host });
  const timer = setInterval(() => void registry.evictIdle(), 5 * 60_000);
  timer.unref();
  const purge = setInterval(() => purgeExpiredSessions(db), 60 * 60_000);
  purge.unref();
  // Trash entries older than 30 days (phase-11 decision 5): at start, then daily.
  const purgeFiles = () =>
    void purgeTrash(db, work, config.userId).catch((err: unknown) =>
      app.log.warn({ error: err instanceof Error ? err.message : 'unknown' }, 'trash purge failed'),
    );
  purgeFiles();
  const trashTimer = setInterval(purgeFiles, 24 * 60 * 60_000);
  trashTimer.unref();
  const close = async () => {
    selfSeed.abort();
    stopWatch();
    automations?.close();
    catalog.close();
    fx.close();
    memory.close();
    claimsTask.stop();
    clearInterval(timer);
    clearInterval(purge);
    clearInterval(trashTimer);
    await titles.close();
    await registry.dispose();
    await app.close();
    await indexIdle();
    sqlite.close();
  };
  return { app, registry, db, approvals, close };
}

/**
 * The user's own address is in every workspace tool schema (decision 0005), which no masking
 * covers. Allowlisting it keeps results and schemas consistent. Retries while the sidecar starts.
 */
async function allowlistSelf(
  pseudo: PseudoClient,
  email: string,
  log: { warn: (o: object, m: string) => void },
  signal: AbortSignal,
) {
  for (let i = 0; i < 30 && !signal.aborted; i++) {
    try {
      const { ids } = await pseudo.vaultSeed([{ kind: 'EMAIL', canonical: email }]);
      if (ids[0] === undefined) return log.warn({}, 'self email allowlist: seed returned no id');
      await pseudo.vaultUpdate(ids[0], { allowlisted: true });
      return;
    } catch (err) {
      // A 4xx will not change on retry (bad address, API mismatch).
      const client = /status 4\d\d/.test(String(err));
      if (client || i === 29)
        return log.warn({ error: String(err) }, 'self email allowlist failed');
      await new Promise((r) => {
        const t = setTimeout(r, 10_000);
        t.unref();
        signal.addEventListener('abort', () => (clearTimeout(t), r(undefined)), { once: true });
      });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, close } = await start();
  // Who stops the server: a signal, or an empty event loop. writeSync: the logger may not flush
  // before an exit. A Docker OOM kill logs nothing (no signal reaches the process).
  const say = (what: string) =>
    writeSync(2, `${JSON.stringify({ level: 40, time: Date.now(), msg: what })}\n`);
  process.on('beforeExit', (code) => say(`beforeExit ${code}`));
  const shutdown = (signal: string) => {
    say(`signal ${signal}`);
    close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
}
