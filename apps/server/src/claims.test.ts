import { join } from 'node:path';
import { claims, openDb } from '@pa/db';
import { afterEach, expect, test } from 'vitest';
import { claimStore } from './claims.ts';
import { runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

const store = () => {
  const { db, sqlite } = openDb(join(tempDir('pa-claims-'), 'app.db'));
  return { db, sqlite, store: claimStore({ db, userId: 'aleksi', warn: () => {} }) };
};

test('import turns MEMORY.md lines into active claims, once', { timeout: 60_000 }, async () => {
  const { db, sqlite, store: s } = store();
  const md =
    '## Muisti\n- Käyttäjä juoksee aamuisin.\n- Mikko Virtanen on työkaveri.\n\nKahvi mustana.';
  expect(await s.importMemory(md)).toBe(3);
  expect(await s.importMemory(md)).toBe(0);
  const rows = db.select().from(claims).all();
  expect(rows.map((r) => [r.text, r.status, r.kind, r.activatedBy])).toEqual([
    ['Käyttäjä juoksee aamuisin.', 'active', 'fact', 'user'],
    ['Mikko Virtanen on työkaveri.', 'active', 'fact', 'user'],
    ['Kahvi mustana.', 'active', 'fact', 'user'],
  ]);
  expect(sqlite.prepare('SELECT count(*) AS n FROM claims_fts').get()).toEqual({ n: 3 });
  expect(sqlite.prepare('SELECT count(*) AS n FROM claims_vec').get()).toEqual({ n: 3 });
  sqlite.close();
});
