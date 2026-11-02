/**
 * Memory and claims frames: edits of the memory files, approval of pending memory writes,
 * consolidation, and claim review. Each change sends the fresh state to every socket of the user.
 * `memory.list` is answered in bridge.ts; a `MemoryError` is mapped to its code there.
 *
 * It must not write memory files or claims itself (memory.ts and claims.ts do), and it must not
 * send memory state to a chat room.
 */
import type { ClientMessage } from '@nolla/protocol';
import { errorMsg, NotFound, send } from '../socket.ts';
import { type Conn, toAll } from './connection.ts';

const memoryToAll = (conn: Conn) => toAll(conn, conn.memory.state());

export const claimsList = ({ memory, socket }: Conn) =>
  memory.claims ? send(socket, memory.claims.state()) : send(socket, errorMsg('not_implemented'));

export async function claimsChange(
  conn: Conn,
  msg: Extract<ClientMessage, { type: 'claims.review' | 'claims.update' | 'claims.stale' }>,
) {
  const { memory, socket } = conn;
  const c = memory.claims;
  if (!c) return send(socket, errorMsg('not_implemented'));
  const r =
    msg.type === 'claims.review'
      ? await c.review(msg.id, msg.action, { text: msg.text, validTo: msg.validTo })
      : msg.type === 'claims.update'
        ? await c.update(msg.id, { text: msg.text, validTo: msg.validTo })
        : c.stale(msg.id, msg.action);
  if (r === 'not_found') throw new NotFound();
  if (r === 'invalid') return send(socket, errorMsg('invalid'));
  // MEMORY.md may have changed (decision 28 amended).
  memoryToAll(conn);
  return toAll(conn, c.state());
}

export function memoryEdit(conn: Conn, msg: Extract<ClientMessage, { type: 'memory.edit' }>) {
  conn.memory.edit(msg.target, msg.text);
  return memoryToAll(conn);
}

export async function memoryApprove(
  conn: Conn,
  msg: Extract<ClientMessage, { type: 'memory.approve' }>,
) {
  const { memory, socket } = conn;
  const status = await memory.approve(msg.pendingId, msg.approve);
  if (!status) throw new NotFound();
  // A failed write leaves the queue; this is its only report.
  if (status === 'failed') send(socket, errorMsg('memory_conflict'));
  return memoryToAll(conn);
}

export async function memoryConsolidate(conn: Conn) {
  await conn.memory.consolidate();
  return memoryToAll(conn);
}
