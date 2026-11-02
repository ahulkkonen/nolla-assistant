import type { ServerMessage } from '@nolla/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { collisionWaits } from './collisions.ts';
import { bootPseudo, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const hit = (pending_id: number, entity_id = 1) => ({ pending_id, entity_id, kind: 'PERSON' });

test('collision waits: held, released, and closing the items of a dropped hold', async () => {
  const sent: [string, ServerMessage][] = [];
  const expired: number[][] = [];
  const w = collisionWaits({
    notify: (chatId, m) => void sent.push([chatId, m]),
    expire: (ids) => void expired.push(ids),
    timeoutMs: 50,
  });
  const both = w.wait('a', [hit(1), hit(2)]);
  const same = w.wait('b', [hit(2)]); // the same item, held by a message in another chat
  expect(sent[0]).toEqual(['a', { type: 'chat.held', chatId: 'a', pendingIds: [1, 2] }]);
  expect(w.held('a') && w.list().length === 2).toBe(true);
  w.answered(2);
  await expect(same).resolves.toBe(true);
  expect(sent.at(-1)).toEqual(['b', { type: 'chat.released', chatId: 'b', outcome: 'resumed' }]);
  w.cancel('a'); // stop: item 1 is closed, item 2 was answered
  await expect(both).resolves.toBe(false);
  expect(sent.at(-1)?.[1]).toMatchObject({ type: 'chat.released', outcome: 'dropped' });
  expect(expired).toEqual([[1, 2]]);
  const merged = w.wait('a', [hit(3, 7)]);
  w.dropEntities([7]);
  await expect(merged).resolves.toBe(false);
  const stale = w.wait('a', [hit(4)]);
  w.drop(4);
  await expect(stale).resolves.toBe(false);
  await expect(w.wait('a', [hit(5)])).resolves.toBe(false); // timeout
  expect(w.held('a')).toBe(false);
  w.orphan(['c']);
  expect(w.list()).toEqual([{ type: 'chat.released', chatId: 'c', outcome: 'dropped' }]);
});

const DICT = { 'Matti Virtanen': 'Pekka Laaksonen', 'Liisa Korhonen': 'Anna Mäkinen' };
/** "Pekka Laaksonen" is the surrogate of Matti Virtanen; here the user means a real Pekka Laaksonen. */
const bootHeld = async (turns = [{ text: 'ok' }]) => {
  const b = await bootPseudo(DICT, turns, { collide: ['Pekka Laaksonen'] });
  const held = async (text: string) => {
    b.c.send({ type: 'user.message', chatId: b.chat.id, text });
    return b.c.next('chat.held');
  };
  return { ...b, held };
};

test('a held message waits in the pending lane, blocks the chat, and runs as a new person', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm, held } = await bootHeld();
  expect(await held('Soita Pekka Laaksonen huomenna')).toEqual({
    type: 'chat.held',
    chatId: chat.id,
    pendingIds: [1],
  });
  const parked = await c.next('vault.state'); // pushed to every screen
  expect(parked.pending).toEqual([
    {
      id: 1,
      kind: 'PERSON',
      text: 'Pekka Laaksonen',
      detector: 'fake',
      score: 1,
      chatId: chat.id,
      reason: 'collision',
      entityId: 1,
    },
  ]);
  // Nothing runs ahead of the held message.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Toinen viesti' });
  await expect(c.next('message.final')).rejects.toThrow('server error: held');
  expect(llm.requests).toHaveLength(0);

  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'accept' });
  expect((await c.next('vault.state')).pending).toEqual([]);
  expect(await c.next('chat.released')).toMatchObject({ outcome: 'resumed' });
  const final = await c.next('message.final');
  await c.idle();
  expect(final.message.text).toBe('ok');
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Soita Uusi');
  expect(body).not.toContain('Pekka Laaksonen');
});

test('user.stop drops a held message and closes its item; a stale answer resumes nothing', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm, sc, held } = await bootHeld();
  await held('Pekka Laaksonen?');
  c.send({ type: 'user.stop', chatId: chat.id });
  expect(await c.next('chat.released')).toMatchObject({ chatId: chat.id, outcome: 'dropped' });
  await vi.waitFor(() =>
    expect(
      sc.requests.some((r) => r.path === '/vault/pending/1' && r.body.action === 'expire'),
    ).toBe(true),
  );
  c.inbox.length = 0;
  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'accept' }); // from a stale screen: 409
  expect((await c.next('vault.state')).pending).toEqual([]);
  await new Promise((r) => setTimeout(r, 300));
  expect(llm.requests).toHaveLength(0);
});

test('merging the entity behind a held message drops it', { timeout: 30_000 }, async () => {
  const { c, chat, held } = await bootHeld([{ text: 'ok' }, { text: 'ok2' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Matti Virtanen ja Liisa Korhonen' });
  await c.idle();
  await held('Pekka Laaksonen?');
  c.send({ type: 'vault.merge', fromIds: [2], intoId: 1 });
  expect(await c.next('chat.released')).toMatchObject({ outcome: 'dropped' });
});
