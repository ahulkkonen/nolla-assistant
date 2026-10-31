/**
 * Approval frames: the answer to an approval card, and the per-chat "Hyväksy automaattisesti"
 * switch with the state the composer chip shows (`autoApproveOf`).
 *
 * It must not decide whether a tool call needs a card or run a tool (approval.ts and the Pi
 * extensions do). A running automation keeps its own list; this module must not change it.
 */
import type { ClientMessage } from '@pa/protocol';
import type { ChatRow } from '../chats.ts';
import { errorMsg, NotFound, send } from '../socket.ts';
import { type Conn, notify, owned } from './connection.ts';

/** "Hyväksy automaattisesti" of a chat (phase-21 decision 7); `tools` also while it is off. */
export const autoApproveOf = ({ approvals, registry }: Conn, r: ChatRow) => {
  return { on: approvals.autoApprove.has(r.id), tools: registry.autoApproveTools(r.agentId) };
};

/** Also during a run: the next tool call reads it; an open card stays open. */
export function setAutoApprove(
  conn: Conn,
  msg: Extract<ClientMessage, { type: 'chat.setAutoApprove' }>,
) {
  const { approvals, socket } = conn;
  const r = owned(conn, msg.chatId);
  // A running automation keeps its own `autoApprove` list (phase-14 decision 9).
  if (approvals.unattended.has(msg.chatId))
    return send(socket, errorMsg('bad_message', msg.chatId));
  if (msg.on) approvals.autoApprove.add(msg.chatId);
  else approvals.autoApprove.delete(msg.chatId);
  return notify(conn, msg.chatId, {
    type: 'chat.autoApprove',
    chatId: r.id,
    ...autoApproveOf(conn, r),
  });
}

export function respond(conn: Conn, msg: Extract<ClientMessage, { type: 'approval.respond' }>) {
  const { approvals, socket } = conn;
  if (approvals.respond(msg.requestId, msg.approve)) return;
  const chatId = approvals.resolvedChat(msg.requestId);
  if (!chatId) throw new NotFound();
  return send(socket, {
    type: 'approval.resolved',
    chatId,
    requestId: msg.requestId,
    outcome: 'expired',
  });
}
