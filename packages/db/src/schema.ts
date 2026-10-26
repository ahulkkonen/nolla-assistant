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
    // Phase-10 model policy. 'auto' | OpenRouter id | null (the agent profile's alias).
    modelId: text(),
    reasoning: text().notNull().default('auto'),
    // 'open' only after a recorded ZDR refusal (phase-10 decision 9); the server and zod enforce it.
    dataPolicy: text({ enum: ['zdr', 'open'] })
      .notNull()
      .default('zdr'),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [index('chats_user_archived_updated_idx').on(t.userId, t.archived, t.updatedAt)],
);

/** Favourite models (phase-10 decision 13), shown in `createdAt` order. */
export const modelFavorites = sqliteTable(
  'modelFavorites',
  { userId: text().notNull(), modelId: text().notNull(), createdAt: text().notNull() },
  (t) => [primaryKey({ columns: [t.userId, t.modelId] })],
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
  // failed: approved, but the write no longer applied (text gone or memory full).
  status: text({ enum: ['pending', 'applied', 'rejected', 'failed'] })
    .notNull()
    .default('pending'),
  createdAt: text().notNull(),
});

/** Weekly consolidation proposals (phase-8 decision 4); texts and `diff` are restored (real). */
export const memoryConsolidations = sqliteTable('memoryConsolidations', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  diff: text().notNull(),
  proposedUser: text().notNull(),
  proposedMemory: text().notNull(),
  // sha256 of USER.md + NUL + MEMORY.md when proposed; accept refuses if the files changed since.
  baseHash: text().notNull(),
  // pending: awaiting review; accepted / rejected: by the user; superseded: a newer proposal exists.
  status: text({ enum: ['pending', 'accepted', 'rejected', 'superseded'] })
    .notNull()
    .default('pending'),
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

/** The chat and message whose `write`/`edit` call or saved artifact last wrote a work-dir file (phase-11 decision 6). */
export const fileOrigins = sqliteTable(
  'fileOrigins',
  {
    userId: text().notNull(),
    // Relative to the user's work dir, '/'-separated; `.trash/<entry>/…` while in the trash.
    path: text().notNull(),
    chatId: chatRef(),
    // The assistant entry id (`Message.id`); null when not found.
    messageId: text(),
    updatedAt: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.path] })],
);

/** Where each `.trash` entry came from, for "Palauta" (phase-11 decision 5). */
export const fileTrash = sqliteTable(
  'fileTrash',
  {
    userId: text().notNull(),
    // The entry name in `.trash`: `<epoch ms>-<name>`.
    id: text().notNull(),
    originalPath: text().notNull(),
    deletedAt: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

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
