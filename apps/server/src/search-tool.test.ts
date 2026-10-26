import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { usage } from '@pa/db';
import { type FakeCitation, startFakeLlm } from '@pa/fake-llm';
import { SEARCH_ENTITY_REASON } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import {
  citations,
  SEARCH_DENIED,
  SEARCH_FAILED,
  SEARCH_LIMITED,
  SEARCH_MODEL,
  SEARCH_SYSTEM,
  SEARCH_UNATTENDED,
  type Searcher,
  searcher,
  webSearchExtensions,
} from './search-tool.ts';
import { bootChat, bootPseudo, cleanups, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const CITES: FakeCitation[] = [
  { url: 'https://saa.example/hki', title: 'Sää  Helsinki', content: 'Pilvistä,\n7 astetta.' },
  { url: 'https://uutiset.example/a', title: 'Uutinen', content: 'Ote uutisesta.' },
];
const searchCalls = (llm: { requests: { body: any }[] }) =>
  llm.requests.filter((r) => r.body.model === SEARCH_MODEL);
const lastBody = (llm: { requests: { body: unknown }[] }) =>
  JSON.stringify(llm.requests.at(-1)?.body);

test('web_search: one zdr/search call, citations to the model, a search row and a usage row', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm, srv } = await bootChat([
    { toolCalls: [{ name: 'web_search', args: { query: 'Helsingin  sää\ntänään' } }] },
    { citations: CITES, usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.0079 } },
    { text: 'Pilvistä (https://saa.example/hki).' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Millainen sää Helsingissä on?' });
  const end = await c.next('tool.end');
  expect(end.status).toBe('ok');
  const search = {
    query: 'Helsingin sää tänään',
    results: [
      { title: 'Sää Helsinki', url: 'https://saa.example/hki' },
      { title: 'Uutinen', url: 'https://uutiset.example/a' },
    ],
  };
  expect(end.search).toEqual(search);
  await c.idle();
  expect(c.inbox.some((m) => m.type === 'approval.request')).toBe(false);

  const [call] = searchCalls(llm);
  expect(call?.body).toMatchObject({
    model: 'zdr/search',
    stream: false,
    messages: [
      { role: 'system', content: SEARCH_SYSTEM },
      { role: 'user', content: 'Helsingin sää tänään' },
    ],
  });
  // The plugin is fixed in the LiteLLM deployment; the server never sends routing fields.
  for (const k of ['plugins', 'extra_body', 'provider', 'web_search_options', 'tools'])
    expect(call?.body).not.toHaveProperty(k);
  expect(searchCalls(llm)).toHaveLength(1);
  // The model reads numbered results with their snippets.
  expect(lastBody(llm)).toContain(
    '[1] Sää Helsinki\\nhttps://saa.example/hki\\nPilvistä, 7 astetta.',
  );
  expect(lastBody(llm)).toContain('[2] Uutinen');

  const rows = srv.db.select().from(usage).where(eq(usage.kind, 'search')).all();
  expect(rows).toMatchObject([
    { chatId: chat.id, agentId: 'assistant', model: 'zdr/search', costUsd: 0.0079 },
  ]);

  c.send({ type: 'chat.open', chatId: chat.id });
  const { messages } = await c.next('chat.state');
  expect(messages.flatMap((m) => m.tools)).toEqual([
    expect.objectContaining({ name: 'web_search', status: 'ok', search }),
  ]);
});

test('maxResults cuts the list; no citations is "Ei tuloksia."', { timeout: 30_000 }, async () => {
  const { c, chat, llm } = await bootChat([
    { toolCalls: [{ name: 'web_search', args: { query: 'a', maxResults: 1 } }] },
    { citations: CITES },
    { toolCalls: [{ name: 'web_search', args: { query: 'b' } }] },
    { citations: [] },
    { text: 'Valmis.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hae' });
  expect((await c.next('tool.end')).search?.results).toHaveLength(1);
  expect((await c.next('tool.end')).search).toEqual({ query: 'b', results: [] });
  await c.idle();
  expect(lastBody(llm)).toContain('Ei tuloksia.');
});

test('a query with a vault entity asks; approve runs the real query', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { toolCalls: [{ name: 'web_search', args: { query: 'Pekka Laaksonen hallitus' } }] },
    {
      citations: [
        { url: 'https://valtioneuvosto.example/mv', title: 'Matti Virtanen – ministeri' },
      ],
    },
    { text: 'Löytyi.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hae Matti Virtanen' });
  const req = await c.next('approval.request');
  expect(req).toMatchObject({
    chatId: chat.id,
    tool: 'web_search',
    reason: SEARCH_ENTITY_REASON,
    args: { query: 'Matti Virtanen hallitus' },
  });
  expect(searchCalls(llm)).toHaveLength(0);
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  const end = await c.next('tool.end');
  expect(end.status).toBe('ok');
  // The row shows real values; the model saw the result masked.
  expect(end.search).toEqual({
    query: 'Matti Virtanen hallitus',
    results: [{ title: 'Matti Virtanen – ministeri', url: 'https://valtioneuvosto.example/mv' }],
  });
  await c.idle();
  expect(searchCalls(llm)[0]?.body.messages[1].content).toBe('Matti Virtanen hallitus');
  expect(lastBody(llm)).toContain('Pekka Laaksonen – ministeri');
  expect(lastBody(llm)).not.toContain('Matti Virtanen');
});

