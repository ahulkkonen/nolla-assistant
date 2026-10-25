import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chats, openDb, users } from './index.ts';

test('open, insert, read, fts, wal', () => {
  const { db, sqlite } = openDb(join(mkdtempSync(join(tmpdir(), 'pa-db-')), 't.db'));
  const now = new Date().toISOString();
  db.insert(users).values({ id: 'u1', createdAt: now }).run();
  db.insert(chats)
    .values({
      id: 'c1',
      userId: 'u1',
      sessionFile: '/data/s.jsonl',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const chat = db.select().from(chats).get();
  expect(chat?.agentId).toBe('assistant');
  expect(chat?.archived).toBe(false);

  sqlite
    .prepare('INSERT INTO chat_fts (chat_id, message_id, user_id, text) VALUES (?, ?, ?, ?)')
    .run('c1', 'm1', 'u1', 'hello brave world');
  const hit = sqlite.prepare('SELECT chat_id FROM chat_fts WHERE chat_fts MATCH ?').get('brave');
  expect(hit).toEqual({ chat_id: 'c1' });
  expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
});
