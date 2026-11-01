import { afterEach, expect, test } from 'vitest';
import { boot, bootPseudo, connect, runCleanups } from '../test-utils.ts';

afterEach(runCleanups);

test('vault: list, merge, pin and pending resolve answer with vault.state', {
  timeout: 30_000,
}, async () => {
  const { c, chat } = await bootPseudo(
    { 'Matti Virtanen': 'Pekka Laaksonen', 'Liisa Korhonen': 'Anna Mäkinen' },
    [{ text: 'ok' }],
    { pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.4 }] },
  );
  c.send({
    type: 'user.message',
    chatId: chat.id,
    text: 'Matti Virtanen, Matti Virtanen ja Liisa Korhonen',
  });
  await c.idle();

  c.send({ type: 'vault.list' });
  let state = await c.next('vault.state');
  expect(state.entities.map((e) => [e.canonical, e.surrogate, e.seenCount])).toEqual([
    ['Matti Virtanen', 'Pekka Laaksonen', 2],
    ['Liisa Korhonen', 'Anna Mäkinen', 1],
  ]);
  expect(state.entities[0]?.lastSeen).toMatch(/Z$/);
  expect(state.pending).toEqual([
    {
      id: 1,
      kind: 'PERSON',
      text: 'Koski',
      detector: 'gliner',
      score: 0.4,
      chatId: '',
      reason: 'uncertain',
      entityId: null,
    },
  ]);
  const [matti, liisa] = state.entities.map((e) => e.id) as [number, number];

  c.send({ type: 'vault.merge', fromIds: [liisa], intoId: matti });
  state = await c.next('vault.state');
  expect(state.entities.map((e) => [e.id, e.seenCount])).toEqual([[matti, 3]]);

  c.send({ type: 'vault.pin', entityId: matti, pinned: true });
  state = await c.next('vault.state');
  expect(state.entities[0]?.pinned).toBe(true);

  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'confirm' });
  state = await c.next('vault.state');
  expect(state.pending).toEqual([]);
  expect(state.entities.map((e) => e.canonical)).toEqual(['Matti Virtanen', 'Koski']);
});

test('vault: without PSEUDO_URL replies not_implemented', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  const c = await connect(config.port);
  c.send({ type: 'vault.list' });
  await expect(c.next('vault.state')).rejects.toThrow('not_implemented');
});

test('vault.add: seeds the entity, answers vault.state, the next message masks it', {
  timeout: 30_000,
}, async () => {
  const { c, chat, sc, llm } = await bootPseudo({}, [{ text: 'ok' }]);
  c.send({ type: 'vault.add', kind: 'PERSON', text: '  Late ' });
  const state = await c.next('vault.state');
  expect(state.entities.map((e) => [e.kind, e.canonical])).toEqual([['PERSON', 'Late']]);
  expect(sc.requests.find((r) => r.path === '/vault/seed')?.body.entities).toEqual([
    { kind: 'PERSON', canonical: 'Late' },
  ]);

  c.send({ type: 'user.message', chatId: chat.id, text: 'Late tulee huomenna' });
  await c.idle();
  const body = JSON.stringify(llm.requests.at(-1)?.body);
  expect(body).not.toContain('Late');
  expect(body).toContain(state.entities[0]?.surrogate);
});

test('vault.add: a value the sidecar refuses answers invalid', { timeout: 30_000 }, async () => {
  const { c } = await bootPseudo({}, []);
  c.send({ type: 'vault.add', kind: 'PERSON', text: 'late' });
  await expect(c.next('vault.state')).rejects.toThrow('invalid');
});
