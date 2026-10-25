import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text().primaryKey(),
  createdAt: text().notNull(),
});

export const topics = sqliteTable('topics', {
  id: text().primaryKey(),
  userId: text().notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  createdAt: text().notNull(),
});

export const chats = sqliteTable(
  'chats',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    agentId: text().notNull().default('assistant'),
    topicId: text().references(() => topics.id, { onDelete: 'set null' }),
    // Restored title; may contain the user's own name.
    title: text(),
    titleMasked: text(),
    titleLocked: integer({ mode: 'boolean' }).notNull().default(false),
    pinned: integer({ mode: 'boolean' }).notNull().default(false),
    archived: integer({ mode: 'boolean' }).notNull().default(false),
    // relative to DATA_DIR, e.g. sessions/<userId>/<chatId>.jsonl
    sessionPath: text().notNull(),
    summary: text(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [index('chats_user_archived_updated_idx').on(t.userId, t.archived, t.updatedAt)],
);

const chatRef = () =>
  text()
    .notNull()
    .references(() => chats.id, { onDelete: 'cascade' });

export const topicProposals = sqliteTable('topicProposals', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  chatId: chatRef(),
  name: text().notNull(),
  why: text().notNull(),
  status: text().notNull().default('pending'),
  createdAt: text().notNull(),
});

export const tags = sqliteTable(
  'tags',
  {
    chatId: chatRef(),
    userId: text().notNull(),
    tag: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.tag] }),
    index('tags_user_tag_idx').on(t.userId, t.tag),
  ],
);

/**
 * Masked text units for search and recall (plan §7/§8). Each row has a `chat_fts` row and a
 * `chunk_vec` row with the same id (both raw SQL in index.ts).
 */
export const chunks = sqliteTable(
  'chunks',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    chatId: chatRef(),
    // title | summary | transcript
    kind: text().notNull(),
    messageId: text(),
    seq: integer().notNull(),
    text: text().notNull(),
    createdAt: text().notNull(),
  },
  (t) => [index('chunks_user_chat_idx').on(t.userId, t.chatId)],
);

export const pushSubscriptions = sqliteTable('pushSubscriptions', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  endpoint: text().notNull().unique(),
  subscription: text({ mode: 'json' }).notNull(),
  createdAt: text(),
});

export const memoryPending = sqliteTable('memoryPending', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  chatId: chatRef(),
  action: text({ enum: ['add', 'replace', 'remove'] }).notNull(),
  target: text({ enum: ['user', 'memory'] }).notNull(),
  text: text().notNull(),
  // The text `replace` swaps out; null for add and remove.
  replace: text(),
  // pending | applied | rejected
  status: text().notNull().default('pending'),
  createdAt: text().notNull(),
});

/** Weekly consolidation proposals (phase-8 decision 4); texts and `diff` are restored (real). */
export const memoryConsolidations = sqliteTable('memoryConsolidations', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  diff: text().notNull(),
  proposedUser: text().notNull(),
  proposedMemory: text().notNull(),
  // pending | accepted | rejected
  status: text().notNull().default('pending'),
  createdAt: text().notNull(),
});

export const files = sqliteTable('files', {
  id: text().primaryKey(),
  userId: text().notNull(),
  chatId: text().references(() => chats.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  path: text().notNull(),
  createdAt: text().notNull(),
});

export const authSessions = sqliteTable('authSessions', {
  // sha256 hex of the raw cookie token; the token itself is never stored.
  id: text().primaryKey(),
  userId: text().notNull(),
  createdAt: text().notNull(),
  expiresAt: text().notNull(),
  lastSeenAt: text().notNull(),
});

export const passkeys = sqliteTable('passkeys', {
  // credential id, base64url
  id: text().primaryKey(),
  userId: text().notNull(),
  // base64url COSE public key
  publicKey: text().notNull(),
  counter: integer().notNull().default(0),
  transports: text({ mode: 'json' }).$type<string[]>(),
  createdAt: text().notNull(),
  lastUsedAt: text(),
});

export const automationRuns = sqliteTable('automationRuns', {
  // The automation id (file name).
  id: text().primaryKey(),
  userId: text().notNull(),
  lastRunAt: text().notNull(),
  lastStatus: text({ enum: ['ok', 'error'] }).notNull(),
  lastChatId: text(),
  lastError: text(),
});
