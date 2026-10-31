/**
 * Chat frames that read or change one chat as a whole: create, list, open (`chat.state`), the
 * thinking text, related chats, archive, rename, pin, model, modes, data policy, delete.
 *
 * It must not prompt a session or move its branch (bridge/turns.ts does) and must not stream
 * events (bridge/stream.ts does). Every chat id goes through `owned` first.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { chats, files } from '@pa/db';
import type { ClientMessage, ServerMessage } from '@pa/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { messageArtifacts } from '../artifacts.ts';
import { type ChatRow, forkLink, ownUsage, summary, threadFiles } from '../chats.ts';
import { history } from '../history.ts';
import { AUTO_MODEL } from '../pi/models.ts';
import { restorer } from '../restore.ts';
import { related } from '../search.ts';
import { cutText, textOf, thinkingOf } from '../session-text.ts';
import { broadcast, errorMsg, NotFound, RunActive, send } from '../socket.ts';
import { autoApproveOf } from './approvals.ts';
import { type Conn, owned, toAll, update } from './connection.ts';
import { validChoice } from './models.ts';
import { join } from './stream.ts';
import { ownTopic } from './topics.ts';

/** `thinking.get` cuts at most here, before the restore. */
const THINKING_MAX = 50_000;

const knownModes = ({ modes }: Conn, ids: string[]) => ids.every((id) => modes().has(id));

/**
 * A data-policy change needs an idle chat (decision 14; phase-20 decision 15 lets a model
 * change through). Synchronous, like the row write after it: no prompt can start between the
 * check and the write.
 */
const assertIdle = ({ registry }: Conn, chatId: string) => {
  if (registry.running(chatId)) throw new RunActive();
};

/** `chat.state` of a chat and its session (`chat.open`, `chat.fork`, `chat.version`). */
export const chatState = async (
  conn: Conn,
  r: ChatRow,
  session: AgentSession,
  switched = false,
): Promise<ServerMessage> => {
  const { db, userId, pseudo, socket, registry, memory } = conn;
  const restore = restorer(pseudo, () => send(socket, errorMsg('pseudo_down', r.id)));
  const messages = ownUsage(await history(session, threadFiles(db, userId, r), restore), r);
  const link = forkLink(db, userId, r);
  // Phase-30 decision 14: the replies' masked text, for the masked sources of a tainted chat.
  const masked = r.tainted
    ? new Map(
        session.sessionManager
          .getBranch()
          .flatMap((e) => (e.type === 'message' ? [[e.id, textOf(e.message)] as const] : [])),
      )
    : undefined;
  return {
    type: 'chat.state',
    chat: summary(r),
    messages,
    artifacts: messageArtifacts(messages, masked),
    running: registry.running(r.id),
    autoApprove: autoApproveOf(conn, r),
    ...(link ? { forkedFrom: link } : {}),
    ...(memory.claims ? { claims: memory.claims.chips(r.id) } : {}),
    ...(switched ? { switched } : {}),
  };
};

