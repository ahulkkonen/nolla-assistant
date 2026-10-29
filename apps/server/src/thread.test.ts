import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chats, files, openDb } from '@pa/db';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { AttachmentRef, ChatExport } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import { cutText, thinkingOf, threadFiles } from './bridge.ts';
import {
  api,
  bootChat,
  bootPseudo,
  cleanups,
  connect,
  login,
  runCleanups,
  sidecarProxy,
  tempDir,
} from './test-utils.ts';
import { monthOf } from './usage.ts';

// Phase 13 (docs/decisions/phase-13-thread.md): fork, thinking, usage and the rate over the socket.

afterEach(runCleanups);

const REAL = 'Matti Virtanen';
const SURROGATE = 'Pekka Laaksonen';
const cost = (usd: number) => ({ prompt_tokens: 100, completion_tokens: 20, cost: usd });

type Chat = Awaited<ReturnType<typeof bootChat>>;
async function turn(c: Chat['c'], chatId: string, text: string) {
  c.send({ type: 'user.message', chatId, text });
  await c.idle();
}
async function open(c: Chat['c'], chatId: string) {
  c.send({ type: 'chat.open', chatId });
  return c.next('chat.state');
}

test('chat.fork copies the path to the fork point, runs the edited text, leaves the source', async () => {
  const { c, chat, srv, llm } = await bootChat([
    { text: 'Eka vastaus.', usage: cost(0.01) },
    { text: 'Toka vastaus.', usage: cost(0.02) },
    { text: 'Haaran vastaus.', usage: cost(0.03) },
  ]);
  await turn(c, chat.id, 'Ensimmäinen');
  await turn(c, chat.id, 'Toinen');
  c.send({ type: 'chat.setModes', chatId: chat.id, modes: ['confidence'] });
  await c.next('chat.updated');
  const before = await open(c, chat.id);
  const [user1, reply1, user2] = before.messages;
  const sourceFile = (await srv.registry.get(chat.id)).sessionManager.getSessionFile() ?? '';
  const bytes = readFileSync(sourceFile, 'utf8');

  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user2?.id ?? '', text: 'Muokattu' });
  const { chat: fork } = await c.next('chat.created');
  const state = await c.next('chat.state');
  expect(fork.id).not.toBe(chat.id);
  // Phase-23 decision 6: the fork copies the modes.
  expect(fork).toMatchObject({
    title: null,
    modes: ['confidence'],
    usage: { costUsd: 0, tokens: 0 },
  });
  expect(fork.modelPolicy.dataPolicy).toBe('zdr');
  expect(state.forkedFrom).toEqual({
    chatId: chat.id,
    messageId: user2?.id,
    title: null,
    deleted: false,
  });
  // Same entry ids, same texts; the copied reply's cost stays with the source.
  expect(state.messages.map((m) => [m.id, m.text])).toEqual([
    [user1?.id, 'Ensimmäinen'],
    [reply1?.id, 'Eka vastaus.'],
  ]);
  expect(reply1?.usage?.costUsd).toBe(0.01);
  expect(state.messages[1]?.usage).toBeUndefined();
  await c.idle();

  const sent = llm.requests
    .at(-1)
    ?.body.messages.map((m: { role: string; content: unknown }) => [
      m.role,
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    ]);
  // The system prompt goes as `developer` to a reasoning model.
  expect(sent.map(([r]: string[]) => r)).toEqual(['developer', 'user', 'assistant', 'user']);
  expect(sent[1][1]).toContain('Ensimmäinen');
  expect(sent[3][1]).toContain('Muokattu');
  expect(readFileSync(sourceFile, 'utf8')).toBe(bytes);
  const row = srv.db.select().from(chats).where(eq(chats.id, fork.id)).get();
  expect(row).toMatchObject({
    forkedFromChatId: chat.id,
    forkedFromMessageId: user2?.id,
    costUsd: 0.03,
    // Phase 17: the copied history is not mined again.
    claimsThrough: reply1?.id,
  });
  // The source keeps both turns; the fork's own reply has its cost.
  expect((await open(c, chat.id)).messages.map((m) => m.text)).toEqual([
    'Ensimmäinen',
    'Eka vastaus.',
    'Toinen',
    'Toka vastaus.',
  ]);
  const reopened = await open(c, fork.id);
  expect(reopened.messages.map((m) => [m.text, m.usage?.costUsd])).toEqual([
    ['Ensimmäinen', undefined],
    ['Eka vastaus.', undefined],
    ['Muokattu', undefined],
    ['Haaran vastaus.', 0.03],
  ]);
});

