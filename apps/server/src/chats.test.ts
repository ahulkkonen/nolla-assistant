import { join } from 'node:path';
import { chats, files, openDb } from '@pa/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { threadFiles } from './chats.ts';
import { cleanups, runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

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
