import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { setup, toolMessageContent } from '@pa/contract-tests/src/harness.ts';
import type { FakeTurn } from '@pa/fake-llm';
import { afterEach, expect, test, vi } from 'vitest';
import { startFakeSidecar } from './fake-sidecar.ts';
import { type Collision, PseudoClient, pseudoExtension } from './index.ts';

const DICT = {
  'Matti Virtanen': 'Pekka Laaksonen',
  Virtaselle: 'Laaksoselle',
  '010190-123A': '010190-900B',
};
const REAL = Object.keys(DICT);
const noReal = (s: string) => {
  for (const r of REAL) expect(s).not.toContain(r);
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function boot(
  turns: FakeTurn[],
  extra: ExtensionFactory[] = [],
  tools?: string[],
  learn = false,
  collide: { names?: string[]; wait?: (c: Collision[]) => Promise<boolean> } = {},
) {
  const sc = await startFakeSidecar(
    { ...DICT },
    { learn, ...(collide.names ? { collide: collide.names } : {}) },
  );
  closers.push(sc.close);
  const logs: { level: string; msg: string; data?: any }[] = [];
  const ext = pseudoExtension({
    client: new PseudoClient(sc.url, 'u1'),
    sessionId: 'chat-1',
    log: (level, msg, data) => void logs.push({ level, msg, data }),
    ...(collide.wait ? { awaitCollision: collide.wait } : {}),
  });
  const pi = await setup(turns, [ext, ...extra], tools ? { tools } : {});
  const events: AgentSessionEvent[] = [];
  pi.session.subscribe((e) => void events.push(e));
  const sessionFile = () => readFileSync(pi.sessionManager.getSessionFile() ?? '', 'utf8');
  return { sc, logs, events, sessionFile, ...pi };
}

test('input is masked before the model and the session file', async () => {
  const { llm, sc, session, sessionFile } = await boot([{ text: 'ok' }]);
  await session.prompt('Lähetä viesti Matti Virtanen, hetu 010190-123A');
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Pekka Laaksonen');
  expect(body).toContain('010190-900B');
  noReal(body);
  const file = sessionFile();
  noReal(file);
  expect(file).toContain('"customType":"pseudo-spans"');
  expect(sc.requests.every((r) => r.body.user_id === 'u1')).toBe(true);
  expect(sc.requests.find((r) => r.path === '/mask')?.body.session_id).toBe('chat-1');
});

test('tool_call is unmasked for execution; the next request stays masked', async () => {
  const { llm, cwd, session } = await boot([
    { toolCalls: [{ name: 'write', args: { path: 'out.txt', content: 'Terve Laaksoselle' } }] },
    { text: 'done' },
  ]);
  await session.prompt('Kirjoita tervehdys Virtaselle');
  expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('Terve Virtaselle');
  expect(llm.requests).toHaveLength(2);
  noReal(JSON.stringify(llm.requests[1]?.body));
});

/** Boots with one custom tool `t` that returns `result`, runs one call, returns the end result. */
async function runTool(result: object) {
  const custom: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: 't',
      label: 't',
      description: 'test tool',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => result as never,
    });
  };
  const pi = await boot(
    [{ toolCalls: [{ name: 't', args: {} }] }, { text: 'done' }],
    [custom],
    ['read', 'write', 'edit', 't'],
  );
  await pi.session.prompt('Aja');
  const end = pi.events.find((e) => e.type === 'tool_execution_end');
  return { ...pi, result: end && 'result' in end ? end.result : undefined };
}

test('tool_result masks content, structuredContent and details', async () => {
  const { llm, result, sessionFile } = await runTool({
    content: [{ type: 'text', text: 'Henkilö: Matti Virtanen' }],
    structuredContent: { who: 'Matti Virtanen' },
    details: { note: 'Matti Virtanen' },
  });
  expect(result.content).toEqual([{ type: 'text', text: 'Henkilö: Pekka Laaksonen' }]);
  expect(result.details).toEqual({ note: 'Pekka Laaksonen' });
  noReal(sessionFile());
  expect(result.structuredContent).toEqual({ who: 'Pekka Laaksonen' });
  expect(toolMessageContent(llm.requests[1]?.body)).toBe('Henkilö: Pekka Laaksonen');
});