test("message.accepted maps a user message's local id to its entry id", async () => {
  const { c, chat } = await bootChat([{ text: 'Vastaus.' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hei', localId: 'local-1' });
  const accepted = await c.next('message.accepted');
  await c.idle();
  expect(accepted).toMatchObject({ chatId: chat.id, localId: 'local-1' });
  const [user] = (await open(c, chat.id)).messages;
  expect(user).toMatchObject({ id: accepted.messageId, text: 'Hei' });
});

test('chat.fork of the first message starts an empty chat; an assistant id is refused', async () => {
  const { c, chat } = await bootChat([{ text: 'Vastaus.' }, { text: 'Uusi alku.' }]);
  await turn(c, chat.id, 'Alku');
  const [user, reply] = (await open(c, chat.id)).messages;
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: reply?.id ?? '', text: 'x' });
  await expect(c.next('chat.created')).rejects.toThrow('bad_message');
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user?.id ?? '', text: 'Toinen alku' });
  await c.next('chat.created');
  expect((await c.next('chat.state')).messages).toEqual([]);
  await c.idle();
});

test('a fork with the sidecar: scope copied up to the fork point, edited text masked once', async () => {
  const { c, chat, llm, sc } = await bootPseudo({ [REAL]: SURROGATE }, [
    { text: `${SURROGATE} on mukana.` },
    { text: 'Selvä.' },
    { text: 'Haara.' },
  ]);
  await turn(c, chat.id, `Kerro ${REAL}`);
  await turn(c, chat.id, 'Toinen');
  const user2 = (await open(c, chat.id)).messages[2];
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user2?.id ?? '', text: `Entä ${REAL}?` });
  const { chat: fork } = await c.next('chat.created');
  const state = await c.next('chat.state');
  // Restored for display, as `chat.open` does.
  expect(state.messages[0]?.text).toBe(`Kerro ${REAL}`);
  await c.idle();
  const call = sc.requests.find((r) => r.path === '/session/fork');
  expect(call?.body).toMatchObject({ from_session_id: chat.id, to_session_id: fork.id });
  expect(call?.body.until).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  const body = JSON.stringify(llm.requests.at(-1)?.body);
  expect(body).not.toContain(REAL);
  expect(body.split(SURROGATE).length - 1).toBe(3); // copied user, copied reply, edited text
  // Deleting the fork drops its copied scope; deleting a chat that is no fork does not ask.
  c.send({ type: 'chat.delete', chatId: fork.id });
  await c.next('chat.deleted');
  c.send({ type: 'chat.delete', chatId: chat.id });
  await c.next('chat.deleted');
  const drops = sc.requests.filter((r) => r.path === '/session/fork/drop');
  expect(drops.map((r) => r.body.session_id)).toEqual([fork.id]);
});

test('thinking: live state, Message.thinking with ms, thinking.get restores the text', async () => {
  const { c, chat, llm } = await bootPseudo({ [REAL]: SURROGATE }, [
    { text: 'Vastaus.', reasoning: `Mietin ${SURROGATE} asiaa.`, thinkMs: 60 },
    // A model that writes a real value into its thinking: /scan masks it before the next request.
    { text: 'Toinen.', reasoning: `Muistan ${REAL}.` },
    { text: 'Kolmas.' },
  ]);
  await turn(c, chat.id, 'Kysymys');
  const live = c.inbox.flatMap((m) => (m.type === 'message.thinking' ? [m.active] : []));
  expect(live).toEqual([true, false]);
  const final = c.inbox.findLast((m) => m.type === 'message.final');
  const message = final?.type === 'message.final' ? final.message : undefined;
  expect(message?.thinking?.ms).toBeGreaterThanOrEqual(50);
  c.send({ type: 'thinking.get', chatId: chat.id, messageId: message?.id ?? '' });
  const t = await c.next('thinking.text');
  expect(t.text).toBe(`Mietin ${REAL} asiaa.`);
  expect(t.annotations).toEqual([expect.objectContaining({ modelSaw: SURROGATE })]);

  await turn(c, chat.id, 'Jatka');
  await turn(c, chat.id, 'Vielä');
  const replay = JSON.stringify(llm.requests.at(-1)?.body);
  expect(replay).toContain(`Muistan ${SURROGATE}.`);
  expect(replay).not.toContain(REAL);
  // A message without thinking text has no thinking row.
  const plain = (await open(c, chat.id)).messages.at(-1);
  expect(plain?.thinking).toBeUndefined();
});

