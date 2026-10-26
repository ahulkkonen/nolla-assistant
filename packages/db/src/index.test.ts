import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chats, claims, evidence, fileOrigins, fileTrash, openDb, users } from './index.ts';

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

  // Phase-11: a file origin goes with its chat; a trash row has no chat.
  db.insert(fileOrigins)
    .values({ userId: 'u1', path: 'a.md', chatId: 'c1', messageId: 'm1', updatedAt: now })
    .run();
  db.insert(fileTrash)
    .values({ userId: 'u1', id: '1793000000000-b.md', originalPath: 'b.md', deletedAt: now })
    .run();
  expect(() =>
    db
      .insert(fileOrigins)
      .values({ userId: 'u1', path: 'c.md', chatId: 'missing', updatedAt: now })
      .run(),
  ).toThrow();
  // Phase-17: a claim and its evidence outlive the source chat.
  const claimId = db
    .insert(claims)
    .values({
      userId: 'u1',
      kind: 'preference',
      text: 'Käyttäjä haluaa lyhyet vastaukset.',
      confidence: 0.9,
      recordedAt: now,
      sourceChatId: 'c1',
    })
    .returning({ id: claims.id })
    .get().id;
  db.insert(evidence)
    .values({
      userId: 'u1',
      claimId,
      chatId: 'c1',
      messageId: 'm1',
      quote: 'lyhyesti',
      stance: 'supports',
      createdAt: now,
    })
    .run();
  sqlite
    .prepare('INSERT INTO claims_fts (claim_id, user_id, text) VALUES (?, ?, ?)')
    .run(claimId, 'u1', 'Käyttäjä haluaa lyhyet vastaukset.');
  expect(
    sqlite.prepare('SELECT claim_id FROM claims_fts WHERE claims_fts MATCH ?').get('"lyhye"'),
  ).toEqual({
    claim_id: claimId,
  });
  expect(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'claims_vec'").get(),
  ).toBeTruthy();
  sqlite.prepare('DELETE FROM chats WHERE id = ?').run('c1');
  expect(db.select().from(claims).all()).toHaveLength(1);
  expect(db.select().from(evidence).all()).toHaveLength(1);
  expect(db.select().from(fileOrigins).all()).toEqual([]);
  expect(db.select().from(fileTrash).all()).toHaveLength(1);

  expect(() => openDb(path)).not.toThrow();
});