test('tool_result passes image blocks through untouched (accepted gap)', async () => {
  const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
  const { result } = await runTool({
    content: [image, { type: 'text', text: 'Matti Virtanen' }],
    details: {},
  });
  expect(result.content).toEqual([image, { type: 'text', text: 'Pekka Laaksonen' }]);
});

test('tool_result masks nested text of resource blocks; binary data and types stay', async () => {
  const resource = {
    type: 'resource',
    resource: { uri: 'file:///Matti Virtanen.txt', mimeType: 'text/plain', text: 'Matti Virtanen' },
  };
  const { result, sessionFile } = await runTool({
    content: [resource, { type: 'text', text: 'ok' }],
    structuredContent: {
      content: [{ type: 'image', data: 'TWF0dGkgVmlydGFuZW4=', mimeType: 'image/png' }],
      note: 'Matti Virtanen',
    },
    details: {},
  });
  expect(result.content[0]).toEqual({
    type: 'resource',
    resource: {
      uri: 'file:///Pekka Laaksonen.txt',
      mimeType: 'text/plain',
      text: 'Pekka Laaksonen',
    },
  });
  expect(result.structuredContent).toEqual({
    content: [{ type: 'image', data: 'TWF0dGkgVmlydGFuZW4=', mimeType: 'image/png' }],
    note: 'Pekka Laaksonen',
  });
  noReal(sessionFile());
});

test('edit tool: the real diff in details never reaches the session file', async () => {
  const { cwd, session, sessionFile } = await boot([
    {
      toolCalls: [
        {
          name: 'edit',
          args: { path: 'note.txt', edits: [{ oldText: 'rivi 2', newText: 'rivi 3' }] },
        },
      ],
    },
    { text: 'done' },
  ]);
  writeFileSync(join(cwd, 'note.txt'), 'Hei Virtaselle\nrivi 2\n');
  await session.prompt('Muokkaa');
  expect(readFileSync(join(cwd, 'note.txt'), 'utf8')).toBe('Hei Virtaselle\nrivi 3\n');
  const file = sessionFile();
  noReal(file);
  // Only the masked diff in `details` can carry the surrogate.
  expect(file).toContain('Laaksoselle');
});

test('context_with_system scans JSON incrementally, tool call arguments included', async () => {
  const { llm, sc, session } = await boot([
    { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'Matti Virtanen' } }] },
    { text: 'a' },
    { text: 'b' },
  ]);
  await session.prompt('Kirjoita');
  // The model's tool call carried a real value; the next request has only the surrogate.
  const second = JSON.stringify(llm.requests[1]?.body);
  expect(second).toContain('Pekka Laaksonen');
  noReal(second);
  await session.prompt('Taas');
  const scans = sc.requests.filter((r) => r.path === '/scan').map((r) => r.body.messages);
  expect(scans[0].map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  // Third request: only the last assistant reply and the new user message are new.
  expect(scans[2].map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
  expect(scans[1][0].content.content).toEqual(expect.any(Array));
  noReal(JSON.stringify(llm.requests[2]?.body));
});

test('context_with_system masks a leaked real value and logs it', async () => {
  const { llm, sc, logs, session, sessionFile } = await boot([{ text: 'a' }, { text: 'b' }]);
  sc.state.passthrough = true;
  await session.prompt('Muista Matti Virtanen');
  sc.state.passthrough = false;
  expect(sessionFile()).toContain('Matti Virtanen');
  await session.prompt('Kuka se oli?');
  const body = JSON.stringify(llm.requests[1]?.body);
  expect(body).toContain('Pekka Laaksonen');
  noReal(body);
  const leaks = logs.filter((l) => l.msg === 'pseudo leak');
  expect(leaks.at(-1)).toMatchObject({
    level: 'warn',
    data: { kind: 'PERSON', entityId: 1, messageIndex: expect.any(Number) },
  });
  noReal(JSON.stringify(logs));
});

