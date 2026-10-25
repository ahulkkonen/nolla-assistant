import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { setup, toolMessageContent } from '@pa/contract-tests/src/harness.ts';
import type { FakeTurn } from '@pa/fake-llm';
import { afterEach, expect, test } from 'vitest';
import { startFakeSidecar } from './fake-sidecar.ts';
import { PseudoClient, pseudoExtension } from './index.ts';

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

async function boot(turns: FakeTurn[], extra: ExtensionFactory[] = [], tools?: string[]) {
  const sc = await startFakeSidecar(DICT);
  closers.push(sc.close);
  const logs: { level: string; msg: string; data?: any }[] = [];
  const ext = pseudoExtension({
    client: new PseudoClient(sc.url, 'u1'),
    sessionId: 'chat-1',
    log: (level, msg, data) => void logs.push({ level, msg, data }),
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

test('tool_result masks content and structuredContent', async () => {
  const custom: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: 'who',
      label: 'who',
      description: 'returns a person',
      parameters: { type: 'object', properties: {} } as never,
      execute: async () => ({
        content: [{ type: 'text', text: 'Henkilö: Matti Virtanen' }],
        structuredContent: { who: 'Matti Virtanen' },
        details: {},
      }),
    });
  };
  const { llm, events, session } = await boot(
    [{ toolCalls: [{ name: 'who', args: {} }] }, { text: 'done' }],
    [custom],
    ['read', 'write', 'edit', 'who'],
  );
  await session.prompt('Kuka?');
  const end = events.find((e) => e.type === 'tool_execution_end');
  const result = end && 'result' in end ? end.result : undefined;
  expect(result.content).toEqual([{ type: 'text', text: 'Henkilö: Pekka Laaksonen' }]);
  expect(result.structuredContent).toEqual({ who: 'Pekka Laaksonen' });
  expect(toolMessageContent(llm.requests[1]?.body)).toBe('Henkilö: Pekka Laaksonen');
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
    data: { kind: 'person', entityId: 1, messageIndex: expect.any(Number) },
  });
  noReal(JSON.stringify(logs));
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
  // Runs after the pseudo input handler, so input is masked and then the sidecar goes away.
  const kill: ExtensionFactory = (pi) => void pi.on('input', async () => void (await close()));
  const { llm, sc, cwd, session } = await boot(
    [{ toolCalls: [{ name: 'write', args: { path: 'out.txt', content: 'x' } }] }, { text: 'done' }],
    [kill],
  );
  close = sc.close;
  await session.prompt('Kirjoita');
  expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
  expect(toolMessageContent(llm.requests[1]?.body)).toContain('pseudo_down');
});
