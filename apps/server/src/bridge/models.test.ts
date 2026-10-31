import { afterEach, expect, test } from 'vitest';
import { boot, connect, runCleanups } from '../test-utils.ts';

afterEach(runCleanups);

const FABLE = 'anthropic/claude-fable-5.1'; // no ZDR endpoint in the fake catalog
const ARGON = 'google/gemini-4-argon';

test('models.list and models.favorite answer models.state to the asking socket', {
  timeout: 30_000,
}, async () => {
  const { config, run } = await boot([]);
  await run();
  const c = await connect(config.port);
  const other = await connect(config.port);
  c.send({ type: 'models.list' });
  const state = await c.next('models.state');
  expect(state).toMatchObject({ auto: ARGON, favorites: [] });
  expect(state.fetchedAt).not.toBeNull();
  expect(state.catalog.map((m) => [m.id, m.zdr])).toEqual([
    [ARGON, true],
    ['anthropic/claude-opus-5.5', true],
    [FABLE, false],
  ]);
  // Phase 21: the Anthropic alias resolves to Fable; Google has no alias, so its newest model.
  expect(state.latest).toEqual([
    { lab: 'anthropic', modelId: FABLE },
    { lab: 'google', modelId: ARGON },
  ]);
  // Only protocol fields go out.
  expect(Object.keys(state.catalog[0] ?? {}).sort()).toEqual(
    ['contextLength', 'id', 'name', 'price', 'reasoning', 'vision', 'zdr'].sort(),
  );
  expect(state.catalog[1]?.reasoning).toMatchObject({ recommended: 'medium' });

  for (const modelId of [FABLE, ARGON]) {
    c.send({ type: 'models.favorite', modelId, favorite: true });
    await c.next('models.state');
  }
  // Shared through the database: another screen reads them at its next `models.list`.
  expect(other.inbox.some((m) => m.type === 'models.state')).toBe(false);
  other.send({ type: 'models.list' });
  expect((await other.next('models.state')).favorites).toEqual([FABLE, ARGON]);
  c.send({ type: 'models.favorite', modelId: FABLE, favorite: false });
  expect((await c.next('models.state')).favorites).toEqual([ARGON]);
  c.send({ type: 'models.favorite', modelId: 'acme/unknown', favorite: true });
  await expect(c.next('models.state')).rejects.toThrow('bad_message');
});