test('message.phase: sent, then headers, before the reply streams under the same id (phase 26)', async () => {
  const { c, chat, srv } = await bootChat([
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }], queueMs: 80 },
    { text: 'Luin sen.', reasoning: 'Mietin.', thinkMs: 30, queueMs: 60 },
  ]);
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hei');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Lue', localId: 'local-1' });
  await c.idle();
  const kinds = new Set([
    'message.accepted',
    'message.phase',
    'message.thinking',
    'message.delta',
    'tool.start',
    'tool.end',
    'message.final',
  ]);
  const seen = c.inbox.filter((m) => kinds.has(m.type));
  const label = (m: (typeof seen)[number]) =>
    m.type === 'message.phase'
      ? m.phase
      : m.type === 'message.thinking'
        ? `thinking ${m.active}`
        : m.type;
  // One request per round: each round's phases come before anything of its message.
  expect(seen.map(label)).toEqual([
    'message.accepted',
    'sent',
    'headers',
    'tool.start',
    'tool.end',
    'message.final',
    'sent',
    'headers',
    'thinking true',
    'thinking false',
    ...seen.filter((m) => m.type === 'message.delta').map(() => 'message.delta'),
    'message.final',
  ]);
  const phases = seen.flatMap((m) => (m.type === 'message.phase' ? [m] : []));
  const [sent1, headers1, sent2, headers2] = phases;
  // Each round has its own stream id; the second round's thinking and text use it.
  expect(headers1?.messageId).toBe(sent1?.messageId);
  expect(headers2?.messageId).toBe(sent2?.messageId);
  expect(sent2?.messageId).not.toBe(sent1?.messageId);
  for (const m of seen)
    if (m.type === 'message.thinking' || m.type === 'message.delta')
      expect(m.messageId).toBe(sent2?.messageId);
  expect((headers1?.at ?? 0) - (sent1?.at ?? 0)).toBeGreaterThanOrEqual(70);
  expect((headers2?.at ?? 0) - (sent2?.at ?? 0)).toBeGreaterThanOrEqual(50);
  // The stored message keeps the same wait (the receipt after a reload) and its writing time.
  const finals = seen.flatMap((m) => (m.type === 'message.final' ? [m.message] : []));
  expect(finals[0]?.phases).toEqual({ queueMs: (headers1?.at ?? 0) - (sent1?.at ?? 0) });
  expect(finals[1]?.phases).toEqual({
    queueMs: (headers2?.at ?? 0) - (sent2?.at ?? 0),
    writeMs: expect.any(Number),
  });
  const stored = (await open(c, chat.id)).messages.filter((m) => m.role === 'assistant');
  expect(stored.map((m) => m.phases)).toEqual(finals.map((m) => m.phases));
});

test('usage.get, the summary totals and fx.state at attach', async () => {
  // 60 of the 100 prompt tokens come from the prompt cache (phase-16 decision 12).
  const cached = { ...cost(0.0123), cached_tokens: 60 };
  const { c, chat } = await bootChat([{ text: 'Vastaus.', usage: cached }]);
  await turn(c, chat.id, 'Kysymys');
  const updated = c.inbox.findLast((m) => m.type === 'chat.updated');
  expect(updated?.type === 'chat.updated' && updated.chat.usage).toEqual({
    costUsd: 0.0123,
    tokens: 120,
    input: 40,
    output: 20,
    cacheRead: 60,
    cacheWrite: 0,
  });
  c.send({ type: 'usage.get', month: monthOf(new Date()) });
  const usage = await c.next('usage.state');
  expect(usage.rows).toEqual([
    {
      model: 'zdr/google/gemini-4-argon',
      name: 'Gemini 4 Argon',
      calls: 1,
      tokens: 120,
      reasoning: 0,
      input: 40,
      output: 20,
      cacheRead: 60,
      cacheWrite: 0,
      costUsd: 0.0123,
      estimated: false,
    },
  ]);
  // The fake LLM serves the ECB CSV; the first socket may attach before the first fetch ends.
  for (;;) {
    const fx = await c.next('fx.state');
    if (fx.rate) {
      expect(fx.rate).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
      break;
    }
  }
});

