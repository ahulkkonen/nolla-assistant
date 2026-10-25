import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { ClientMessageInput, ServerMessage } from '@pa/protocol';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';
import { afterEach, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

// Plan section 2 invariant 1 / section 14 gate 3: real values never reach the session JSONL, the
// LiteLLM request log, the server log or app.db. Only tool execution (work dir) sees them.

const KEY = 'sk-test-master';
const PASSWORD = 'correct horse';
const USER = 'aleksi';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// --- Real values and their surrogates ---------------------------------------------------------

type Span = { start: number; end: number; kind: string; canonical: string };
type Line = { id: string; text: string; spans: Span[] };
const corpusPath = new URL('../../pii/corpus.jsonl', import.meta.url);
const corpus = readFileSync(corpusPath, 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Line);
// 12 lines: 12 PERSON spans (inflected), 2 HETU, 2 IBAN, 2 PHONE, 1 ADDRESS, 1 EMAIL.
const IDS = 'c100 c101 c134 c138 c151 c156 c003 c005 c008 c014 c171 c268'.split(' ');
const lines = IDS.map((id) => {
  const l = corpus.find((x) => x.id === id);
  if (!l) throw new Error(`corpus line ${id} missing`);
  return l;
});

/** Same suffix as the real word, made-up stem. */
const WORDS: Record<string, string> = {
  Mikko: 'Kalle', Virtanen: 'Laaksonen', Virtasen: 'Laaksosen', Virtaselle: 'Laaksoselle',
  Juhani: 'Eero', Korhonen: 'Rantanen', Korhosen: 'Rantasen',
  Katja: 'Heidi', Lindqvist: 'Westerberg',
  Sanna: 'Minna', Hyvönen: 'Kallionen', Hyvöselle: 'Kallioselle', Hyvöseltä: 'Kallioselta',
  Pekka: 'Jussi', Lahti: 'Rinne', Lahdelle: 'Rinteelle', Lahden: 'Rinteen',
  Päivi: 'Aila', Järvinen: 'Saarinen', Järvisen: 'Saarisen', Järviseksi: 'Saariseksi',
  Rauhala: 'Salmela',
}; // biome-ignore format: table
const FIXED: Record<string, string> = {
  'Koivukuja 5': 'Pajutie 7',
  '02150 Espoo': '33600 Vantaa',
};
const rot = (s: string, a: string, n: number) =>
  s.replace(new RegExp(`[${a}]`, 'g'), (c) => a[(a.indexOf(c) + n) % a.length] as string);
/** Format-shaped fake: digits shift by 5, email letters rot13. */
const fakeCode = (s: string) =>
  s.includes('@') ? rot(s, 'abcdefghijklmnopqrstuvwxyz', 13) : rot(s, '0123456789', 5);

function surrogateOf(kind: string, form: string) {
  if (kind === 'PERSON')
    return form
      .split(' ')
      .map((w) => {
        const s = WORDS[w];
        if (!s) throw new Error(`no surrogate word for ${kind} form (len ${w.length})`);
        return s;
      })
      .join(' ');
  return FIXED[form] ?? fakeCode(form);
}

const dictionary: Record<string, string> = {};
const surrogatesOf = (l: Line) => {
  const out: string[] = [];
  for (const s of l.spans) {
    const form = l.text.slice(s.start, s.end);
    if (form !== s.canonical) dictionary[s.canonical] = surrogateOf(s.kind, s.canonical);
    dictionary[form] = surrogateOf(s.kind, form);
    out.push(dictionary[form] as string);
  }
  return out;
};
const lineSurrogates = lines.map(surrogatesOf);
const realValues = Object.keys(dictionary);
const kinds = lines.flatMap((l) => l.spans.map((s) => s.kind));
const count = (k: string) => kinds.filter((x) => x === k).length;

test('real-value set shape', () => {
  expect(count('PERSON')).toBeGreaterThanOrEqual(8);
  expect([count('HETU'), count('IBAN'), count('PHONE'), count('ADDRESS'), count('EMAIL')]).toEqual([
    2, 2, 2, 1, 1,
  ]);
  expect(new Set(Object.values(dictionary)).size).toBe(realValues.length);
  expect(realValues.some((v) => Object.values(dictionary).includes(v))).toBe(false);
});

// --- Leak search and report -------------------------------------------------------------------

const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

/** Per-source hit report: value index, offset, 60 chars of context with the value as `***`. */
function leaks(sources: Record<string, { text: string; needle?: (v: string) => string }>) {
  const hits: string[] = [];
  for (const [name, { text, needle = (v: string) => v }] of Object.entries(sources))
    realValues.forEach((v, i) => {
      const n = needle(v);
      for (let at = text.indexOf(n); at >= 0; at = text.indexOf(n, at + n.length)) {
        const ctx = text
          .slice(Math.max(0, at - 30), at + n.length + 30)
          .split(n)
          .join('***');
        hits.push(`${name}: value #${i} at ${at}: ${JSON.stringify(ctx)}`);
      }
    });
  return hits;
}
function expectNoLeaks(hits: string[]) {
  if (hits.length === 0) return;
  const list = realValues.map((v, i) => `  #${i} ${v}`).join('\n');
  throw new Error(
    `${hits.length} masked-only violation(s):\n${hits.join('\n')}\nreal values:\n${list}`,
  );
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

// --- Harness ----------------------------------------------------------------------------------

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

async function connect(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = res.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    const m: ServerMessage = JSON.parse(String(d));
    // The default agent asks before `write`; this test approves every request.
    if (m.type === 'approval.request')
      ws.send(JSON.stringify({ type: 'approval.respond', requestId: m.requestId, approve: true }));
    inbox.push(m);
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

// --- Test -------------------------------------------------------------------------------------

test('masked-only: 10-turn tool conversation, then restart and chat.open', async () => {
  // Turns 0..9 use these line groups (12 lines, last four concatenated in pairs).
  const groups = [[0], [1], [2], [3], [4], [5], [6], [7], [8, 9], [10, 11]];
  // Kind by turn: echo, write+text, read+text, repeating. Read turns read the previous turn's file.
  const turns = groups.flatMap((g, i) => {
    const sur = g.flatMap((l) => lineSurrogates[l] ?? []);
    if (i % 3 === 0) return [{ text: `Muistiinpano: ${sur.join(', ')}.` }];
    if (i % 3 === 1)
      return [
        {
          toolCalls: [{ name: 'write', args: { path: `note-${i}.txt`, content: sur.join('; ') } }],
        },
        { text: `Tallensin tiedoston note-${i}.txt.` },
      ];
    return [
      { toolCalls: [{ name: 'read', args: { path: `note-${i - 1}.txt` } }] },
      { text: `Luin tiedoston note-${i - 1}.txt.` },
    ];
  });

  const llm = await startFakeLlm(turns);
  const sc = await startFakeSidecar(dictionary);
  const dataDir = mkdtempSync(join(tmpdir(), 'pa-masked-'));
  cleanups.push(
    () => llm.close(),
    () => sc.close(),
    () => rmSync(dataDir, { recursive: true, force: true }),
  );
  const logs: string[] = [];
  const stringify = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a) => void logs.push(stringify(a).join(' ')));
  cleanups.push(() => void vi.restoreAllMocks());

  process.env.LITELLM_MASTER_KEY = KEY;
  const config = loadConfig({
    DATA_DIR: dataDir,
    LITELLM_URL: llm.url,
    LITELLM_MASTER_KEY: KEY,
    PORT: String(await freePort()),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'debug',
    AUTH_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'x'.repeat(32),
    AUTH_PASSWORD_HASH: await hashPassword(PASSWORD),
    PSEUDO_URL: sc.url,
    USER_ID: USER,
  });
  const logStream = { write: (l: string) => void logs.push(l) };
  const boot = async () => {
    const srv = await start(config, logStream);
    cleanups.push(srv.close);
    return srv;
  };

  let srv = await boot();
  let c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  for (const [i, g] of groups.entries()) {
    c.send({
      type: 'user.message',
      chatId: chat.id,
      text: g.map((l) => lines[l]?.text).join('\n\n'),
    });
    await c.idle();
    expect(
      c.inbox.filter((m) => m.type === 'error'),
      `turn ${i}`,
    ).toEqual([]);
  }
  expect(llm.requests).toHaveLength(16);
  const tools = c.inbox.flatMap((m) => (m.type === 'tool.end' ? [m.status] : []));
  expect(tools).toEqual(Array(6).fill('ok'));

  // Display restoration: the client sees real values with annotations.
  const restored = (ms: { text: string; annotations: unknown[] }[]) =>
    ms.some((m) => m.annotations.length > 0 && realValues.some((v) => m.text.includes(v)));
  const finals = c.inbox.flatMap((m) => (m.type === 'message.final' ? [m.message] : []));
  expect(restored(finals)).toBe(true);

  const workDir = join(dataDir, 'work', USER);
  const check = () => {
    const sessions = walk(join(dataDir, 'sessions', USER));
    expect(sessions.length).toBeGreaterThan(0);
    const db = ['app.db', 'app.db-wal'].flatMap((f) => {
      try {
        return [[f, readFileSync(join(dataDir, f)).toString('latin1')] as const];
      } catch {
        return [];
      }
    });
    expectNoLeaks(
      leaks({
        ...Object.fromEntries(
          sessions.map((p) => [
            `session ${p.slice(dataDir.length)}`,
            { text: readFileSync(p, 'utf8') },
          ]),
        ),
        'litellm requests': { text: JSON.stringify(llm.requests.map((r) => r.body)) },
        'server log': { text: logs.join('\n') },
        ...Object.fromEntries(db.map(([f, text]) => [f, { text, needle: latin1 }])),
      }),
    );
  };

  // Sensitivity: the model saw surrogates, and tools wrote real values to the work dir.
  const sent = JSON.stringify(llm.requests.map((r) => r.body));
  expect(sent).toContain('Laaksoselle');
  const notes = readdirSync(workDir).filter((f) => f.startsWith('note-'));
  expect(notes).toHaveLength(3);
  for (const f of notes) {
    const body = readFileSync(join(workDir, f), 'utf8');
    expect(
      realValues.some((v) => body.includes(v)),
      `${f} holds a real value`,
    ).toBe(true);
  }
  check();

  // History path: restart, chat.open, same assertions.
  c.ws.close();
  await srv.close();
  srv = await boot();
  c = await connect(config.port);
  c.send({ type: 'chat.open', chatId: chat.id });
  const state = await c.next('chat.state');
  expect(restored(state.messages)).toBe(true);
  check();
});
