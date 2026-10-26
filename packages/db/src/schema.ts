import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

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
    // Phase-13 running totals of this chat's `usage` rows (decision 13).
    costUsd: real().notNull().default(0),
    tokens: integer().notNull().default(0),
    // Phase-16 token split of the same totals, for the prompt cache hit rate (decision 12).
    input: integer().notNull().default(0),
    output: integer().notNull().default(0),
    cacheRead: integer().notNull().default(0),
    cacheWrite: integer().notNull().default(0),
    // Phase-13 fork link (decision 4). No foreign key: the link stays after the source is deleted.
    forkedFromChatId: text(),
    forkedFromMessageId: text(),
    // The edited message's time in the source: copied messages are older, the fork's own newer.
    forkedAt: text(),
    // Phase-17 claims: a turn had untrusted tool output; the chat was started by an automation;
    // the last message id the extraction read and when.
    tainted: integer({ mode: 'boolean' }).notNull().default(false),
    fromAutomation: integer({ mode: 'boolean' }).notNull().default(false),
    claimsThrough: text(),
    claimsAt: text(),
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
  // Phase-15 device name from the User-Agent at login, e.g. "Safari · iPhone"; null for older rows.
  deviceLabel: text(),
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

/** One row per model call (phase-13 decision 13). Numbers and ids only, no text. */
export const usage = sqliteTable(
  'usage',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text().notNull(),
    // No foreign key: rows outlive a deleted chat, so monthly totals stay true.
    chatId: text(),
    agentId: text(),
    // chat: a reply in a chat. task: title job or consolidation. subagent: a child's reply.
    // search: one web_search call (phase-14). No SQL CHECK, so no migration.
    kind: text({ enum: ['chat', 'task', 'subagent', 'search'] }).notNull(),
    // The model id LiteLLM got, e.g. 'zdr/strong' or 'open/anthropic/claude-fable-5.1'.
    model: text().notNull(),
    input: integer().notNull(),
    output: integer().notNull(),
    cacheRead: integer().notNull(),
    cacheWrite: integer().notNull(),
    reasoning: integer().notNull(),
    costUsd: real().notNull(),
    estimated: integer({ mode: 'boolean' }).notNull(),
    createdAt: text().notNull(),
  },
  (t) => [index('usage_user_created_idx').on(t.userId, t.createdAt)],
);

export const CLAIM_KINDS = [
  'preference',
  'rhythm',
  'goal',
  'fact',
  'relationship',
  'decision_pattern',
  'quirk',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/**
 * Phase-17 claims about the user (real values). Never deleted: supersession, remove and expiry set
 * `validTo`. Each row has a `claims_fts` row and a `claims_vec` row (raw SQL in index.ts, row id =
 * `id`).
 */
export const claims = sqliteTable(
  'claims',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text().notNull(),
    // Vault entity id of the subject; null = the user.
    subjectEntityId: integer(),
    kind: text({ enum: CLAIM_KINDS }).notNull(),
    text: text().notNull(),
    confidence: real().notNull(),
    status: text({ enum: ['proposed', 'active', 'superseded', 'rejected'] })
      .notNull()
      .default('proposed'),
    activatedBy: text({ enum: ['auto', 'user'] }),
    validFrom: text(),
    validTo: text(),
    recordedAt: text().notNull(),
    supersedesId: integer().references((): AnySQLiteColumn => claims.id),
    // No foreign key: a claim outlives a deleted chat.
    sourceChatId: text(),
    lastConfirmedAt: text(),
    timesSeen: integer().notNull().default(1),
    reviewedAt: text(),
    checkedAt: text(),
    inProfile: integer({ mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('claims_user_status_idx').on(t.userId, t.status)],
);

/** Quotes (real, ≤ 300 chars) from a user message that support or contradict a claim. */
export const evidence = sqliteTable(
  'evidence',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text().notNull(),
    claimId: integer()
      .notNull()
      .references(() => claims.id),
    chatId: text(),
    messageId: text(),
    quote: text().notNull(),
    stance: text({ enum: ['supports', 'contradicts'] }).notNull(),
    createdAt: text().notNull(),
  },
  (t) => [index('evidence_claim_idx').on(t.claimId)],
);

/** Vault entities a claim names (`entityId` lives in vault.db: no foreign key). */
export const claimEntities = sqliteTable(
  'claimEntities',
  {
    claimId: integer()
      .notNull()
      .references(() => claims.id),
    entityId: integer().notNull(),
    userId: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.claimId, t.entityId] }),
    index('claim_entities_entity_idx').on(t.userId, t.entityId),
  ],
);
