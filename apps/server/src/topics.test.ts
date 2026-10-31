import { setTimeout as sleep } from 'node:timers/promises';
import { chats, tags, topicProposals, topics } from '@pa/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { boot, bootPseudo, connect, KEY, runCleanups } from './test-utils.ts';
import { nearDuplicate, PROPOSAL_DUPLICATE_MIN } from './topics.ts';

afterEach(runCleanups);

const reply = (o: object) => ({ text: JSON.stringify(o) });
/** Debounce (2 s) plus slack: long enough for a title job to have started. */
const settle = () => sleep(2500);

test('title: masked to the model and in the db, restored on the wire; rename locks it', {
  timeout: 60_000,
}, async () => {
  const { llm, srv, c, chat } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { text: 'Hei Pekka Laaksonen!' },
    reply({
      title: 'Pekka Laaksonen ja verotus',
      topics: ['nope', 't-tax', 't-home'],
      proposed_topic: null,
      summary: 'Pekka Laaksonen kysyi verotuksesta.',
    }),
    { text: 'Selvä.' },
    { text: 'Ok.' },
  ]);
  const createdAt = new Date().toISOString();
  srv.db
    .insert(topics)
    .values([
      { id: 't-tax', userId: 'aleksi', name: 'Verot', createdAt },
      { id: 't-home', userId: 'aleksi', name: 'Koti', createdAt },
      // A name the user typed, with a vault entity: masked before the model (invariant 1).
      { id: 't-person', userId: 'aleksi', name: 'Matti Virtanen – asiat', createdAt },
    ])
    .run();
  const row = () => srv.db.select().from(chats).where(eq(chats.id, chat.id)).get();

  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi Matti Virtanen, verotus?' });
  await c.idle();
  const t0 = Date.now();
  expect(await c.next('chat.titled')).toEqual({
    type: 'chat.titled',
    chatId: chat.id,
    title: 'Matti Virtanen ja verotus',
    topicId: 't-tax',
  });
  expect(Date.now() - t0).toBeLessThan(5000);

  const req = llm.requests[1];
  expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(req?.body).toMatchObject({
    model: 'zdr/task-small',
    stream: false,
    response_format: { type: 'json_object' },
  });
  expect(req?.body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  const sent = JSON.stringify(req?.body);
  expect(sent).toContain('Pekka Laaksonen');
  expect(sent).toContain('Verot');
  expect(sent).toContain('Pekka Laaksonen – asiat');
  expect(sent).not.toContain('Matti Virtanen');

  expect(row()).toMatchObject({
    title: 'Matti Virtanen ja verotus',
    titleMasked: 'Pekka Laaksonen ja verotus',
    summary: 'Pekka Laaksonen kysyi verotuksesta.',
    topicId: 't-tax',
  });
  // Unknown id dropped; the second known topic becomes a tag.
  expect(srv.db.select({ tag: tags.tag }).from(tags).all()).toEqual([{ tag: 'topic:t-home' }]);
  c.send({ type: 'chat.list' });
  expect((await c.next('chat.list')).chats[0]?.title).toBe('Matti Virtanen ja verotus');

  // A short second turn adds far less than ~3K tokens: no new title call.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kiitos' });
  await c.idle();
  await settle();
  expect(llm.requests).toHaveLength(3);

  // Rename locks the title; a later long turn (> ~3K tokens) does not retitle
  // (the job still runs for the summary: the fifth request).
  c.inbox.length = 0;
  c.send({ type: 'chat.rename', chatId: chat.id, title: 'Matti Virtanen muistio' });
  expect((await c.next('chat.updated')).chat.title).toBe('Matti Virtanen muistio');
  c.send({ type: 'user.message', chatId: chat.id, text: 'x'.repeat(13_000) });
  await c.idle();
  await settle();
  expect(llm.requests).toHaveLength(5);
  expect(row()).toMatchObject({
    title: 'Matti Virtanen muistio',
    titleMasked: 'Pekka Laaksonen muistio',
    titleLocked: true,
  });
});

test('topics: invalid JSON is retried; proposal lands in the inbox; accept and reject', {
  timeout: 60_000,
}, async () => {
  const why = 'Vapaa-ajan aiheet.';
  const { llm, config, run } = await boot([
    { text: 'Vastaus.' },
    { text: 'ei jsonia' },
    reply({
      title: 'Uuden harrastuksen aloitus',
      topics: [],
      proposed_topic: { name: 'Harrastukset', why },
      summary: 'Käyttäjä aloittaa harrastuksen.',
    }),
  ]);
  const srv = await run();
  const c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Haluan aloittaa kiipeilyn.' });
  await c.idle();

  expect((await c.next('chat.titled')).title).toBe('Uuden harrastuksen aloitus');
  expect(llm.requests).toHaveLength(3);
  const retry = llm.requests[2]?.body.messages as { role: string; content: string }[];
  expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(retry[2]?.content).toBe('ei jsonia');

  const proposal = {
    id: expect.any(Number),
    name: 'Harrastukset',
    why,
    chatId: chat.id,
    chatTitle: 'Uuden harrastuksen aloitus',
  };
  expect((await c.next('topic.state')).proposals).toEqual([proposal]);
  c.send({ type: 'topic.list' });
  const listed = await c.next('topic.state');
  expect(listed).toEqual({ type: 'topic.state', topics: [], proposals: [proposal] });

  const other = srv.db
    .insert(topicProposals)
    .values({ userId: 'aleksi', chatId: chat.id, name: 'Muut', why: '-', createdAt: '' })
    .returning()
    .get();
  c.send({ type: 'topic.reject', proposalId: other.id });
  expect((await c.next('topic.state')).proposals).toEqual([proposal]);

  c.inbox.length = 0;
  c.send({ type: 'topic.accept', proposalId: listed.proposals[0]?.id ?? 0, name: 'Harrastus' });
  const { chat: updated } = await c.next('chat.updated');
  const state = await c.next('topic.state');
  expect(updated.topicId).toEqual(expect.any(String));
  expect(state.topics).toEqual([
    { id: updated.topicId, name: 'Harrastus', description: why, count: 1 },
  ]);
  expect(state.proposals).toEqual([]);
});

test('phase-22 decision 4: a proposal at the cosine threshold of a known name is a duplicate', () => {
  const unit = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return new Float32Array([Math.cos(r), Math.sin(r), 0]);
  };
  const at = (Math.acos(PROPOSAL_DUPLICATE_MIN) * 180) / Math.PI;
  expect(nearDuplicate(unit(0), [unit(90), unit(at - 1)])).toBe(true);
  expect(nearDuplicate(unit(0), [unit(90), unit(at + 1)])).toBe(false);
  expect(nearDuplicate(unit(0), [])).toBe(false);
});
