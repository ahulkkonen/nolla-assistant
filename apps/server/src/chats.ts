/**
 * Chat rows of one user: the owner-checked read, the protocol summary, and what a thread shows
 * from its fork chain (files, own usage, the fork link).
 *
 * Reads the database only. It must not write rows, send frames or touch Pi sessions; the bridge
 * handlers, the export, the tools and the title job build on it.
 */
import { chats, type Db } from '@pa/db';
import type { ChatSummary, ForkLink, Message } from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import { chatFiles } from './files.ts';
import { policyOf } from './pi/models.ts';
import { chatUsage } from './usage.ts';

export type ChatRow = typeof chats.$inferSelect;

export const chatRow = (db: Db, userId: string, chatId: string) =>
  db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .get();

/**
 * A turn of the chat had untrusted input: its claims never activate at once (phase 17), and its
 * pages and components run masked (phase-30 decision 14).
 */
export const markTainted = (db: Db, userId: string, chatId: string) =>
  void db
    .update(chats)
    .set({ tainted: true })
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .run();

export const summary = (r: ChatRow): ChatSummary => ({
  id: r.id,
  title: r.title,
  topicId: r.topicId,
  agentId: r.agentId,
  pinned: r.pinned,
  archived: r.archived,
  titleLocked: r.titleLocked,
  ...(r.forkedFromChatId ? { forkedFrom: r.forkedFromChatId } : {}),
  modelPolicy: policyOf(r),
  modes: r.modes,
  usage: chatUsage(r),
  updatedAt: r.updatedAt,
});

/**
 * The files of a chat's thread. A fork also shows the files of its sources (a fork of a fork walks
 * the chain) up to the edited message's time (`forkedAt`), while each source exists (phase-13
 * decision 7).
 */
export function threadFiles(db: Db, userId: string, r: ChatRow) {
  const all = chatFiles(db, userId, r.id);
  const seen = new Set([r.id]);
  for (let at = r; at.forkedFromChatId && at.forkedAt && !seen.has(at.forkedFromChatId); ) {
    const cut = at.forkedAt;
    const source = chatRow(db, userId, at.forkedFromChatId);
    if (!source) break;
    seen.add(source.id);
    all.push(...chatFiles(db, userId, source.id).filter((f) => f.createdAt <= cut));
    // The source's own copied part ends earlier still.
    at = source.forkedAt && source.forkedAt > cut ? { ...source, forkedAt: cut } : source;
  }
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A fork's copied replies cost in the source chat, not here (phase-13 decision 7). */
export function ownUsage(messages: Message[], r: ChatRow) {
  const { forkedAt } = r;
  if (forkedAt) for (const m of messages) if (m.createdAt < forkedAt) delete m.usage;
  return messages;
}

/** Where a forked chat came from; null for other chats. */
export function forkLink(db: Db, userId: string, r: ChatRow): ForkLink | null {
  if (!r.forkedFromChatId || !r.forkedFromMessageId) return null;
  const source = chatRow(db, userId, r.forkedFromChatId);
  return {
    chatId: r.forkedFromChatId,
    messageId: r.forkedFromMessageId,
    title: source?.title ?? null,
    deleted: !source,
  };
}
