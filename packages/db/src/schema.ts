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
    topicId: text().references(() => topics.id),
    // Restored title; may contain the user's own name.
    title: text(),
    titleMasked: text(),
    titleLocked: integer({ mode: 'boolean' }).default(false),
    pinned: integer({ mode: 'boolean' }).default(false),
    archived: integer({ mode: 'boolean' }).default(false),
    // Path of the Pi JSONL session under /data.
    sessionFile: text().notNull(),
    summary: text(),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
  },
  (t) => [index('chats_user_archived_updated_idx').on(t.userId, t.archived, t.updatedAt)],
);

export const topicProposals = sqliteTable('topicProposals', {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: text().notNull(),
  chatId: text().references(() => chats.id),
  name: text(),
  why: text(),
  status: text().default('pending'),
  createdAt: text(),
});

export const tags = sqliteTable(
  'tags',
  {
    chatId: text().references(() => chats.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    tag: text(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.tag] })],
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
  chatId: text(),
  action: text(),
  target: text(),
  text: text(),
  status: text().default('pending'),
  createdAt: text(),
});

export const files = sqliteTable('files', {
  id: text().primaryKey(),
  userId: text().notNull(),
  chatId: text().references(() => chats.id, { onDelete: 'cascade' }),
  name: text(),
  mime: text(),
  size: integer(),
  path: text().notNull(),
  createdAt: text(),
});
