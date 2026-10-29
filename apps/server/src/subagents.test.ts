import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { approvals, childAsk } from './approval.ts';
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

test("phase-22 decision 7: a child's tool passes without a card while the parent's toggle allows it", async () => {
  const sent: string[] = [];
  const a = approvals((_chatId, msg) => sent.push(msg.type));
  const ask = childAsk(a.ask, 'c1', ['write']);
  const req = (tool: string) => ({ chatId: 'c1', tool, args: {}, reason: 'r', expiresAt: '' });
  const signal = new AbortController().signal;

  a.autoApprove.add('c1');
  await expect(ask(req('write'), signal)).resolves.toBe(true);
  expect(sent).toEqual([]);

  // A tool outside the list, and the listed tool once the toggle is off, still ask.
  for (const tool of ['bash', 'write']) {
    if (tool === 'write') a.autoApprove.delete('c1');
    const answer = ask(req(tool), signal);
    const [request] = a.list('c1');
    expect(request?.tool).toBe(tool);
    a.respond(request?.requestId ?? '', false);
    await expect(answer).resolves.toBe(false);
  }
  expect(sent).toEqual([
    'approval.request',
    'approval.resolved',
    'approval.request',
    'approval.resolved',
  ]);
});

test("an unattended chat: a child's listed tool passes, others are denied at once without a card", async () => {
  const sent: string[] = [];
  const a = approvals((_chatId, msg) => sent.push(msg.type));
  const ask = childAsk(a.ask, 'c1', []);
  const req = (tool: string) => ({ chatId: 'c1', tool, args: {}, reason: 'r', expiresAt: '' });
  const signal = new AbortController().signal;
  a.unattended.set('c1', ['write']);
  await expect(ask(req('write'), signal)).resolves.toBe(true);
  await expect(ask(req('bash'), signal)).resolves.toBe(false);
  expect(sent).toEqual([]);
});