test('deny: no search, the model is told to search without the person', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { toolCalls: [{ name: 'web_search', args: { query: 'Pekka Laaksonen' } }] },
    { text: 'Selvä.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hae Matti Virtanen' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: false });
  const end = await c.next('tool.end');
  expect(end.status).toBe('denied');
  expect(end.search).toBeUndefined();
  await c.idle();
  expect(searchCalls(llm)).toHaveLength(0);
  expect(lastBody(llm)).toContain(SEARCH_DENIED);
});

test('a query without entities runs without asking under pseudonymization', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { toolCalls: [{ name: 'web_search', args: { query: 'pörssisähkön hinta' } }] },
    { citations: CITES },
    { text: 'Hinta löytyi.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Paljonko sähkö maksaa?' });
  expect((await c.next('tool.end')).status).toBe('ok');
  await c.idle();
  expect(c.inbox.some((m) => m.type === 'approval.request')).toBe(false);
  expect(searchCalls(llm)).toHaveLength(1);
});

/** The guard's `tool_call` handlers without a session: `tool` records, pseudo restores, `guard` decides. */
function harness(unattended?: Map<string, string[]>, search: Searcher = async () => []) {
  const handlers: ((e: any, ctx: any) => unknown)[] = [];
  let registered: any;
  const pi = {
    on: (_: string, h: never) => handlers.push(h),
    registerTool: (t: unknown) => void (registered = t),
  };
  const ask = vi.fn(async () => true);
  const [tool, guard] = webSearchExtensions({
    chatId: 'c1',
    agentId: 'assistant',
    search,
    ask: Object.assign(ask, unattended ? { unattended } : {}),
  });
  for (const f of [tool, guard]) (f as ExtensionFactory)(pi as never);
  const call = async (masked: string, real: string) => {
    const event = { toolName: 'web_search', toolCallId: 't1', input: { query: masked } };
    await handlers[0]?.(event, {});
    event.input.query = real; // what pseudoExtension does in between
    return handlers[1]?.(event, {});
  };
  const execute = (query: string) => registered.execute('t1', { query }, undefined);
  return { ask, call, execute };
}

test('automations never get the bypass: an entity query is denied without asking', async () => {
  const { ask, call } = harness(new Map([['c1', ['web_search']]]));
  expect(await call('Pekka Laaksonen', 'Matti Virtanen')).toEqual({
    block: true,
    reason: SEARCH_UNATTENDED,
  });
  expect(ask).not.toHaveBeenCalled();
  expect(await call('sää', 'sää')).toBeUndefined();
});

test('the guard asks with the real query and passes on approve', async () => {
  const { ask, call } = harness();
  expect(await call('Pekka Laaksonen', 'Matti Virtanen')).toBeUndefined();
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: 'c1',
      callId: 't1',
      tool: 'web_search',
      args: { query: 'Matti Virtanen' },
      reason: SEARCH_ENTITY_REASON,
    }),
    expect.any(AbortSignal),
  );
});

test('citations: http(s) only, one per URL, whitespace collapsed, snippet capped', () => {
  const ann = (url_citation: object) => ({ type: 'url_citation', url_citation });
  const body = {
    choices: [
      {
        message: {
          annotations: [
            ann({ url: 'javascript:alert(1)', title: 'x' }),
            ann({ url: 'https://a.example', title: ' A\n\nB ', content: 'x'.repeat(700) }),
            ann({ url: 'https://a.example', title: 'dup' }),
            ann({ url: 'http://b.example', title: '' }),
            { type: 'file_citation' },
          ],
        },
      },
    ],
  };
  const out = citations(body);
  expect(out.map((c) => [c.url, c.title])).toEqual([
    ['https://a.example', 'A B'],
    ['http://b.example', 'http://b.example'],
  ]);
  expect(out[0]?.snippet).toHaveLength(600);
  expect(citations({})).toEqual([]);
});

test('execute: a failed call and the rate limit are tool errors the model reads', async () => {
  const failing = harness(undefined, async () => {
    throw new Error('search call status 502');
  });
  expect(await failing.execute('a')).toMatchObject({
    content: [{ type: 'text', text: SEARCH_FAILED }],
    isError: true,
  });
  const limited = harness(undefined, async () => 'limited');
  expect(await limited.execute('a')).toMatchObject({
    content: [{ type: 'text', text: SEARCH_LIMITED }],
    isError: true,
  });
});

test('searcher: rate limit per chat per minute, and a failed call throws', async () => {
  const llm = await startFakeLlm();
  cleanups.push(llm.close);
  let t = 0;
  const run = searcher({ litellmUrl: llm.url, litellmKey: 'k', perMinute: 2, now: () => t });
  // No citations turn queued: the fake answers with its default citations.
  expect((await run('c1', 'a', 'q1')) as unknown[]).toHaveLength(2);
  await run('c1', 'a', 'q2');
  expect(await run('c1', 'a', 'q3')).toBe('limited');
  expect(await run('c2', 'a', 'q1')).not.toBe('limited');
  t = 60_001;
  expect(await run('c1', 'a', 'q4')).not.toBe('limited');
  expect(SEARCH_LIMITED).toContain('5 hakua minuutissa');
  // Nothing listens on port 9: the call fails before any status.
  await expect(
    searcher({ litellmUrl: 'http://127.0.0.1:9', litellmKey: 'k' })('c1', 'a', 'q'),
  ).rejects.toThrow();
});