export async function createChat(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.create' }>) {
  const { agents, registry, db, userId, catalog, socket } = conn;
  if (!agents().has(msg.agentId)) throw new NotFound();
  if (msg.topicId) ownTopic(conn, msg.topicId);
  const choice = msg.model ?? { modelId: 'auto', reasoning: 'auto' };
  if (!validChoice(conn, choice) || !knownModes(conn, msg.modes ?? []))
    return send(socket, errorMsg('bad_message'));
  // No Auto in the catalog (offline first start): the profile's alias, so chats still work.
  const model =
    choice.modelId === 'auto' && !catalog.get(AUTO_MODEL)
      ? { modelId: null, reasoning: 'auto' }
      : choice;
  const id = randomUUID();
  // Never from the client: every new chat starts ZDR-only (phase-10 proof 1).
  const chat = {
    agentId: msg.agentId,
    ...model,
    dataPolicy: 'zdr',
    modes: msg.modes ? [...new Set(msg.modes)] : null,
  } as const;
  // Session first: a failed build leaves no chat row behind.
  const session = await registry.create(id, chat);
  const now = new Date().toISOString();
  const r = db
    .insert(chats)
    .values({
      id,
      userId,
      ...chat,
      topicId: msg.topicId ?? null,
      // Directory key only: Pi names the JSONL file and the registry resolves it by chat id.
      sessionPath: `sessions/${userId}/`,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  join(conn, id, session);
  send(socket, { type: 'chat.created', chat: summary(r) });
  // No `chat.state` follows for a new chat: the composer chip needs the tool list.
  return send(socket, { type: 'chat.autoApprove', chatId: id, ...autoApproveOf(conn, r) });
}

export function listChats(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.list' }>) {
  const { db, userId, socket } = conn;
  const rows = db
    .select()
    .from(chats)
    .where(and(eq(chats.userId, userId), eq(chats.archived, msg.archived ?? false)))
    .orderBy(desc(chats.pinned), desc(chats.updatedAt))
    .all();
  return send(socket, { type: 'chat.list', chats: rows.map(summary) });
}

export async function openChat(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.open' }>) {
  const { registry, db, userId, approvals, socket } = conn;
  const r = owned(conn, msg.chatId);
  const session = await registry.get(msg.chatId);
  join(conn, msg.chatId, session);
  send(socket, await chatState(conn, r, session));
  for (const a of approvals.list(msg.chatId)) send(socket, a);
  if (r.summary)
    send(socket, {
      type: 'chat.related',
      chatId: r.id,
      related: related(db, userId, r.id),
    });
  return;
}

export async function thinkingText(
  conn: Conn,
  msg: Extract<ClientMessage, { type: 'thinking.get' }>,
) {
  const { registry, pseudo, socket } = conn;
  owned(conn, msg.chatId);
  const entry = (await registry.get(msg.chatId)).sessionManager.getEntry(msg.messageId);
  const thinking = entry?.type === 'message' ? thinkingOf(entry.message) : '';
  if (!thinking) throw new NotFound();
  let down = false;
  const { text, annotations } = await restorer(pseudo, () => {
    down = true;
  })(cutText(thinking, THINKING_MAX));
  if (down) return send(socket, errorMsg('pseudo_down', msg.chatId));
  return send(socket, {
    type: 'thinking.text',
    chatId: msg.chatId,
    messageId: msg.messageId,
    text,
    annotations,
  });
}

export function relatedChats(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.related' }>) {
  const { db, userId, socket } = conn;
  owned(conn, msg.chatId);
  return send(socket, {
    type: 'chat.related',
    chatId: msg.chatId,
    related: related(db, userId, msg.chatId),
  });
}

export const archiveChat = (conn: Conn, msg: Extract<ClientMessage, { type: 'chat.archive' }>) =>
  update(conn, msg.chatId, { archived: msg.archived });

export async function renameChat(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.rename' }>) {
  const { pseudo } = conn;
  owned(conn, msg.chatId);
  const titleMasked = pseudo ? (await pseudo.mask(msg.chatId, msg.title)).masked : msg.title;
  return update(conn, msg.chatId, { title: msg.title, titleMasked, titleLocked: true });
}

export const pinChat = (conn: Conn, msg: Extract<ClientMessage, { type: 'chat.pin' }>) =>
  update(conn, msg.chatId, { pinned: msg.pinned });

/** Row first, then the stale session: a message in between already builds from the new row. */
export async function setModel(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.setModel' }>) {
  const { registry, refusals, socket } = conn;
  owned(conn, msg.chatId);
  if (!validChoice(conn, msg)) return send(socket, errorMsg('bad_message'));
  // Also during a run (phase-20 decision 15): the running session ends its turn, and
  // `registry.get` rebuilds it with the new row once it settles.
  // Consent was for one model: a change ends it (phase-10 decision 9).
  refusals.delete(msg.chatId);
  update(conn, msg.chatId, {
    modelId: msg.modelId,
    reasoning: msg.reasoning,
    dataPolicy: 'zdr',
  });
  await registry.evict(msg.chatId);
  return;
}

/** Phase-23 decision 6: as `chat.setModel`, also during a run; the next turn has the prompt. */
export async function setModes(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.setModes' }>) {
  const { registry, socket } = conn;
  owned(conn, msg.chatId);
  if (!knownModes(conn, msg.modes)) return send(socket, errorMsg('bad_message', msg.chatId));
  update(conn, msg.chatId, { modes: [...new Set(msg.modes)] });
  await registry.evict(msg.chatId);
  return;
}

export async function setDataPolicy(
  conn: Conn,
  msg: Extract<ClientMessage, { type: 'chat.setDataPolicy' }>,
) {
  const { registry, refusals, socket } = conn;
  const r = owned(conn, msg.chatId);
  if (msg.dataPolicy === 'open' && (r.modelId === null || refusals.get(msg.chatId) !== r.modelId))
    return send(socket, errorMsg('bad_message'));
  assertIdle(conn, msg.chatId);
  update(conn, msg.chatId, { dataPolicy: msg.dataPolicy });
  await registry.evict(msg.chatId);
  return;
}

export async function deleteChat(conn: Conn, msg: Extract<ClientMessage, { type: 'chat.delete' }>) {
  const { registry, db, userId, dataDir, log, rooms, pseudo, approvals, refusals, collisions } =
    conn;
  const { chatId } = msg;
  const deleted = owned(conn, chatId);
  approvals.autoApprove.delete(chatId);
  // Row first: a concurrent `registry.get` then fails instead of reviving the chat.
  const paths = db.transaction((tx) => {
    const own = and(eq(files.chatId, chatId), eq(files.userId, userId));
    const rows = tx.select({ path: files.path }).from(files).where(own).all();
    tx.delete(files).where(own).run();
    // Cascades to chunks, tags and proposals.
    tx.delete(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .run();
    return rows.map((r) => r.path);
  });
  approvals.cancel(chatId);
  collisions.cancel(chatId);
  broadcast(rooms, chatId, { type: 'subagent.state', chatId, children: [] });
  await registry
    .remove(chatId)
    .catch((err: unknown) =>
      log.warn({ chatId, error: err instanceof Error ? err.message : 'unknown' }, 'remove failed'),
    );
  const filesDir = resolve(dataDir, 'files') + sep;
  for (const path of paths) {
    const abs = resolve(dataDir, path);
    if (!abs.startsWith(filesDir)) {
      log.warn({ chatId }, 'file path outside files/, not removed');
      continue;
    }
    try {
      rmSync(abs, { force: true });
    } catch (err) {
      log.warn({ chatId, error: err instanceof Error ? err.message : 'unknown' }, 'rm failed');
    }
  }
  rooms.delete(chatId);
  refusals.delete(chatId);
  // A fork's copied sidecar scope goes with it (phase-13 decision 3).
  if (pseudo && deleted.forkedFromChatId)
    await pseudo
      .dropFork(chatId)
      .catch((err: unknown) =>
        log.warn(
          { chatId, error: err instanceof Error ? err.message : 'unknown' },
          'fork scope drop failed',
        ),
      );
  return toAll(conn, { type: 'chat.deleted', chatId });
}
