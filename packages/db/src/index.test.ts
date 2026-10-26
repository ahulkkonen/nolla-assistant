import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chats, openDb, users } from './index.ts';

test('open, insert, read, fts, wal', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pa-db-')), 't.db');
  const { db, sqlite } = openDb(path);
  const now = new Date().toISOString();
  db.insert(users).values({ id: 'u1', createdAt: now }).run();
  db.insert(chats)
    .values({
      id: 'c1',
      userId: 'u1',
      sessionPath: 'sessions/u1/c1.jsonl',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const chat = db.select().from(chats).get();
  expect(chat?.agentId).toBe('assistant');
  expect(chat?.archived).toBe(false);
  // Phase-10: a row without a policy is the agent alias under ZDR.
  expect(chat).toMatchObject({ modelId: null, reasoning: 'auto', dataPolicy: 'zdr' });

  expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() =>
    db
      .insert(chats)
      .values({
        id: 'c2',
        userId: 'u1',
        topicId: 'missing',
        sessionPath: 'sessions/u1/c2.jsonl',
        createdAt: now,
        updatedAt: now,
      })
      .run(),
  ).toThrow();

  sqlite
    .prepare(
      'INSERT INTO chat_fts (chat_id, message_id, user_id, kind, text) VALUES (?, ?, ?, ?, ?)',
    )
    .run('c1', 'm1', 'u1', 'transcript', 'hello brave world');
  const hit = sqlite
    .prepare('SELECT chat_id, kind FROM chat_fts WHERE chat_fts MATCH ?')
    .get('brave');
  expect(hit).toEqual({ chat_id: 'c1', kind: 'transcript' });
  expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');

  expect(() => openDb(path)).not.toThrow();
});