test('the export carries the chat total, the cost per reply and the rate', async () => {
  const { c, chat, config } = await bootChat([{ text: 'Vastaus.', usage: cost(0.0123) }]);
  await turn(c, chat.id, 'Kysymys');
  while (!(await c.next('fx.state')).rate);
  const { cookie } = await login(config.port);
  const get = async (format: string) =>
    api(config.port, `/api/chats/${chat.id}/export?format=${format}`, { headers: { cookie } });
  const md = await (await get('md')).text();
  const nb = (t: string) => t.replace(/ €/g, '\u00a0€');
  expect(md).toContain(nb('- Kustannus: 0,01 € · 120 tokenia (EKP 23.10.2026)'));
  expect(md).toContain(nb('Kustannus: 0,011 € · 120 tokenia'));
  const json = (await (await get('json')).json()) as ChatExport;
  expect(json.fx).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  expect(json.chat.usage).toEqual({
    costUsd: 0.0123,
    tokens: 120,
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(json.messages[1]?.usage).toMatchObject({ costUsd: 0.0123, estimated: false });
});

/** A fake sidecar behind a proxy that can delay or fail a path. */
async function bootProxied(turns: Parameters<typeof bootChat>[0]) {
  const sc = await startFakeSidecar({ [REAL]: SURROGATE });
  cleanups.push(sc.close);
  const proxy = await sidecarProxy(sc.url);
  return { ...(await bootChat(turns, { PSEUDO_URL: proxy.url })), sc, proxy };
}

test('chat.fork holds the source: a data-policy change during its restore step fails', async () => {
  const { c, chat, proxy } = await bootProxied([
    { text: 'Eka.' },
    { text: 'Toka.' },
    { text: 'Haara.' },
  ]);
  await turn(c, chat.id, 'Yksi');
  await turn(c, chat.id, 'Kaksi');
  const user2 = (await open(c, chat.id)).messages[2];
  proxy.delayMs = 500;
  c.inbox.length = 0;
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user2?.id ?? '', text: 'Muokattu' });
  await sleep(200);
  // A model change may run now (phase-20 decision 15); a policy change still waits.
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: failed');
  proxy.delayMs = 0;
  await c.next('chat.created');
  await c.idle();
});

test('a failed sidecar scope copy leaves no row, no file, and drops the scope', async () => {
  const { c, chat, srv, sc, proxy } = await bootProxied([{ text: 'Eka.' }, { text: 'Toka.' }]);
  await turn(c, chat.id, 'Yksi');
  await turn(c, chat.id, 'Kaksi');
  const user2 = (await open(c, chat.id)).messages[2];
  const sessions = () => readdirSync(srv.registry.sessionDir).filter((f) => f.endsWith('.jsonl'));
  const before = sessions();
  proxy.fail.add('/session/fork');
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user2?.id ?? '', text: 'Muokattu' });
  await expect(c.next('chat.created')).rejects.toThrow('server error: pseudo_down');
  expect(
    srv.db
      .select()
      .from(chats)
      .all()
      .map((r) => r.id),
  ).toEqual([chat.id]);
  expect(sessions()).toEqual(before);
  expect(sc.requests.some((r) => r.path === '/session/fork/drop')).toBe(true);
});