test('a surrogate the model echoes keeps its surrogate through every hook', async () => {
  // `learn` gives every unknown "Name Surname" a new surrogate, so a re-masked echo would show.
  const { llm, logs, cwd, session } = await boot(
    [
      { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'Pekka Laaksonen' } }] },
      { toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
      { text: 'Tiedostossa lukee Pekka Laaksonen.' },
      { text: 'ok' },
    ],
    [],
    undefined,
    true,
  );
  await session.prompt('kirjoita Matti Virtanen tiedostoon');
  await session.prompt('Kenen nimi siinä oli?');
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('Matti Virtanen'); // tool_call restores
  const tools = (llm.requests[2]?.body as { messages: { role: string }[] }).messages;
  expect(JSON.stringify(tools.filter((m) => m.role === 'tool'))).toContain('Pekka Laaksonen'); // tool_result
  const last = JSON.stringify(llm.requests[3]?.body); // input, scan of the model's own turns
  expect(last).toContain('Tiedostossa lukee Pekka Laaksonen.');
  expect(last).not.toContain('Testi');
  noReal(last);
  expect(logs.filter((l) => l.msg === 'pseudo leak')).toEqual([]);
});

test('context_with_system fails closed when /scan fails, then recovers', async () => {
  const { llm, sc, logs, session } = await boot([{ text: 'a' }, { text: 'b' }]);
  sc.state.scanFail = true;
  await session.prompt('Muista Matti Virtanen');
  expect(llm.requests).toHaveLength(0);
  expect(logs).toContainEqual({
    level: 'warn',
    msg: 'pseudo_down',
    data: { hook: 'context_with_system', error: 'PseudoDownError' },
  });
  sc.state.scanFail = false; // nothing bad was cached: the next turn scans and runs
  await session.prompt('Kuka se oli?');
  expect(llm.requests).toHaveLength(1);
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Pekka Laaksonen');
  noReal(body);
});

test('sidecar down: input handled, no model request', async () => {
  const { llm, sc, logs, session, sessionManager } = await boot([{ text: 'ok' }]);
  await sc.close();
  await session.prompt('Matti Virtanen');
  expect(llm.requests).toHaveLength(0);
  expect(sessionManager.getEntries().filter((e) => e.type === 'message')).toHaveLength(0);
  expect(logs).toContainEqual(
    expect.objectContaining({ level: 'warn', msg: 'pseudo_down', data: expect.anything() }),
  );
});

test('sidecar down: tool call blocked with pseudo_down', async () => {
  let close = async () => {};
  // Input and the first scan pass; the sidecar goes away once the model has answered.
  const kill: ExtensionFactory = (pi) =>
    void pi.on(
      'message_end',
      async (e) => void (e.message.role === 'assistant' && (await close())),
    );
  const { llm, sc, cwd, session, sessionManager } = await boot(
    [{ toolCalls: [{ name: 'write', args: { path: 'out.txt', content: 'x' } }] }, { text: 'done' }],
    [kill],
  );
  close = sc.close;
  await session.prompt('Kirjoita');
  expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
  const results = sessionManager
    .getEntries()
    .flatMap((e) =>
      e.type === 'message' && e.message.role === 'toolResult' ? [JSON.stringify(e.message)] : [],
    );
  expect(results.join()).toContain('pseudo_down');
  expect(llm.requests).toHaveLength(1); // the scan before the next request fails closed too
});

/** Boots with "Pekka Laaksonen" (the surrogate of Matti Virtanen) as a colliding name; `answer` ends the wait. */
async function bootCollision() {
  const asked: number[][] = [];
  let answer: (ok: boolean) => void = () => {};
  const wait = (c: Collision[]) => {
    asked.push(c.map((x) => x.pending_id));
    return new Promise<boolean>((r) => (answer = r));
  };
  const pi = await boot([{ text: 'ok' }], [], undefined, false, {
    names: ['Pekka Laaksonen'],
    wait,
  });
  const resolve = (action: 'accept' | 'reject') =>
    fetch(`${pi.sc.url}/vault/pending/1`, {
      method: 'POST',
      body: JSON.stringify({ user_id: 'u1', action }),
    });
  return { ...pi, asked, answer: (ok: boolean) => answer(ok), resolve };
}

