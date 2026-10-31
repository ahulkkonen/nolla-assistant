import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

test('chat.delete while a reply streams and a subagent runs leaves nothing behind', {
  timeout: 60_000,
}, async () => {
  const { c, chat, srv, logs } = await bootChat([
    {
      text: 'Kysyn apulaiselta.',
      toolCalls: [
        {
          name: 'subagent',
          args: { mode: 'single', tasks: [{ label: 'a', task: 'hidas tehtävä' }] },
        },
      ],
    },
    // The child waits, so the delete lands while it runs.
    { text: 'child result', queueMs: 3000, match: 'hidas tehtävä' },
    { text: 'Valmis.' },
  ]);
  const rejections: unknown[] = [];
  const onRejection = (err: unknown) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Tutki' });
  while (!(await c.next('subagent.state')).children.some((ch) => ch.status === 'running'));
  const children = () =>
    execFileSync('ps', ['-A', '-o', 'ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.trim().startsWith(`${process.pid} `) && l.includes('--mode rpc'));
  expect(children()).toHaveLength(1);
  c.send({ type: 'chat.delete', chatId: chat.id });
  await c.next('chat.deleted');
  // The delete waits for the child to exit (Pi's abort waits for the subagent tool, which ends on
  // the child's "close"), so no child can write JSONL after the folder is gone.
  expect(children()).toEqual([]);
  // Past the child's reply and the settle that reindexes the chat.
  await new Promise((r) => setTimeout(r, 5000));
  process.off('unhandledRejection', onRejection);

  const sqlite = srv.db.$client;
  const count = (sql: string) => (sqlite.prepare(sql).get(chat.id) as { n: number }).n;
  expect(srv.db.select({ id: chats.id }).from(chats).all()).toEqual([]);
  expect(count('SELECT count(*) n FROM chunks WHERE chatId = ?')).toBe(0);
  expect(count('SELECT count(*) n FROM chat_fts WHERE chat_id = ?')).toBe(0);
  expect(sqlite.prepare('SELECT count(*) n FROM chunk_vec').get()).toEqual({ n: 0 });
  expect(readdirSync(srv.registry.sessionDir).filter((f) => f.includes(chat.id))).toEqual([]);
  expect(rejections).toEqual([]);
  expect(logs.filter((l) => /"level":50/.test(l))).toEqual([]);
});