test('a fork point at a user entry without a reply (a stopped run) copies it', async () => {
  const { c, chat, srv, sc } = await bootPseudo({ [REAL]: SURROGATE }, [
    { text: 'Eka.' },
    { text: 'Toka.' },
    { text: 'Haara.' },
  ]);
  await turn(c, chat.id, 'Yksi');
  // A run stopped before its reply: the user entry stays without an assistant entry after it.
  const sm = (await srv.registry.get(chat.id)).sessionManager;
  sm.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Keskeytetty' }],
    timestamp: Date.now(),
  });
  const stopped = sm.getLeafEntry();
  await srv.registry.drop(chat.id);
  await turn(c, chat.id, 'Kolme');
  const messages = (await open(c, chat.id)).messages;
  const last = messages.at(-2);
  expect(last?.text).toBe('Kolme');
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: last?.id ?? '', text: 'Muokattu' });
  await c.next('chat.created');
  const state = await c.next('chat.state');
  expect(state.messages.map((m) => m.text)).toEqual(['Yksi', 'Eka.', 'Keskeytetty']);
  await c.idle();
  const call = sc.requests.find((r) => r.path === '/session/fork');
  expect(call?.body.until).toBe(new Date(stopped?.timestamp ?? 0).toISOString());
});

test('a fork of an open chat runs on zdr/ with the same bare model id', async () => {
  const fable = 'anthropic/claude-fable-5.1';
  const { c, chat, srv, llm } = await bootChat([{ text: 'Eka.' }, { text: 'Haara.' }]);
  await turn(c, chat.id, 'Yksi');
  srv.db
    .update(chats)
    .set({ modelId: fable, dataPolicy: 'open' })
    .where(eq(chats.id, chat.id))
    .run();
  const user1 = (await open(c, chat.id)).messages[0];
  c.send({ type: 'chat.fork', chatId: chat.id, messageId: user1?.id ?? '', text: 'Alusta' });
  const { chat: fork } = await c.next('chat.created');
  await c.idle();
  expect(fork.modelPolicy).toMatchObject({ modelId: fable, dataPolicy: 'zdr' });
  expect(llm.requests.at(-1)?.body.model).toBe(`zdr/${fable}`);
});

test('threadFiles walks the fork chain, each source cut at the edited message', () => {
  const { db, sqlite } = openDb(join(tempDir('pa-thread-'), 'app.db'));
  cleanups.push(() => void sqlite.close());
  const t = (h: number) => `2026-10-26T${String(h).padStart(2, '0')}:00:00.000Z`;
  const chat = (id: string, from: string | null, forkedAt: string | null) =>
    db
      .insert(chats)
      .values({
        id,
        userId: 'u1',
        sessionPath: 's/',
        forkedFromChatId: from,
        forkedAt,
        createdAt: t(0),
        updatedAt: t(0),
      })
      .run();
  const file = (id: string, chatId: string, h: number) =>
    db
      .insert(files)
      .values({
        id,
        userId: 'u1',
        chatId,
        name: `${id}.txt`,
        mime: 'text/plain',
        size: 1,
        path: `files/${id}`,
        createdAt: t(h),
      })
      .run();
  // G ← S (edited a G message of 05:00) ← R (edited an S message of 08:00).
  chat('G', null, null);
  chat('S', 'G', t(5));
  chat('R', 'S', t(8));
  file('g1', 'G', 4);
  file('g2', 'G', 6); // after S's fork point: never on S or R
  file('s1', 'S', 7);
  file('s2', 'S', 9); // after R's fork point
  file('r1', 'R', 10);
  const row = (id: string) => db.select().from(chats).where(eq(chats.id, id)).get();
  const ids = (id: string) => {
    const r = row(id);
    return r ? threadFiles(db, 'u1', r).map((f) => f.id) : [];
  };
  expect(ids('R')).toEqual(['g1', 's1', 'r1']);
  expect(ids('S')).toEqual(['g1', 's1', 's2']);
});

test('thinkingOf trims the joined text: no empty last line (phase-21 decision 6)', () => {
  const m = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '  Mietin.' },
      { type: 'text', text: 'Vastaus.' },
      { type: 'thinking', thinking: 'Vielä.\n' },
    ],
  } as Parameters<typeof thinkingOf>[0];
  expect(thinkingOf(m)).toBe('Mietin.\n\nVielä.');
});

test('cutText cuts at a paragraph or a space, never inside a surrogate pair', () => {
  expect(cutText('lyhyt', 10)).toBe('lyhyt');
  const para = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;
  expect(cutText(para, 40)).toBe(`${'a'.repeat(30)}…`);
  const words = `${'a'.repeat(30)} ${'b'.repeat(30)}`;
  expect(cutText(words, 40)).toBe(`${'a'.repeat(30)}…`);
  const emoji = `${'x'.repeat(3000)}😀😀`;
  const cut = cutText(emoji, 3001);
  expect(cut).toBe(`${'x'.repeat(3000)}…`);
});

