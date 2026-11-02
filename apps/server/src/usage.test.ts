import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, openDb, usage } from '@nolla/db';
import type { CallUsage } from '@nolla/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { bootBroker, bootChat, runCleanups, tempDir } from './test-utils.ts';
import {
  chatUsage,
  messageUsage,
  monthOf,
  type RecordUsage,
  rawUsage,
  usageExtension,
  usageMonth,
  usageRecorder,
} from './usage.ts';

afterEach(runCleanups);

function freshDb() {
  const { db, sqlite } = openDb(join(tempDir('pa-usage-'), 'app.db'));
  const now = new Date().toISOString();
  db.insert(chats)
    .values({
      id: 'c1',
      userId: 'u1',
      agentId: 'kirjoittaja',
      sessionPath: 's/',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { db, close: () => sqlite.close() };
}

const assistant = (usageObj: object, extra: object = {}) => ({
  role: 'assistant',
  model: 'zdr/strong',
  usage: usageObj,
  ...extra,
});
const piUsage = {
  input: 100,
  output: 20,
  cacheRead: 40,
  cacheWrite: 0,
  reasoning: 5,
  totalTokens: 160,
  cost: { total: 0.0009 },
};

test('messageUsage: the billed cost from pa, else Pi estimate; nothing without tokens', () => {
  expect(messageUsage(assistant(piUsage, { pa: { costUsd: 0.0123 } }))).toEqual({
    model: 'zdr/strong',
    input: 100,
    output: 20,
    cacheRead: 40,
    cacheWrite: 0,
    reasoning: 5,
    costUsd: 0.0123,
    estimated: false,
  });
  expect(messageUsage(assistant(piUsage))).toMatchObject({ costUsd: 0.0009, estimated: true });
  expect(
    messageUsage(assistant({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
  ).toBeUndefined();
  expect(messageUsage({ role: 'user', model: 'x', usage: piUsage })).toBeUndefined();
  // A child's RPC record is plain JSON: bad numbers count as zero.
  expect(messageUsage(assistant({ input: '7', output: 3 }))).toMatchObject({ input: 0, output: 3 });
});

test('rawUsage: LiteLLM cost when given, else the alias price of infra/models.json', () => {
  const body = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 400 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
  expect(rawUsage('zdr/task-small', { ...body, cost: 0.0004 })).toEqual({
    model: 'zdr/task-small',
    input: 600,
    output: 200,
    cacheRead: 400,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0.0004,
    estimated: false,
  });
  // 0.11 / 0.55 / 0.011 per 1M (input / output / cache read).
  const est = rawUsage('zdr/task-small', body);
  expect(est?.estimated).toBe(true);
  expect(est?.costUsd).toBeCloseTo((0.11 * 600 + 0.55 * 200 + 0.011 * 400) / 1e6, 12);
  expect(rawUsage('zdr/task-small', { prompt_tokens: 0, completion_tokens: 0 })).toBeUndefined();
  expect(rawUsage('zdr/task-small', undefined)).toBeUndefined();
});

test('usageRecorder: one row, the chat totals in the same transaction, the chat agent', () => {
  const { db, close } = freshDb();
  const record = usageRecorder(db, 'u1', () => {});
  const u = messageUsage(assistant(piUsage, { pa: { costUsd: 0.01 } }));
  record({ kind: 'task', chatId: 'c1' }, u);
  record({ kind: 'chat', chatId: 'c1', agentId: 'assistant' }, u);
  record({ kind: 'task', chatId: null }, u);
  record({ kind: 'chat', chatId: 'c1' }, undefined);
  const rows = db.select().from(usage).all();
  expect(rows.map((r) => [r.kind, r.chatId, r.agentId])).toEqual([
    ['task', 'c1', 'kirjoittaja'],
    ['chat', 'c1', 'assistant'],
    ['task', null, null],
  ]);
  const chat = db.select().from(chats).where(eq(chats.id, 'c1')).get();
  expect(chat?.costUsd).toBeCloseTo(0.02, 12);
  expect(chat?.tokens).toBe(320);
  // Phase-16: the token split adds up with the totals (two rows of 100/20/40/0).
  expect(chat && chatUsage(chat)).toEqual({
    costUsd: chat?.costUsd,
    tokens: 320,
    input: 200,
    output: 40,
    cacheRead: 80,
    cacheWrite: 0,
  });
  close();
});

test('usageMonth: Helsinki month limits, grouped by model, highest cost first', () => {
  const { db, close } = freshDb();
  const at = (iso: string) =>
    usageRecorder(
      db,
      'u1',
      () => {},
      () => new Date(iso),
    );
  const call = (model: string, costUsd: number, estimated = false) => ({
    model,
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 1,
    costUsd,
    estimated,
  });
  // 2026-10-01 00:30 in Helsinki (UTC+3): October. 2026-09-30 23:30 Helsinki: September.
  at('2026-09-30T21:30:00.000Z')({ kind: 'chat', chatId: 'c1' }, call('zdr/strong', 0.5));
  at('2026-09-30T20:30:00.000Z')({ kind: 'chat', chatId: 'c1' }, call('zdr/strong', 9));
  at('2026-10-15T10:00:00.000Z')(
    { kind: 'chat', chatId: 'c1' },
    call('zdr/google/gemini-4-argon', 2),
  );
  at('2026-10-15T11:00:00.000Z')(
    { kind: 'subagent', chatId: 'c1' },
    { ...call('zdr/google/gemini-4-argon', 1, true), cacheRead: 30, cacheWrite: 6 },
  );
  // Another user's row never counts.
  usageRecorder(
    db,
    'u2',
    () => {},
    () => new Date('2026-10-15T10:00:00.000Z'),
  )({ kind: 'chat', chatId: null }, call('zdr/strong', 100));
  const catalog = {
    get: (id: string) =>
      id === 'google/gemini-4-argon' ? ({ name: 'Gemini 4 Argon' } as never) : undefined,
  };
  const state = usageMonth(db, 'u1', '2026-10', catalog, new Date('2026-12-01T12:00:00.000Z'));
  expect(state.rows).toEqual([
    {
      model: 'zdr/google/gemini-4-argon',
      name: 'Gemini 4 Argon',
      calls: 2,
      tokens: 66,
      reasoning: 2,
      input: 20,
      output: 10,
      cacheRead: 30,
      cacheWrite: 6,
      costUsd: 3,
      estimated: true,
    },
    {
      model: 'zdr/strong',
      name: 'Strong (ZDR)',
      calls: 1,
      tokens: 15,
      reasoning: 1,
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.5,
      estimated: false,
    },
  ]);
  expect(state.months).toEqual(['2026-12', '2026-11', '2026-10', '2026-09']);
  expect(usageMonth(db, 'u1', '2026-09', catalog).rows.map((r) => r.costUsd)).toEqual([9]);
  expect(monthOf(new Date('2026-12-31T22:30:00.000Z'))).toBe('2027-01');
  close();
});

const reply = {
  text: 'Vastaus.',
  reasoning: 'Mietin ensin tätä ja sitten tuota.',
  thinkMs: 60,
  usage: { prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 5, cost: 0.0123 },
};

test('a streamed cost becomes pa.costUsd and one usage row; the thinking time lands in pa', async () => {
  const { c, chat, srv } = await bootChat([reply]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kysymys' });
  await c.idle();
  const rows = srv.db.select().from(usage).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: 'chat',
    chatId: chat.id,
    agentId: 'assistant',
    model: 'zdr/google/gemini-4-argon',
    input: 100,
    output: 20,
    reasoning: 5,
    costUsd: 0.0123,
    estimated: false,
  });
  const row = srv.db.select().from(chats).where(eq(chats.id, chat.id)).get();
  expect(row?.costUsd).toBe(0.0123);
  expect(row?.tokens).toBe(120);
  const session = await srv.registry.get(chat.id);
  const entry = session.sessionManager
    .getEntries()
    .find((e) => e.type === 'message' && e.message.role === 'assistant');
  const message = (
    entry as {
      message: { pa?: { costUsd?: number; thinkingMs?: number }; content: { type: string }[] };
    }
  ).message;
  expect(message.pa?.costUsd).toBe(0.0123);
  expect(message.pa?.thinkingMs).toBeGreaterThanOrEqual(50);
  expect(message.content.map((b) => b.type)).toEqual(['thinking', 'text']);
  // Stored in the JSONL, not only in memory.
  const file = readFileSync(session.sessionManager.getSessionFile() ?? '', 'utf8');
  expect(file).toContain('"pa":{"costUsd":0.0123,"thinkingMs":');
});

test('without a cost the row is an estimate from the model price', async () => {
  const { c, chat, srv } = await bootChat([
    { text: 'Vastaus.', usage: { prompt_tokens: 1000, completion_tokens: 100 } },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kysymys' });
  await c.idle();
  const [row] = srv.db.select().from(usage).all();
  // Fake catalog price of Argon: 2 / 10 USD per 1M tokens.
  expect(row?.estimated).toBe(true);
  expect(row?.costUsd).toBeCloseTo(0.003, 12);
});

test('the title job writes a task row of its chat', { timeout: 20_000 }, async () => {
  const title = JSON.stringify({
    title: 'Otsikko',
    topics: [],
    proposed_topic: null,
    summary: 'Lyhyt.',
  });
  const { c, chat, srv } = await bootChat([
    { text: 'Vastaus.' },
    {
      match: 'Aiheet:',
      text: title,
      usage: { prompt_tokens: 300, completion_tokens: 40, cost: 0.0004 },
    },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kysymys' });
  await c.next('chat.titled');
  const rows = srv.db.select().from(usage).all();
  expect(rows).toEqual([
    expect.objectContaining({
      kind: 'task',
      chatId: chat.id,
      agentId: 'assistant',
      model: 'zdr/task-small',
      costUsd: 0.0004,
    }),
  ]);
  expect(srv.db.select().from(chats).where(eq(chats.id, chat.id)).get()?.tokens).toBe(340);
});

test('a subagent child writes a subagent row of the parent chat', { timeout: 60_000 }, async () => {
  const { c, chat, srv } = await bootBroker([
    {
      toolCalls: [
        { name: 'subagent', args: { mode: 'chain', tasks: [{ label: 'a', task: 'task a' }] } },
      ],
    },
    { match: 'task a', text: 'child result', usage: { prompt_tokens: 50, completion_tokens: 10 } },
    { text: 'Valmis.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Tutki' });
  await c.idle();
  const rows = srv.db.select().from(usage).all();
  expect(rows).toEqual([
    expect.objectContaining({
      kind: 'subagent',
      chatId: chat.id,
      agentId: 'assistant',
      input: 50,
      output: 10,
      estimated: true,
    }),
  ]);
});

/** The extension's handlers on a stand-in for Pi's extension API. */
function extensionHandlers(record: RecordUsage) {
  const handlers = new Map<string, (e: unknown) => unknown>();
  usageExtension(
    { kind: 'chat', chatId: 'c1' },
    record,
  )({
    on: (name: string, fn: (e: unknown) => unknown) => void handlers.set(name, fn),
  } as never);
  return (name: string, e: unknown) => handlers.get(name)?.(e);
}
const assistantMsg = (responseId: string, timestamp: number) => ({
  role: 'assistant',
  model: 'zdr/strong',
  responseId,
  timestamp,
  content: [],
  usage: { ...piUsage, cost: { total: 0.0009 } },
});

test('the extension: cost by response id, one row per message, a broken cost is an estimate', () => {
  const rows: CallUsage[] = [];
  const warnings: string[] = [];
  const record = Object.assign((_: unknown, u: CallUsage | undefined) => void (u && rows.push(u)), {
    warn: (m: string) => void warnings.push(m),
  });
  const emit = extensionHandlers(record);
  // A stopped stream's cost (r0) never lands on the next message (r1).
  emit('provider_stream_event', { data: { id: 'r0', usage: { cost: 0.7 } } });
  emit('message_start', { message: { role: 'assistant' } });
  emit('provider_stream_event', { data: { id: 'r1', usage: { cost: 0.5 } } });
  const first = assistantMsg('r1', 1);
  const out = emit('message_end', { message: first }) as { message: { pa: object } };
  expect(out.message.pa).toEqual({ costUsd: 0.5 });
  // A repeated message_end writes no second row.
  emit('message_end', { message: first });
  expect(rows.map((r) => [r.costUsd, r.estimated])).toEqual([[0.5, false]]);
  // Only the stopped stream's cost: the next message is an estimate.
  emit('turn_start', {});
  emit('provider_stream_event', { data: { id: 'r2', usage: { cost: 0.3 } } });
  emit('message_start', { message: { role: 'assistant' } });
  emit('message_end', { message: assistantMsg('r3', 2) });
  // Above 1000 USD per call: warned, and the estimate is used.
  emit('message_start', { message: { role: 'assistant' } });
  emit('provider_stream_event', { data: { id: 'r4', usage: { cost: 5000 } } });
  emit('message_end', { message: assistantMsg('r4', 3) });
  expect(rows.slice(1).map((r) => [r.costUsd, r.estimated])).toEqual([
    [0.0009, true],
    [0.0009, true],
  ]);
  expect(warnings).toEqual(['usage cost out of range; the estimate is used']);
  expect(
    rawUsage('zdr/task-small', { prompt_tokens: 10, completion_tokens: 1, cost: 1e6 })?.estimated,
  ).toBe(true);
});

test('usageRecorder: a chat deleted meanwhile gives a row without a chat', () => {
  const { db, close } = freshDb();
  usageRecorder(db, 'u1', () => {})(
    { kind: 'chat', chatId: 'gone' },
    messageUsage(assistant(piUsage)),
  );
  expect(
    db
      .select()
      .from(usage)
      .all()
      .map((r) => [r.chatId, r.agentId]),
  ).toEqual([[null, null]]);
  close();
});

test('usage.state: per agent and search count', () => {
  const { db, close } = freshDb();
  const at = usageRecorder(
    db,
    'u1',
    () => {},
    () => new Date('2026-10-15T10:00:00.000Z'),
  );
  const call = (model: string, costUsd: number, estimated = false) => ({
    model,
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd,
    estimated,
  });
  // c1 is a `kirjoittaja` chat; the row takes the chat's agent unless the caller names one.
  at({ kind: 'chat', chatId: 'c1' }, call('zdr/strong', 1));
  at({ kind: 'search', chatId: 'c1', agentId: 'kirjoittaja' }, call('zdr/search', 0.01));
  at({ kind: 'search', chatId: 'c1', agentId: 'kirjoittaja' }, call('zdr/search', 0.01, true));
  at({ kind: 'chat', chatId: null, agentId: 'assistant' }, call('zdr/strong', 2));
  // The consolidation: no chat, no agent.
  at({ kind: 'task', chatId: null }, call('zdr/task-small', 0.5));
  const state = usageMonth(db, 'u1', '2026-10', { get: () => undefined });
  expect(state.searches).toBe(2);
  expect(state.agents).toEqual([
    { agentId: 'assistant', calls: 1, tokens: 15, costUsd: 2, estimated: false },
    { agentId: 'kirjoittaja', calls: 3, tokens: 45, costUsd: 1.02, estimated: true },
    { agentId: null, calls: 1, tokens: 15, costUsd: 0.5, estimated: false },
  ]);
  expect(usageMonth(db, 'u1', '2026-09', { get: () => undefined })).toMatchObject({
    agents: [],
    searches: 0,
  });
  close();
});

test('usageRecorder: a task row of a chat whose agent is gone gets the agent that runs it', () => {
  const { db, close } = freshDb();
  // c1's agent `kirjoittaja` has no profile here: the default agent runs the chat.
  const record = usageRecorder(
    db,
    'u1',
    () => {},
    undefined,
    (id) => (id === 'assistant' ? id : 'assistant'),
  );
  record({ kind: 'task', chatId: 'c1' }, messageUsage(assistant(piUsage)));
  expect(db.select().from(usage).get()?.agentId).toBe('assistant');
  close();
});
