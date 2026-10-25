import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { startFakeBroker } from '@pa/pi-ext-sandbox/fake-broker';
import type { ClientMessageInput, ServerMessage } from '@pa/protocol';
import WebSocket from 'ws';
import { hashPassword } from './auth/password.ts';
import { loadConfig } from './config.ts';
import { start } from './main.ts';

/** Shared server test harness. Each test file runs `afterEach(runCleanups)`. */
// One model cache for all tests, outside the per-test DATA_DIR (downloaded once).
process.env.MODELS_DIR ||= join(tmpdir(), 'pa-models');
export const KEY = 'sk-test-master';
export const PASSWORD = 'correct horse';
const PASSWORD_HASH = await hashPassword(PASSWORD);
export const cleanups: (() => Promise<void> | void)[] = [];
export async function runCleanups() {
  for (const c of cleanups.splice(0).reverse()) await c();
}

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

export async function boot(turns: FakeTurn[], env: Record<string, string> = {}) {
  const llm = await startFakeLlm(turns);
  const dataDir = mkdtempSync(join(tmpdir(), 'pa-server-'));
  process.env.LITELLM_MASTER_KEY = KEY;
  const config = loadConfig({
    DATA_DIR: dataDir,
    LITELLM_URL: llm.url,
    LITELLM_MASTER_KEY: KEY,
    PORT: String(await freePort()),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    AUTH_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'x'.repeat(32),
    AUTH_PASSWORD_HASH: PASSWORD_HASH,
    // No `mcp-workspace` host in tests; tests/mcp passes its own file.
    MCP_CONFIG: 'none',
    ...env,
  });
  cleanups.push(
    () => llm.close(),
    () => rmSync(dataDir, { recursive: true, force: true }),
  );
  /** Server log lines (pino JSON), also echoed to stdout. */
  const logs: string[] = [];
  const logStream = {
    write: (line: string) => {
      logs.push(line);
      process.stdout.write(line);
    },
  };
  const run = async () => {
    const srv = await start(config, logStream);
    cleanups.push(srv.close);
    return srv;
  };
  return { llm, config, run, logs };
}

export const api = (port: number, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

/** Logs in with the password and returns the `pa_session=...` cookie pair. */
export async function login(port: number, password = PASSWORD) {
  const res = await api(port, '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { res, cookie: res.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

export async function connect(port: number, origin?: string, cookie?: string) {
  cookie ??= (await login(port)).cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    ...(origin ? { origin } : {}),
    headers: { cookie },
  });
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)));
    for (const w of waiters.splice(0)) w();
  });
  cleanups.push(() => ws.close());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const next = async <T extends ServerMessage['type']>(type: T) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type || m.type === 'error');
      if (i >= 0) {
        const [m] = inbox.splice(i, 1);
        if (m?.type === 'error') throw new Error(`server error: ${m.code}`);
        return m as Extract<ServerMessage, { type: T }>;
      }
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const idle = async () => {
    while ((await next('agent.status')).state !== 'idle');
  };
  const send = (m: ClientMessageInput) => ws.send(JSON.stringify(m));
  return { ws, inbox, next, idle, send };
}

/** Boots and returns a socket on a new chat. */
export async function bootChat(turns: FakeTurn[], env: Record<string, string> = {}) {
  const b = await boot(turns, env);
  const srv = await b.run();
  const c = await connect(b.config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  return { ...b, srv, c, chat };
}

/** Boots with PSEUDO_URL pointing at a fake sidecar; returns a socket on a new chat. */
export async function bootPseudo(
  dictionary: Record<string, string>,
  turns: FakeTurn[],
  opts: Parameters<typeof startFakeSidecar>[1] = {},
  env: Record<string, string> = {},
) {
  const sc = await startFakeSidecar(dictionary, opts);
  cleanups.push(sc.close);
  return { ...(await bootChat(turns, { ...env, PSEUDO_URL: sc.url })), sc };
}

const TOKEN = 'broker-test-token';

/** Boots with the fake broker rooted at the work dir; returns a socket on a new research chat. */
export async function bootResearch(turns: FakeTurn[], env: Record<string, string> = {}) {
  const broker = await startFakeBroker({ token: TOKEN, root: '' });
  cleanups.push(broker.close);
  const b = await boot(turns, { BROKER_URL: broker.url, BROKER_TOKEN: TOKEN, ...env });
  const srv = await b.run();
  broker.state.root = srv.registry.cwd;
  const c = await connect(b.config.port);
  c.send({ type: 'chat.create', agentId: 'research' });
  const { chat } = await c.next('chat.created');
  return { ...b, srv, c, chat, broker };
}
