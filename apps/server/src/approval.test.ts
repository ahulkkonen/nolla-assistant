import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, usage } from '@nolla/db';
import type { FakeTurn } from '@nolla/fake-llm';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import {
  approvalGate,
  childAsk,
  DENIED_REASON,
  TIMEOUT_REASON,
  UNATTENDED_REASON,
  type View,
} from './approval.ts';
import { AutomationFile } from './automations.ts';
import { childTools } from './pi/registry.ts';
import {
  boot,
  bootChat,
  bootPseudo,
  connect,
  runCleanups,
  seedAgents,
  tempDir,
} from './test-utils.ts';

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

test('second agent: own prompt, kept per chat; unknown agent errors', {
  timeout: 30_000,
}, async () => {
  const agentsDir = join(tempDir('pa-agents-'), 'agents');
  seedAgents(agentsDir);
  const { config, run, llm } = await boot([{ text: 'a' }, { text: 'b' }], {
    AGENTS_DIR: agentsDir,
  });
  await run();
  const c = await connect(config.port);
  const { agents } = await c.next('agents.state');
  expect(agents.map((a) => [a.id, a.name, a.subagents])).toEqual([
    ['assistant', 'Avustaja', true],
    ['kirjoittaja', 'Kirjoittaja', false],
  ]);
  c.send({ type: 'chat.create', agentId: 'kirjoittaja' });
  const { chat } = await c.next('chat.created');
  expect(chat.agentId).toBe('kirjoittaja');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  expect(body(llm, 0)).toContain('Olet kirjoittaja');
  // An existing chat keeps its agent.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi', agentId: 'assistant' });
  await c.idle();
  expect(body(llm, 1)).toContain('Olet kirjoittaja');
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).chat.agentId).toBe('kirjoittaja');
  c.send({ type: 'chat.create', agentId: 'nope' });
  await expect(c.next('chat.created')).rejects.toThrow('not_found');
});

test('registry: a chat whose agent profile is gone opens with the default agent', {
  timeout: 30_000,
}, async () => {
  const { c, chat, srv, llm } = await bootChat([
    { text: 'Hei.', usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]);
  // An install that deleted `research.yaml` by hand still has chats with that id.
  srv.db.update(chats).set({ agentId: 'research' }).where(eq(chats.id, chat.id)).run();
  await srv.registry.drop(chat.id);
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).chat.agentId).toBe('research');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  expect(body(llm, 0)).toContain('henkilökohtainen avustaja');
  expect(srv.db.select().from(usage).get()?.agentId).toBe('assistant');
});

test('auto-approve: an open card stays open, then the gated tool runs without a card', {
  timeout: 30_000,
}, async () => {
  const { c, chat, srv } = await bootChat([
    ...WRITE,
    { toolCalls: [{ name: 'write', args: { path: 'toinen.txt', content: 'x' } }] },
    { text: 'Taas.' },
  ]);
  // `chat.create` tells the new chat's state: off.
  expect((await c.next('chat.autoApprove')).on).toBe(false);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  c.send({ type: 'chat.setAutoApprove', chatId: chat.id, on: true });
  expect(await c.next('chat.autoApprove')).toEqual({
    type: 'chat.autoApprove',
    chatId: chat.id,
    on: true,
    tools: ['write', 'edit', 'bash'],
  });
  expect(srv.approvals.list(chat.id)).toEqual([req]);
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  await c.idle();
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita taas' });
  await c.idle();
  expect(existsSync(join(srv.registry.cwd, 'toinen.txt'))).toBe(true);
  expect(c.inbox.some((m) => m.type === 'approval.request')).toBe(false);
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).autoApprove?.on).toBe(true);
});

test('auto-approve: always minus MCP writes and web_search; a running automation refuses', {
  timeout: 30_000,
}, async () => {
  const dir = tempDir('pa-auto-');
  seedAgents(join(dir, 'agents'));
  writeFileSync(
    join(dir, 'agents', 'tyokalut.yaml'),
    [
      'id: tyokalut',
      'name: Työkalut',
      'model: zdr/strong',
      'prompt: prompts/kirjoittaja.md',
      'tools:',
      '  allow: [read, write, web_search]',
      '  mcp: [ws]',
      'approval:',
      '  always: [write, web_search, mcp__ws__send]',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'mcp.yaml'),
    [
      'servers:',
      '  ws:',
      '    url: http://127.0.0.1:9/mcp',
      '    tools:',
      '      - { name: send, write: true }',
      '',
    ].join('\n'),
  );
  const { config, run } = await boot([], {
    AGENTS_DIR: join(dir, 'agents'),
    MCP_CONFIG: join(dir, 'mcp.yaml'),
  });
  const srv = await run();
  const c = await connect(config.port);
  c.send({ type: 'chat.create', agentId: 'tyokalut' });
  const { chat } = await c.next('chat.created');
  expect(await c.next('chat.autoApprove')).toMatchObject({ on: false, tools: ['write'] });
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).autoApprove).toEqual({ on: false, tools: ['write'] });
  c.send({ type: 'chat.setAutoApprove', chatId: chat.id, on: true });
  expect(await c.next('chat.autoApprove')).toMatchObject({ on: true, tools: ['write'] });
  expect(srv.approvals.autoApprove.has(chat.id)).toBe(true);
  c.send({ type: 'chat.setAutoApprove', chatId: chat.id, on: false });
  expect(await c.next('chat.autoApprove')).toMatchObject({ on: false, tools: ['write'] });
  expect(srv.approvals.autoApprove.has(chat.id)).toBe(false);
  // A running automation owns its chat's list.
  srv.approvals.unattended.set(chat.id, []);
  c.send({ type: 'chat.setAutoApprove', chatId: chat.id, on: true });
  await expect(c.next('chat.autoApprove')).rejects.toThrow('bad_message');
  expect(srv.approvals.autoApprove.has(chat.id)).toBe(false);
});