test('a name equal to an issued surrogate holds the input until accepted as a new person', async () => {
  const { llm, sc, logs, asked, answer, resolve, session, sessionFile } = await bootCollision();
  const turn = session.prompt('Soita Pekka Laaksonen huomenna');
  await vi.waitFor(() => expect(asked).toEqual([[1]]));
  expect(llm.requests).toHaveLength(0);
  expect(logs).toContainEqual({
    level: 'warn',
    msg: 'pseudo_collision',
    data: { hook: 'input', pendingIds: [1], kinds: ['PERSON'] },
  });
  expect(sc.requests.find((r) => r.path === '/mask')?.body.user_input).toBe(true);
  await resolve('accept');
  answer(true);
  await turn;
  // The new person has a surrogate of its own: the model never sees Matti Virtanen's surrogate here.
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Soita Uusi');
  expect(body).not.toContain('Pekka Laaksonen');
  expect(sessionFile()).not.toContain('Pekka Laaksonen');
});

test('a collision answered as the same entity keeps that surrogate; an unanswered one drops the input', async () => {
  const { llm, asked, answer, resolve, session, sessionManager } = await bootCollision();
  const dropped = session.prompt('Pekka Laaksonen?');
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  answer(false); // timeout or stop: fail closed
  await dropped;
  expect(llm.requests).toHaveLength(0);
  expect(sessionManager.getEntries().filter((e) => e.type === 'message')).toHaveLength(0);
  const turn = session.prompt('Soita Pekka Laaksonen huomenna');
  await vi.waitFor(() => expect(asked).toHaveLength(2));
  await resolve('reject');
  answer(true);
  await turn;
  expect(JSON.stringify(llm.requests[0]?.body)).toContain('Soita Pekka Laaksonen huomenna');
});

test('without awaitCollision (a child process) input is not checked for collisions', async () => {
  const { sc, llm, session } = await boot([{ text: 'ok' }], [], undefined, false, {
    names: ['Pekka Laaksonen'],
  });
  await session.prompt('Pekka Laaksonen kirjoitti tehtävän');
  expect(sc.requests.find((r) => r.path === '/mask')?.body.user_input).toBeUndefined();
  expect(llm.requests).toHaveLength(1);
});

test('collisions that keep coming after three answers drop the input and log it once', async () => {
  const waits: Collision[][] = [];
  const { llm, logs, session } = await boot([{ text: 'ok' }], [], undefined, false, {
    names: ['Pekka Laaksonen'],
    wait: async (c) => (waits.push(c), true), // "answered", but the row stays open
  });
  await session.prompt('Pekka Laaksonen?');
  expect(waits).toHaveLength(3);
  expect(logs.filter((l) => l.msg === 'pseudo_collision')).toHaveLength(3);
  expect(logs.filter((l) => l.msg === 'pseudo_collision_dropped')).toEqual([
    {
      level: 'warn',
      msg: 'pseudo_collision_dropped',
      data: { hook: 'input', pendingIds: [1], kinds: ['PERSON'] },
    },
  ]);
  expect(llm.requests).toHaveLength(0);
});

test('forkSession posts the two session ids and the fork time (phase 13)', async () => {
  const sc = await startFakeSidecar({ 'Matti Virtanen': 'Pekka Laaksonen' });
  try {
    const client = new PseudoClient(sc.url, 'u1');
    const until = '2026-10-26T10:00:00.000Z';
    expect(await client.forkSession('chat-a', 'chat-b', until)).toEqual({ ok: true, entities: 0 });
    expect(sc.requests.at(-1)).toEqual({
      path: '/session/fork',
      body: { user_id: 'u1', from_session_id: 'chat-a', to_session_id: 'chat-b', until },
    });
    await expect(client.forkSession('chat-a', 'chat-a', until)).rejects.toThrow('status 404');
  } finally {
    await sc.close();
  }
});