// --- message.accepted: one queue per session, matched in store order --------------------------

type Inbox = Chat['c']['inbox'];
/** Waits for an inbox message without throwing on errors (a failed reply is part of the test). */
async function waitFor<T extends Inbox[number]>(inbox: Inbox, pick: (m: Inbox[number]) => m is T) {
  for (let i = 0; i < 500; i++) {
    const m = inbox.find(pick);
    if (m) return m;
    await sleep(20);
  }
  throw new Error('waitFor timed out');
}
const accepted = (inbox: Inbox) =>
  inbox.flatMap((m) => (m.type === 'message.accepted' ? [[m.localId, m.messageId]] : []));
const idleOf = (inbox: Inbox) =>
  waitFor(
    inbox,
    (m): m is Extract<Inbox[number], { type: 'agent.status' }> =>
      m.type === 'agent.status' && m.state === 'idle',
  );
/** Entry id → text of the chat's messages. */
async function texts(c: Chat['c'], chatId: string) {
  return new Map((await open(c, chatId)).messages.map((m) => [m.id, m.text]));
}

test('two quick user.message frames, both still masking: each local id gets its own entry', async () => {
  const { c, chat, proxy } = await bootProxied([{ text: 'Eka.' }]);
  proxy.delayMs = 150;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Yksi', localId: 'l-a' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kaksi', localId: 'l-b' });
  // Pi may take the second as a steer into the same run: one reply, two user entries.
  await idleOf(c.inbox);
  await waitFor(c.inbox, (m): m is Inbox[number] => accepted(c.inbox).length === 2);
  proxy.delayMs = 0;
  const byId = await texts(c, chat.id);
  const got = Object.fromEntries(accepted(c.inbox).map(([l, id]) => [l, byId.get(id ?? '')]));
  expect(got).toEqual({ 'l-a': 'Yksi', 'l-b': 'Kaksi' });
});