/** The gate's `tool_call` handler without Pi; `ask` approves. */
function gate(
  o: {
    never?: string[];
    unattended?: Map<string, string[]>;
    toggle?: boolean;
    views?: Record<string, View>;
    tainted?: () => boolean;
  } = {},
) {
  let handler: ((e: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const ask = vi.fn(async (_req: Record<string, unknown>) => true);
  const asker = Object.assign(ask, {
    ...(o.unattended ? { unattended: o.unattended } : {}),
    ...(o.toggle ? { autoApprove: new Set(['c1']) } : {}),
  });
  approvalGate({
    chatId: 'c1',
    policy: { always: [], never: o.never ?? [] },
    ask: asker,
    autoTools: ['profile_edit', 'chat_read'],
    views: o.views,
    tainted: o.tainted,
  })({
    on: (_: string, h: never) => {
      handler = h;
    },
  } as never);
  const call = (toolName: string, input: object = {}) =>
    handler?.({ toolName, toolCallId: 't1', input }, {});
  return { ask, call };
}

test('gate: a harness tool asks even when the profile lists it in never', async () => {
  const { ask, call } = gate({ never: ['profile_edit'] });
  expect(await call('profile_edit')).toBeUndefined();
  expect(ask).toHaveBeenCalledTimes(1);
  expect(await call('read')).toBeUndefined();
  expect(ask).toHaveBeenCalledTimes(1);
});

test('gate: unattended blocks a harness tool even when autoApprove lists it', async () => {
  const { ask, call } = gate({ unattended: new Map([['c1', ['chat_read']]]) });
  expect(await call('chat_read')).toEqual({ block: true, reason: UNATTENDED_REASON });
  expect(ask).not.toHaveBeenCalled();
  // AutomationFile refuses the list itself.
  const file = { id: 'a', cron: '0 7 * * *', prompt: 'x' };
  expect(AutomationFile.safeParse({ ...file, autoApprove: ['chat_read'] }).success).toBe(false);
  expect(AutomationFile.safeParse({ ...file, autoApprove: ['bash'] }).success).toBe(true);
});

test('gate: the toggle does not cover a harness tool', async () => {
  const { ask, call } = gate({ toggle: true });
  await call('chat_read');
  expect(ask).toHaveBeenCalledTimes(1);
});

test('gate: a views error blocks without a card; a view and the taint go on the card', async () => {
  const views: Record<string, View> = {
    profile_edit: async () => ({ error: 'Muutos ei kelpaa: body' }),
    chat_read: async (input) => ({
      view: {
        kind: 'chat',
        chatId: null,
        title: null,
        createdAt: null,
        messages: null,
        query: String(input.title),
      },
    }),
  };
  const { ask, call } = gate({ views, tainted: () => true });
  expect(await call('profile_edit')).toEqual({ block: true, reason: 'Muutos ei kelpaa: body' });
  expect(ask).not.toHaveBeenCalled();
  expect(await call('chat_read', { title: 'loma' })).toBeUndefined();
  expect(ask.mock.calls[0]?.[0]).toMatchObject({
    tool: 'chat_read',
    tainted: true,
    view: { kind: 'chat', query: 'loma' },
  });
});

test('children never get a harness tool, and childAsk never passes one', async () => {
  expect(
    childTools(['read', 'bash', 'recall', 'profile_edit', 'chat_read', 'automation_edit']),
  ).toEqual(['read', 'bash']);
  const ask = Object.assign(async () => true, {
    unattended: new Map([['c1', ['chat_read']]]),
  });
  const req = { chatId: 'c1', callId: 't', tool: 'chat_read', args: {}, reason: '', expiresAt: '' };
  expect(await childAsk(ask, 'c1', ['chat_read'])(req, new AbortController().signal)).toBe(false);
});
