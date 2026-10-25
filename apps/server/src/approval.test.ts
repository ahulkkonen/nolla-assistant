import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeTurn } from '@pa/fake-llm';
import { afterEach, expect, test, vi } from 'vitest';
import { DENIED_REASON, TIMEOUT_REASON } from './approval.ts';
import { boot, bootChat, bootPseudo, connect, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const WRITE: FakeTurn[] = [
  { toolCalls: [{ name: 'write', args: { path: 'muistio.txt', content: 'Pekka Laaksonen' } }] },
  { text: 'Valmis.' },
];
const body = (llm: { requests: { body: unknown }[] }, i: number) =>
  JSON.stringify(llm.requests[i]?.body);

test('approve: request shows real args, then the tool runs', { timeout: 30_000 }, async () => {
  const { c, chat, llm, srv } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, WRITE);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita Matti Virtanen muistiin' });
  const req = await c.next('approval.request');
  expect(req).toMatchObject({ chatId: chat.id, tool: 'write' });
  expect(req.args).toEqual({ path: 'muistio.txt', content: 'Matti Virtanen' });
  expect(Date.parse(req.expiresAt)).toBeGreaterThan(Date.now() + 9 * 60_000);
  expect(body(llm, 0)).toContain('Pekka Laaksonen');
  expect(body(llm, 0)).not.toContain('Matti Virtanen');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  expect((await c.next('approval.resolved')).outcome).toBe('approved');
  expect((await c.next('tool.end')).status).toBe('ok');
  await c.idle();
  expect(readFileSync(join(srv.registry.cwd, 'muistio.txt'), 'utf8')).toBe('Matti Virtanen');
});

test('deny: the tool does not run and the model gets the reason', { timeout: 30_000 }, async () => {
  const { c, chat, llm, srv } = await bootChat(WRITE);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: false });
  expect((await c.next('tool.end')).status).toBe('denied');
  await c.idle();
  expect(existsSync(join(srv.registry.cwd, 'muistio.txt'))).toBe(false);
  expect(body(llm, 1)).toContain(DENIED_REASON);
  expect((await c.next('approval.resolved')).outcome).toBe('denied');
  // A late answer gets `expired`, not an error.
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  expect(await c.next('approval.resolved')).toEqual({
    type: 'approval.resolved',
    chatId: chat.id,
    requestId: req.requestId,
    outcome: 'expired',
  });
});

test('user.stop during the wait blocks the tool at once', { timeout: 30_000 }, async () => {
  const { c, chat, srv } = await bootChat(WRITE);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  const t0 = Date.now();
  c.send({ type: 'user.stop', chatId: chat.id });
  expect(await c.next('approval.resolved')).toMatchObject({
    requestId: req.requestId,
    outcome: 'expired',
  });
  // The abort also ends the follow-up model call (`llm_failed`), so read the inbox directly.
  await vi.waitFor(() =>
    expect(c.inbox.some((m) => m.type === 'agent.status' && m.state === 'idle')).toBe(true),
  );
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(existsSync(join(srv.registry.cwd, 'muistio.txt'))).toBe(false);
});

test('a reconnecting socket gets the pending request again', { timeout: 30_000 }, async () => {
  const { c, chat, config } = await bootChat(WRITE);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  c.ws.close();
  const c2 = await connect(config.port);
  expect(await c2.next('approval.request')).toEqual(req);
  c2.send({ type: 'chat.open', chatId: chat.id });
  await c2.next('chat.state');
  expect(await c2.next('approval.request')).toEqual(req);
  c2.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  expect((await c2.next('tool.end')).status).toBe('ok');
  await c2.idle();
});

test('timeout denies', { timeout: 30_000 }, async () => {
  const { c, chat, llm } = await bootChat(WRITE, { APPROVAL_TIMEOUT_MS: '300' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  await c.next('approval.request');
  expect((await c.next('tool.end')).status).toBe('denied');
  await c.idle();
  expect(body(llm, 1)).toContain(TIMEOUT_REASON);
});

test('read never asks', { timeout: 30_000 }, async () => {
  const { c, chat, srv } = await bootChat([
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
    { text: 'Luin.' },
  ]);
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hei');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Lue' });
  expect((await c.next('tool.end')).status).toBe('ok');
  await c.idle();
  expect(c.inbox.some((m) => m.type === 'approval.request')).toBe(false);
});

test('research agent: own prompt, kept per chat; unknown agent errors', {
  timeout: 30_000,
}, async () => {
  const { config, run, llm } = await boot([{ text: 'a' }, { text: 'b' }]);
  await run();
  const c = await connect(config.port);
  const { agents } = await c.next('agents.state');
  expect(agents.map((a) => [a.id, a.name, a.subagents])).toEqual([
    ['assistant', 'Avustaja', false],
    ['research', 'Tutkija', true],
  ]);
  c.send({ type: 'chat.create', agentId: 'research' });
  const { chat } = await c.next('chat.created');
  expect(chat.agentId).toBe('research');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  expect(body(llm, 0)).toContain('Olet tutkija');
  // An existing chat keeps its agent.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi', agentId: 'assistant' });
  await c.idle();
  expect(body(llm, 1)).toContain('Olet tutkija');
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).chat.agentId).toBe('research');
  c.send({ type: 'chat.create', agentId: 'nope' });
  await expect(c.next('chat.created')).rejects.toThrow('not_found');
});
