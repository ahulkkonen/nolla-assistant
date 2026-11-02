/**
 * Topic frames: accepting a proposed topic (as a new topic or merged into an owned one) or
 * rejecting it, and the owner check of a topic id. `topic.list` is answered in bridge.ts.
 *
 * It must not run the title job or ask a model (topics.ts does), and it changes only rows of
 * the connected user.
 */
import { randomUUID } from 'node:crypto';
import { topicProposals, topics } from '@nolla/db';
import type { ClientMessage } from '@nolla/protocol';
import { and, eq } from 'drizzle-orm';
import { NotFound, send } from '../socket.ts';
import { topicState } from '../topics.ts';
import { type Conn, notify, update } from './connection.ts';

export const ownTopic = ({ db, userId }: Conn, topicId: string) => {
  const t = db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.id, topicId), eq(topics.userId, userId)))
    .get();
  if (!t) throw new NotFound();
};

/** Moves a pending proposal of this user to `status`. */
const resolveProposal = ({ db, userId }: Conn, id: number, status: 'accepted' | 'rejected') => {
  const p = db
    .update(topicProposals)
    .set({ status })
    .where(
      and(
        eq(topicProposals.id, id),
        eq(topicProposals.userId, userId),
        eq(topicProposals.status, 'pending'),
      ),
    )
    .returning()
    .get();
  if (!p) throw new NotFound();
  return p;
};

export function acceptTopic(conn: Conn, msg: Extract<ClientMessage, { type: 'topic.accept' }>) {
  const { db, userId } = conn;
  let topicId = msg.mergeIntoTopicId;
  if (topicId) ownTopic(conn, topicId);
  const p = resolveProposal(conn, msg.proposalId, 'accepted');
  if (!topicId) {
    topicId = randomUUID();
    db.insert(topics)
      .values({
        id: topicId,
        userId,
        name: msg.name?.trim() || p.name,
        description: p.why,
        createdAt: new Date().toISOString(),
      })
      .run();
  }
  update(conn, p.chatId, { topicId });
  return notify(conn, p.chatId, topicState(db, userId));
}

export function rejectTopic(conn: Conn, msg: Extract<ClientMessage, { type: 'topic.reject' }>) {
  const { db, userId, socket } = conn;
  resolveProposal(conn, msg.proposalId, 'rejected');
  return send(socket, topicState(db, userId));
}
