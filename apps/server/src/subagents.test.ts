import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { boot, connect, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

test('default profile: a parallel subagent run streams subagent.state', {
  timeout: 60_000,
}, async () => {
  const tasks = ['a', 'b', 'c'].map((label) => ({ label, task: `task ${label}` }));
  const { config, run } = await boot([
    { toolCalls: [{ name: 'subagent', args: { mode: 'parallel', tasks } }] },
    { text: 'child result' },
    { text: 'child result' },
    { text: 'child result' },
    { text: 'Valmis.' },
  ]);
  const srv = await run();
  const c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Tutki kolme asiaa' });
  const states = [];
  for (;;) {
    const s = await c.next('subagent.state');
    expect(s.chatId).toBe(chat.id);
    states.push(s);
    if (s.children.length && s.children.every((ch) => ch.status === 'done')) break;
  }
  expect(states[0]?.children.map((ch) => [ch.label, ch.status])).toEqual([
    ['a', 'queued'],
    ['b', 'queued'],
    ['c', 'queued'],
  ]);
  expect(states.some((s) => s.children.some((ch) => ch.status === 'running'))).toBe(true);
  await c.idle();
  const sub = join(srv.registry.sessionDir, chat.id, 'sub');
  expect(readdirSync(sub).filter((f) => f.endsWith('.jsonl'))).toHaveLength(3);
});
