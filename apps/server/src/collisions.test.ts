import { afterEach, expect, test, vi } from 'vitest';
import { collisionWaits } from './collisions.ts';
import { bootPseudo, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

test('collision waits: answered when every id is, false on cancel or timeout', async () => {
  const w = collisionWaits(50);
  const both = w.wait('a', [1, 2]);
  const same = w.wait('b', [2]); // the same item held by a message in another chat
  w.answered(2);
  await expect(same).resolves.toBe(true);
  w.answered(1);
  await expect(both).resolves.toBe(true);
  const stopped = w.wait('a', [3]);
  w.cancel('a');
  await expect(stopped).resolves.toBe(false);
  await expect(w.wait('a', [4])).resolves.toBe(false); // timeout
});

test('a message naming an issued surrogate waits in the pending lane, then runs as a new person', {
  timeout: 30_000,
}, async () => {
  // "Pekka Laaksonen" is the surrogate of Matti Virtanen; here the user means a real Pekka Laaksonen.
  const { c, chat, llm } = await bootPseudo(
    { 'Matti Virtanen': 'Pekka Laaksonen' },
    [{ text: 'ok' }],
    {
      collide: ['Pekka Laaksonen'],
    },
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Soita Pekka Laaksonen huomenna' });
  await vi.waitFor(() =>
    expect(c.inbox).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'pseudo_collision', chatId: chat.id }),
    ),
  );
  c.inbox.splice(
    c.inbox.findIndex((m) => m.type === 'error'),
    1,
  );
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
  expect(llm.requests).toHaveLength(0); // fails closed until answered

  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'accept' });
  expect((await c.next('vault.state')).pending).toEqual([]);
  const final = await c.next('message.final');
  await c.idle();
  expect(final.message.text).toBe('ok');
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Soita Uusi');
  expect(body).not.toContain('Pekka Laaksonen');
});

test('user.stop drops a message held by a collision', { timeout: 30_000 }, async () => {
  const { c, chat, llm, sc } = await bootPseudo(
    { 'Matti Virtanen': 'Pekka Laaksonen' },
    [{ text: 'ok' }],
    {
      collide: ['Pekka Laaksonen'],
    },
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Pekka Laaksonen?' });
  await vi.waitFor(() => expect(sc.requests.some((r) => r.body.user_input)).toBe(true));
  await vi.waitFor(() =>
    expect(c.inbox).toContainEqual(expect.objectContaining({ code: 'pseudo_collision' })),
  );
  c.send({ type: 'user.stop', chatId: chat.id });
  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'accept' });
  await vi.waitFor(() =>
    expect(c.inbox.filter((m) => m.type === 'vault.state').at(-1)).toMatchObject({ pending: [] }),
  );
  await new Promise((r) => setTimeout(r, 300));
  expect(llm.requests).toHaveLength(0);
});
