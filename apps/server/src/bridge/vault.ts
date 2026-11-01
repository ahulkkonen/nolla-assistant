/**
 * The vault screen over the socket: `vault.*` frames go to the sidecar, and the asking socket gets
 * a fresh `vault.state`. A merge or a never-detect also drops the collision questions it settles.
 * An add seeds one entity, so the next message masks it (phase 34).
 *
 * The vault holds real values. They go only to the asking socket (or every socket of the user, by
 * main.ts), never to a chat room, a log line or a Pi session.
 */
import {
  type PseudoClient,
  PseudoDownError,
  type VaultEntityRow,
  type VaultPendingRow,
} from '@pa/pi-ext-pseudo';
import type { ClientMessage, ServerMessage } from '@pa/protocol';
import { errorMsg, send } from '../socket.ts';
import type { Conn } from './connection.ts';

/** Applies one vault change, then answers this socket (not the room) with a fresh state. */
export async function vault(conn: Conn, msg: Extract<ClientMessage, { type: `vault.${string}` }>) {
  const { pseudo, memory, collisions, socket } = conn;
  if (!pseudo) return send(socket, errorMsg('not_implemented'));
  switch (msg.type) {
    case 'vault.merge':
      await pseudo.vaultMerge(msg.fromIds, msg.intoId);
      memory.claims?.repoint(msg.fromIds, msg.intoId);
      collisions.dropEntities([...msg.fromIds, msg.intoId]); // the question no longer stands
      break;
    case 'vault.split':
      await pseudo.vaultSplit(msg.entityId, msg.spanIds);
      break;
    case 'vault.pin':
      await pseudo.vaultUpdate(msg.entityId, { pinned: msg.pinned });
      break;
    case 'vault.allowlist':
      await pseudo.vaultUpdate(msg.entityId, { allowlisted: msg.allowlisted });
      break;
    case 'vault.regenerate':
      await pseudo.vaultUpdate(msg.entityId, { regenerate: true });
      break;
    case 'vault.neverDetect':
      await pseudo.vaultUpdate(msg.entityId, { never_detect: true });
      collisions.dropEntities([msg.entityId]);
      break;
    case 'vault.setMode':
      await pseudo.vaultUpdate(msg.entityId, { mode: msg.mode });
      break;
    case 'vault.pending.resolve':
      try {
        await pseudo.vaultPending(msg.pendingId, msg.action);
        // A message held by this collision now masks again and runs.
        collisions.answered(msg.pendingId);
      } catch (err) {
        // 409: answered or closed meanwhile (a stale screen); the fresh state below shows it.
        if (!(err instanceof PseudoDownError && err.message.endsWith('status 409'))) throw err;
        collisions.drop(msg.pendingId);
      }
      break;
    case 'vault.add':
      try {
        await pseudo.vaultSeed([{ kind: msg.kind, canonical: msg.text }]);
      } catch (err) {
        // 422: the sidecar finds no valid value of that kind (a bad hetu, a lower-case name).
        if (!(err instanceof PseudoDownError && err.message.endsWith('status 422'))) throw err;
        return send(socket, errorMsg('invalid'));
      }
      break;
  }
  send(socket, await vaultState(pseudo));
}

/** Sidecar snake_case to protocol camelCase. `lastSeen` is normalised to UTC ISO for zod. */
const vaultEntity = (e: VaultEntityRow) => ({
  id: e.id,
  kind: e.kind,
  canonical: e.canonical,
  surrogate: e.surrogate,
  mode: e.mode,
  pinned: e.pinned,
  allowlisted: e.allowlisted,
  seenCount: e.seen_count,
  lastSeen: e.last_seen ? new Date(e.last_seen).toISOString() : null,
});
const vaultPending = (p: VaultPendingRow) => ({
  id: p.id,
  kind: p.kind,
  text: p.text,
  detector: p.detector,
  score: p.score,
  chatId: p.session_id,
  reason: p.reason,
  entityId: p.entity_id,
});

export async function vaultState(pseudo: PseudoClient): Promise<ServerMessage> {
  const { entities, pending } = await pseudo.vaultList();
  return {
    type: 'vault.state',
    entities: entities.map(vaultEntity),
    pending: pending.map(vaultPending),
  };
}
