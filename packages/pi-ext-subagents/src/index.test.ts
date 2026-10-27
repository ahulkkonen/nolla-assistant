import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootPi, lastUserText, toolMessageContent } from '@pa/contract-tests/src/harness.ts';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { PseudoClient, pseudoExtension } from '@pa/pi-ext-pseudo';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { afterEach, expect, test } from 'vitest';
import { type AskInput, type Child, piCli as resolvePiCli, subagentsExtension } from './index.ts';

const REAL = 'Matti Virtanen';
const SURROGATE = 'Pekka Laaksonen';
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function boot(
  turns: FakeTurn[],
  extra: Partial<Parameters<typeof subagentsExtension>[0]> = {},
) {
  const llm = await startFakeLlm(turns);
  const sc = await startFakeSidecar({ [REAL]: SURROGATE });
  const dataDir = mkdtempSync(join(tmpdir(), 'pa-subagents-'));
  const states: Pick<Child, 'id' | 'label' | 'status'>[][] = [];
  const pi = await bootPi({
    dataDir,
    llmUrl: llm.url,
    tools: ['read', 'subagent'],
    extensions: [
      pseudoExtension({ client: new PseudoClient(sc.url, 'u1'), sessionId: 'chat-1' }),
      subagentsExtension({
        chatId: 'chat-1',
        userId: 'u1',
        dataDir,
        agentDir: join(dataDir, 'agent'),
        cwd: join(dataDir, 'work'),
        litellm: { url: llm.url, key: 'test-key' },
        pseudoUrl: sc.url,
        provider: 'zdr',
        model: 'zdr/strong',
        tools: ['read'],
        onState: (c) => void states.push(c),
        ask: async () => true,
        log: () => {},
        ...extra,
      }),
    ],
  });
  closers.push(
    () => rmSync(dataDir, { recursive: true, force: true }),
    () => llm.close(),
    () => sc.close(),
    () => pi.session.dispose(),
  );
  const subDir = join(dataDir, 'sessions', 'u1', 'chat-1', 'sub');
  const childFiles = () =>
    readdirSync(subDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(subDir, f), 'utf8'));
  return { llm, states, childFiles, dataDir, ...pi };
}

test('parallel: three masked children with live state', async () => {
  const tasks = ['a', 'b', 'c'].map((label) => ({ label, task: `Etsi tietoa: ${SURROGATE}` }));
  const { llm, session, states, childFiles } = await boot([
    { toolCalls: [{ name: 'subagent', args: { mode: 'parallel', tasks } }] },
    { text: 'child result' },
    { text: 'child result' },
    { text: 'child result' },
    { text: 'done' },
  ]);
  await session.prompt(`Tutki ${REAL}`);

  const files = childFiles();
  expect(files).toHaveLength(3);
  for (const f of files) {
    expect(f).not.toContain(REAL);
    expect(f).toContain(SURROGATE);
  }
  expect(llm.requests).toHaveLength(5);
  for (const r of llm.requests) expect(JSON.stringify(r.body)).not.toContain(REAL);
  for (const r of llm.requests.slice(1, 4)) expect(lastUserText(r.body)).toContain(SURROGATE);

  const ids = states[0]?.map((c) => c.id) ?? [];
  expect(ids).toHaveLength(3);
  for (const id of ids) {
    const seq = states.map((s) => s.find((c) => c.id === id)?.status);
    expect(seq.filter((s, i) => s !== seq[i - 1])).toEqual(['queued', 'running', 'done']);
  }
  const result = JSON.stringify(toolMessageContent(llm.requests[4]?.body));
  for (const h of ['### a', '### b', '### c']) expect(result).toContain(h);
}, 60_000);

test('chain: the second task gets the first result', async () => {
  const { llm, session } = await boot([
    {
      toolCalls: [
        {
          name: 'subagent',
          args: {
            mode: 'chain',
            tasks: [
              { label: 'one', task: 'first task' },
              { label: 'two', task: 'second task' },
            ],
          },
        },
      ],
    },
    { text: 'RESULT-ONE' },
    { text: 'RESULT-TWO' },
    { text: 'done' },
  ]);
  await session.prompt('go');
  const second = lastUserText(llm.requests[2]?.body);
  expect(second).toContain('second task');
  expect(second).toContain('RESULT-ONE');
  expect(JSON.stringify(toolMessageContent(llm.requests[3]?.body))).toContain('RESULT-TWO');
}, 60_000);

test('a child approval reaches the parent ask with real values', async () => {
  const asked: AskInput[] = [];
  const { llm, session, dataDir } = await boot(
    [
      {
        toolCalls: [
          { name: 'subagent', args: { mode: 'single', tasks: [{ label: 'w', task: 'write' }] } },
        ],
      },
      { toolCalls: [{ name: 'write', args: { path: 'x.txt', content: SURROGATE } }] },
      { text: 'blocked' },
      { text: 'done' },
    ],
    {
      tools: ['read', 'write'],
      approvalAlways: ['write'],
      ask: async (req) => (asked.push(req), false),
    },
  );
  await session.prompt('go');
  expect(asked).toEqual([
    expect.objectContaining({
      chatId: 'chat-1',
      tool: 'write',
      args: { path: 'x.txt', content: REAL },
    }),
  ]);
  expect(readdirSync(join(dataDir, 'work'))).not.toContain('x.txt');
  expect(JSON.stringify(llm.requests[2]?.body)).toContain('käyttäjä esti työkalun');
}, 60_000);

// Decision 11 in both directions: a child keeps the parent's prefix.
test.each([
  ['zdr', 'zdr/strong', 'open/x/y'],
  ['open', 'open/acme/model-1', 'zdr/strong'],
] as const)(
  'proof 7: a %s chat (%s) refuses the task model %s and starts no child',
  async (provider, model, child) => {
    const { llm, session, states, dataDir } = await boot(
      [
        {
          toolCalls: [
            {
              name: 'subagent',
              args: {
                mode: 'parallel',
                tasks: [
                  { label: 'ok', task: 'first task' },
                  { label: 'leak', task: 'second task', model: child },
                ],
              },
            },
          ],
        },
        { text: 'done' },
      ],
      { provider, model },
    );
    await session.prompt('go');
    // The parent's two calls only: no child ever asked the model.
    expect(llm.requests).toHaveLength(2);
    expect(states).toEqual([]);
    expect(existsSync(join(dataDir, 'sessions', 'u1', 'chat-1', 'sub'))).toBe(false);
    expect(JSON.stringify(toolMessageContent(llm.requests[1]?.body))).toContain(
      `subagent models must start with ${provider}/`,
    );
  },
  60_000,
);

test('onUsage gets each assistant message of a child with its usage (phase 13)', async () => {
  const usage: unknown[] = [];
  const { session } = await boot(
    [
      {
        toolCalls: [
          { name: 'subagent', args: { mode: 'chain', tasks: [{ label: 'one', task: 'task' }] } },
        ],
      },
      { text: 'child result', usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.002 } },
      { text: 'done' },
    ],
    { onUsage: (m) => void usage.push(m) },
  );
  await session.prompt('go');
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({
    role: 'assistant',
    model: 'zdr/strong',
    usage: { input: 120, output: 30 },
  });
}, 60_000);

// The production image installs Pi under apps/server only (peer dependency here).
test('piCli resolves the Pi binary from the entry script paths', () => {
  const saved = process.argv[1];
  process.argv[1] = new URL('../../../apps/server/src/main.ts', import.meta.url).pathname;
  try {
    expect(resolvePiCli()).toMatch(/pi-coding-agent/);
  } finally {
    process.argv[1] = saved;
  }
});
