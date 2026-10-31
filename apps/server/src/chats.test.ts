import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, files, openDb } from '@pa/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { threadFiles } from './chats.ts';
import { bootChat, cleanups, connect, runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

const HTML = '```html\n<h1>Laskuri</h1>\n```';

test('titleLocked on the wire; artifacts after the final and in chat.state', {
  timeout: 30_000,
}, async () => {
  const { c, chat, config } = await bootChat([{ text: `Tässä:\n\n${HTML}` }]);
  expect(chat.titleLocked).toBe(false);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Tee laskuri' });
  const final = await c.next('message.final');
  const up = await c.next('artifact.upsert');
  expect(up.artifact).toMatchObject({
    kind: 'html',
    title: 'Laskuri',
    content: '<h1>Laskuri</h1>',
  });
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.rename', chatId: chat.id, title: 'Oma' });
  expect((await c.next('chat.updated')).chat.titleLocked).toBe(true);

  const c2 = await connect(config.port);
  c2.send({ type: 'chat.open', chatId: chat.id });
  const state = await c2.next('chat.state');
  expect(state.chat.titleLocked).toBe(true);
  expect(state.artifacts).toEqual([up.artifact]);
  expect(state.messages.at(-1)?.id).toBe(final.message.id);
  c2.send({ type: 'chat.list' });
  expect((await c2.next('chat.list')).chats[0]?.titleLocked).toBe(true);
});

test('chat.delete removes only its own row, files, and session; all sockets hear it', {
  timeout: 30_000,
}, async () => {
  const { c, chat, config, srv } = await bootChat([{ text: 'Moi' }, { text: 'Toinen' }]);
  c.send({ type: 'chat.create' });
  const { chat: keep } = await c.next('chat.created');
  for (const id of [chat.id, keep.id]) {
    c.send({ type: 'user.message', chatId: id, text: 'Hei' });
    await c.idle();
  }
  mkdirSync(join(config.dataDir, 'files', 'aleksi'), { recursive: true });
  const addFile = (id: string, chatId: string) => {
    const path = join('files', 'aleksi', id);
    writeFileSync(join(config.dataDir, path), 'x');
    srv.db
      .insert(files)
      .values({
        id,
        userId: 'aleksi',
        chatId,
        name: 'a.txt',
        mime: 'text/plain',
        size: 1,
        path,
        createdAt: new Date().toISOString(),
      })
      .run();
    return join(config.dataDir, path);
  };
  const gone = addFile('f1', chat.id);
  const kept = addFile('f2', keep.id);
  const sessionFiles = (id: string) =>
    readdirSync(srv.registry.sessionDir).filter((f) => f.includes(id));
  expect(sessionFiles(chat.id)).toHaveLength(1);

  const other = await connect(config.port);
  c.send({ type: 'chat.delete', chatId: chat.id });
  expect(await c.next('chat.deleted')).toEqual({ type: 'chat.deleted', chatId: chat.id });
  expect(await other.next('chat.deleted')).toEqual({ type: 'chat.deleted', chatId: chat.id });
  expect(srv.db.select({ id: chats.id }).from(chats).all()).toEqual([{ id: keep.id }]);
  expect(srv.db.select({ id: files.id }).from(files).all()).toEqual([{ id: 'f2' }]);
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(sessionFiles(chat.id)).toHaveLength(0);
  expect(sessionFiles(keep.id)).toHaveLength(1);

  c.send({ type: 'chat.open', chatId: chat.id });
  await expect(c.next('chat.state')).rejects.toThrow(/not_found/);
});

test("chat.delete of another user's chat is not_found", { timeout: 30_000 }, async () => {
  const { c, srv } = await bootChat([]);
  const now = new Date().toISOString();
  srv.db
    .insert(chats)
    .values({ id: 'x1', userId: 'mallory', sessionPath: 's/', createdAt: now, updatedAt: now })
    .run();
  c.send({ type: 'chat.delete', chatId: 'x1' });
  await expect(c.next('chat.deleted')).rejects.toThrow(/not_found/);
  expect(srv.db.select({ id: chats.id }).from(chats).all()).toContainEqual({ id: 'x1' });
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
