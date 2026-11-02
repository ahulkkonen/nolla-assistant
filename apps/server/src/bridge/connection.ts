/**
 * One browser socket's context for the bridge handlers (`Conn`): the shared `BridgeDeps`, the
 * socket and the chats it joined. Owns attach and close, the per-user state a new socket gets
 * first, and the small helpers every handler uses: `owned`, `update`, `notify`, `toAll`.
 *
 * It must not handle a client message and must not import a handler module (bridge/*.ts);
 * bridge.ts dispatches to the handlers.
 */
import { chats, type Db } from '@nolla/db';
import type { PseudoClient } from '@nolla/pi-ext-pseudo';
import type { ServerMessage } from '@nolla/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Agents } from '../agents.ts';
import type { Approvals } from '../approval.ts';
import type { Automations } from '../automations.ts';
import { type ChatRow, chatRow, summary } from '../chats.ts';
import type { CollisionWaits } from '../collisions.ts';
import type { Fx } from '../fx.ts';
import type { MemoryStore } from '../memory.ts';
import { type Modes, modeInfos } from '../modes.ts';
import type { Catalog } from '../pi/models.ts';
import type { SessionRegistry } from '../pi/registry.ts';
import type { Push } from '../push.ts';
import { broadcast, NotFound, type Rooms, type Socket, send } from '../socket.ts';

export type BridgeDeps = {
  registry: SessionRegistry;
  db: Db;
  userId: string;
  dataDir: string;
  log: FastifyBaseLogger;
  /** chatId → sockets that have the chat open. Shared by all connections of one server. */
  rooms: Rooms;
  agents: () => Agents;
  /** Output modes (phase-23); `chat.setModes` and `chat.create` accept only these ids. */
  modes: () => Modes;
  approvals: Approvals;
  /** Every open socket of this server (for `agents.state` after a profile reload). */
  sockets: Set<Socket>;
  /** Unset until the runner has started. */
  automations: () => Automations | undefined;
  memory: MemoryStore;
  push: Push;
  /** Restores surrogates for display. Unset in dev (no masking, see config `pseudoUrl`). */
  pseudo?: PseudoClient;
  /** OpenRouter model catalog (phase-10 decision 8). */
  catalog: Catalog;
  /**
   * chatId → the stored `modelId` of its last classified ZDR refusal (phase-10 decision 9). In
   * memory: a restart clears it. Shared by all connections of one server.
   */
  refusals: Map<string, string>;
  /** User inputs held by a surrogate collision (phase-12 decision 8); answered via the vault. */
  collisions: CollisionWaits;
  /** ECB USD/EUR rate for `fx.state` (phase-13 decision 16). */
  fx: Pick<Fx, 'get'>;
};

/** One socket's context: the shared deps, the socket, and the chats it has joined. */
export type Conn = BridgeDeps & { socket: Socket; open: Set<string> };

export const agentsState = (agents: Agents, modes: Modes): ServerMessage => ({
  type: 'agents.state',
  agents: [...agents.values()].map((p) => ({
    id: p.id,
    name: p.name,
    model: p.model,
    subagents: p.subagents,
    modes: p.modes.default,
  })),
  modes: modeInfos(modes),
});

/** Registers the socket and sends the per-user state that a new screen needs first. */
export function connect(socket: Socket, deps: BridgeDeps): Conn {
  const { agents, modes, approvals, sockets, collisions, fx } = deps;
  const open = new Set<string>();
  sockets.add(socket);
  send(socket, agentsState(agents(), modes()));
  send(socket, { type: 'fx.state', rate: fx.get() });
  // A reload must not lose open approvals.
  for (const r of approvals.list()) send(socket, r);
  // Nor held messages (phase-12 decision 8), nor the drops a restart caused.
  for (const m of collisions.list()) send(socket, m);
  return { ...deps, socket, open };
}

export function disconnect({ socket, sockets, push, open, rooms }: Conn) {
  sockets.delete(socket);
  push.setFocus(socket, null);
  for (const chatId of open) {
    const room = rooms.get(chatId);
    room?.delete(socket);
    if (room?.size === 0) rooms.delete(chatId);
  }
}

/** Per-user state goes to every open screen. */
export const toAll = ({ sockets }: Conn, msg: ServerMessage) => {
  for (const s of sockets)
    try {
      send(s, msg);
    } catch {}
};

export const owned = ({ db, userId }: Conn, chatId: string) => {
  const r = chatRow(db, userId, chatId);
  if (!r) throw new NotFound();
  return r;
};

/** To the chat's room, and to this socket when it has not joined the room. */
export const notify = ({ rooms, socket }: Conn, chatId: string, msg: ServerMessage) => {
  broadcast(rooms, chatId, msg);
  if (!rooms.get(chatId)?.has(socket)) send(socket, msg);
};

export const update = (conn: Conn, chatId: string, set: Partial<ChatRow>) => {
  const { db, userId } = conn;
  const r = db
    .update(chats)
    .set({ ...set, updatedAt: new Date().toISOString() })
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .returning()
    .get();
  if (!r) throw new NotFound();
  notify(conn, chatId, { type: 'chat.updated', chat: summary(r) });
};
