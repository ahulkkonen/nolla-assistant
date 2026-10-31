import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, files } from '@pa/db';
import { afterEach, expect, test } from 'vitest';
import { bootChat, connect, runCleanups } from './test-utils.ts';

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
  c.send({ type: 'chat.delete', chatId: chat.id });
  await c.next('chat.deleted');
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
