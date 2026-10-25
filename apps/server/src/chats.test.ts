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

test('chat.delete removes the row, files, and session; all sockets hear it', {
  timeout: 30_000,
}, async () => {
  const { c, chat, config, srv } = await bootChat([{ text: 'Moi' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hei' });
  await c.idle();
  const path = join('files', 'aleksi', 'f1');
  mkdirSync(join(config.dataDir, 'files', 'aleksi'), { recursive: true });
  writeFileSync(join(config.dataDir, path), 'x');
  srv.db
    .insert(files)
    .values({
      id: 'f1',
      userId: 'aleksi',
      chatId: chat.id,
      name: 'a.txt',
      mime: 'text/plain',
      size: 1,
      path,
      createdAt: new Date().toISOString(),
    })
    .run();
  const sessionFiles = () =>
    readdirSync(srv.registry.sessionDir).filter((f) => f.includes(chat.id));
  expect(sessionFiles()).toHaveLength(1);

  const other = await connect(config.port);
  c.send({ type: 'chat.delete', chatId: chat.id });
  expect(await c.next('chat.deleted')).toEqual({ type: 'chat.deleted', chatId: chat.id });
  expect(await other.next('chat.deleted')).toEqual({ type: 'chat.deleted', chatId: chat.id });
  expect(srv.db.select().from(chats).all()).toHaveLength(0);
  expect(srv.db.select().from(files).all()).toHaveLength(0);
  expect(existsSync(join(config.dataDir, path))).toBe(false);
  expect(sessionFiles()).toHaveLength(0);

  c.send({ type: 'chat.open', chatId: chat.id });
  await expect(c.next('chat.state')).rejects.toThrow(/not_found/);
});
