import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, files } from '@nolla/db';
import { afterEach, expect, test } from 'vitest';
import { bootChat, bootPseudo, connect, runCleanups } from '../test-utils.ts';

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

const TITLE = {
  match: 'Aiheet:',
  text: JSON.stringify({ title: 'Sivu', topics: [], proposed_topic: null, summary: 'Sivu.' }),
};

test('phase-30 decision 14: a chat that turns tainted masks its pages, also the earlier ones', {
  timeout: 30_000,
}, async () => {
  const page = (tag: string) => `Tässä:\n\n\`\`\`html\n<${tag}>Pekka Laaksonen</${tag}>\n\`\`\``;
  const { c, chat, config } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
    { text: page('h1') },
    { toolCalls: [{ name: 'web_search', args: { query: 'sää' } }] },
    { text: page('p') },
    TITLE,
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Tee sivu' });
  const plain = (await c.next('artifact.upsert')).artifact;
  expect(plain.content).toBe('<h1>Matti Virtanen</h1>');
  expect(plain).not.toHaveProperty('masked');
  await c.idle();

  // The search taints the chat (pseudo is on, memory plays no part): the room hears it, and the
  // earlier page comes again with its masked source before the new one.
  c.inbox.length = 0;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Hae sää ja tee toinen' });
  await c.idle();
  const heard = c.inbox.flatMap((m) =>
    m.type === 'artifact.upsert'
      ? [[m.artifact.content, m.artifact.masked]]
      : m.type === 'chat.updated'
        ? [['tainted', m.chat.tainted]]
        : [],
  );
  expect(heard.slice(0, 2)).toEqual([
    ['tainted', true],
    ['<h1>Matti Virtanen</h1>', '<h1>Pekka Laaksonen</h1>'],
  ]);
  expect(heard).toContainEqual(['<p>Matti Virtanen</p>', '<p>Pekka Laaksonen</p>']);

  const c2 = await connect(config.port);
  c2.send({ type: 'chat.open', chatId: chat.id });
  const state = await c2.next('chat.state');
  expect(state.chat.tainted).toBe(true);
  expect(state.artifacts?.map((a) => [a.id === plain.id, a.masked])).toEqual([
    [true, '<h1>Pekka Laaksonen</h1>'],
    [false, '<p>Pekka Laaksonen</p>'],
  ]);
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
  mkdirSync(join(config.dataDir, 'files', 'owner'), { recursive: true });
  const addFile = (id: string, chatId: string) => {
    const path = join('files', 'owner', id);
    writeFileSync(join(config.dataDir, path), 'x');
    srv.db
      .insert(files)
      .values({
        id,
        userId: 'owner',
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