test('a steered message (sent while a run streams) still gets its message.accepted', async () => {
  const { c, chat } = await bootChat([
    {
      toolCalls: [{ name: 'read', args: { path: 'puuttuu.txt' } }],
      reasoning: 'Mietin ensin pitkään.',
      thinkMs: 500,
    },
    { text: 'Molemmat.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Ensin', localId: 'l-a' });
  await waitFor(
    c.inbox,
    (m): m is Extract<Inbox[number], { type: 'message.thinking' }> =>
      m.type === 'message.thinking' && m.active,
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Väliin', localId: 'l-b' });
  await idleOf(c.inbox);
  const byId = await texts(c, chat.id);
  const got = Object.fromEntries(accepted(c.inbox).map(([l, id]) => [l, byId.get(id ?? '')]));
  expect(got).toEqual({ 'l-a': 'Ensin', 'l-b': 'Väliin' });
});

test('a prompt the sidecar blocked leaves nothing that could match the next message', async () => {
  const { c, chat, proxy } = await bootProxied([{ text: 'Vastaus.' }]);
  proxy.fail.add('/mask');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Estetty', localId: 'l-x' });
  await waitFor(
    c.inbox,
    (m): m is Extract<Inbox[number], { type: 'error' }> =>
      m.type === 'error' && m.code === 'pseudo_down',
  );
  proxy.fail.delete('/mask');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Vapaa', localId: 'l-y' });
  await idleOf(c.inbox);
  const got = accepted(c.inbox);
  c.inbox.length = 0;
  const byId = await texts(c, chat.id);
  expect(got.map(([l, id]) => [l, byId.get(id ?? '')])).toEqual([['l-y', 'Vapaa']]);
});

test('user.retry with a fresh local id gets the new entry id', async () => {
  const { c, chat } = await bootChat([
    { error: { status: 400, message: 'fake: bad request' } },
    { text: 'Nyt toimii.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Yksi', localId: 'l-a' });
  await idleOf(c.inbox);
  const [first] = accepted(c.inbox);
  c.inbox.length = 0;
  c.send({ type: 'user.retry', chatId: chat.id, localId: 'l-r' });
  await idleOf(c.inbox);
  const [again] = accepted(c.inbox);
  expect(again?.[0]).toBe('l-r');
  expect(again?.[1]).not.toBe(first?.[1]);
  const byId = await texts(c, chat.id);
  expect(byId.get(again?.[1] ?? '')).toBe('Yksi');
  expect(byId.has(first?.[1] ?? '')).toBe(false);
});

// Phase 24 (docs/decisions/phase-24-edit-in-place.md): edit in place and the version switch.

const textsOf = (s: { messages: { text: string }[] }) => s.messages.map((m) => m.text);

test('chat.edit keeps the old version in the same file; chat.version shows it in every tab, also after an eviction', async () => {
  const { c, chat, srv, config, llm } = await bootChat([
    { text: 'Eka vastaus.' },
    { text: 'Toka vastaus.' },
    { text: 'Uusi vastaus.' },
  ]);
  await turn(c, chat.id, 'Ensimmäinen');
  await turn(c, chat.id, 'Toinen');
  const user2 = (await open(c, chat.id)).messages[2];
  const file = (await srv.registry.get(chat.id)).sessionManager.getSessionFile();
  const other = await connect(config.port);
  await open(other, chat.id);

  c.send({
    type: 'chat.edit',
    chatId: chat.id,
    messageId: user2?.id ?? '',
    text: 'Toinen muokattu',
    localId: 'l1',
  });
  const accepted = await c.next('message.accepted');
  await c.idle();
  // The model sees the edited turn only.
  const body = JSON.stringify(llm.requests.at(-1)?.body.messages);
  expect(body).toContain('Toinen muokattu');
  expect(body).not.toContain('Toka vastaus.');
  const edited = await open(c, chat.id);
  expect(edited.messages.map((m) => [m.text, m.versions])).toEqual([
    ['Ensimmäinen', undefined],
    ['Eka vastaus.', undefined],
    ['Toinen muokattu', { index: 2, count: 2 }],
    ['Uusi vastaus.', undefined],
  ]);
  expect(edited.messages[2]?.id).toBe(accepted.messageId);
  // Same session, same file: nothing copied, nothing deleted.
  const sm = (await srv.registry.get(chat.id)).sessionManager;
  expect(sm.getSessionFile()).toBe(file);
  expect(readdirSync(srv.registry.sessionDir).filter((f) => f.includes(chat.id))).toHaveLength(1);

  other.inbox.length = 0;
  c.send({ type: 'chat.version', chatId: chat.id, messageId: accepted.messageId, index: 1 });
  const shown = await c.next('chat.state');
  expect(shown.switched).toBe(true);
  expect(textsOf(shown)).toEqual(['Ensimmäinen', 'Eka vastaus.', 'Toinen', 'Toka vastaus.']);
  expect(shown.messages[2]?.versions).toEqual({ index: 1, count: 2 });
  // Every socket of the room gets the switch.
  const seen = await other.next('chat.state');
  expect([seen.switched, textsOf(seen)]).toEqual([true, textsOf(shown)]);
  // The `pa-leaf` mark keeps the shown branch when the file opens again.
  await srv.registry.evictIdle(-1);
  expect(srv.registry.has(chat.id)).toBe(false);
  expect(textsOf(await open(c, chat.id))).toEqual(textsOf(shown));
  // An index that is no version, and a message without versions, are refused.
  const v1 = shown.messages[2]?.id ?? '';
  c.send({ type: 'chat.version', chatId: chat.id, messageId: v1, index: 3 });
  await expect(c.next('chat.state')).rejects.toThrow('bad_message');
  c.send({
    type: 'chat.version',
    chatId: chat.id,
    messageId: shown.messages[0]?.id ?? '',
    index: 1,
  });
  await expect(c.next('chat.state')).rejects.toThrow('bad_message');
  c.send({ type: 'chat.version', chatId: chat.id, messageId: v1, index: 2 });
  expect(textsOf(await c.next('chat.state'))).toEqual(textsOf(edited));
});

test('chat.edit carries the original images and document blocks, masked once', {
  timeout: 40_000,
}, async () => {
  const { c, chat, llm, config } = await bootPseudo({ [REAL]: SURROGATE }, [
    { text: 'Näen kuvan.' },
    { text: 'Näen sen taas.' },
  ]);
  const { cookie } = await login(config.port);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'dot.png');
  form.append('files', new Blob([`muistio ${REAL}`], { type: 'text/plain' }), 'note.txt');
  const up = await api(config.port, '/api/files', {
    method: 'POST',
    body: form,
    headers: { cookie },
  });
  const { files: refs } = (await up.json()) as { files: AttachmentRef[] };
  c.send({ type: 'user.message', chatId: chat.id, text: `Katso ${REAL}`, attachments: refs });
  await c.idle();
  const [user] = (await open(c, chat.id)).messages;
  c.send({
    type: 'chat.edit',
    chatId: chat.id,
    messageId: user?.id ?? '',
    text: `Katso tarkemmin ${REAL}`,
  });
  await c.idle();
  const messages = llm.requests.at(-1)?.body.messages as { role: string; content: unknown }[];
  const sent = JSON.stringify(messages);
  expect(sent).not.toContain(REAL);
  expect(sent).not.toContain('Näen kuvan.');
  expect(sent).toContain('[Liite: note.txt]\\nmuistio Pekka Laaksonen');
  const edited = messages.filter((m) => JSON.stringify(m).includes(`Katso tarkemmin ${SURROGATE}`));
  expect(edited).toHaveLength(1);
  expect(JSON.stringify(edited[0])).toContain('image_url');
  const state = await open(c, chat.id);
  expect(state.messages.map((m) => [m.text, m.attachments.map((a) => a.name), m.versions])).toEqual(
    [
      [`Katso tarkemmin ${REAL}`, ['dot.png', 'note.txt'], { index: 2, count: 2 }],
      ['Näen sen taas.', [], undefined],
    ],
  );
});

test('chat.edit and chat.version answer failed during a run and held while a message is held', {
  timeout: 40_000,
}, async () => {
  const { c, chat } = await bootPseudo(
    { [REAL]: SURROGATE },
    [
      { text: 'Eka.' },
      { text: 'Hidas.', reasoning: 'mietin pitkään nyt', thinkMs: 400 },
      { text: 'ok' },
    ],
    { collide: [SURROGATE] },
  );
  await turn(c, chat.id, 'Yksi');
  const [user] = (await open(c, chat.id)).messages;
  const id = user?.id ?? '';
  const refuse = async (code: string) => {
    c.send({ type: 'chat.edit', chatId: chat.id, messageId: id, text: 'Muokattu' });
    await expect(c.next('message.accepted')).rejects.toThrow(`server error: ${code}`);
    c.send({ type: 'chat.version', chatId: chat.id, messageId: id, index: 1 });
    await expect(c.next('chat.state')).rejects.toThrow(`server error: ${code}`);
  };
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kaksi' });
  await c.next('message.thinking');
  await refuse('failed');
  await c.idle();
  c.send({ type: 'user.message', chatId: chat.id, text: `Soita ${SURROGATE}` });
  await c.next('chat.held');
  await refuse('held');
});

test('chat.edit: a mask failure after the check puts the old leaf back (pseudo_down, no call)', {
  timeout: 40_000,
}, async () => {
  const sc = await startFakeSidecar({});
  cleanups.push(sc.close);
  const proxy = await sidecarProxy(sc.url);
  const { c, chat, llm, srv } = await bootChat([{ text: 'Eka.' }, { text: 'Toka.' }], {
    PSEUDO_URL: proxy.url,
  });
  await turn(c, chat.id, 'Yksi');
  await turn(c, chat.id, 'Kaksi');
  const before = await open(c, chat.id);
  // /unmask (the restore) answers, /mask (the input hook) does not.
  proxy.fail.add('/mask');
  c.send({
    type: 'chat.edit',
    chatId: chat.id,
    messageId: before.messages[2]?.id ?? '',
    text: 'X',
  });
  await expect(c.next('message.accepted')).rejects.toThrow('pseudo_down');
  await sleep(100);
  expect(llm.requests).toHaveLength(2);
  expect((await open(c, chat.id)).messages).toEqual(before.messages);
  await srv.registry.evictIdle(-1);
  expect(textsOf(await open(c, chat.id))).toEqual(textsOf(before));
});
