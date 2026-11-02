/**
 * Frames out to browser sockets: one socket, one chat's room, and the error frame with its fixed
 * client text per code. `NotFound` and `RunActive` are thrown by handlers; the bridge maps them.
 *
 * It holds no state of its own (the rooms map belongs to the caller). It must not read the
 * database or Pi sessions, and an error frame must never carry details from the server log.
 */
import type { ServerMessage } from '@nolla/protocol';

export type Socket = {
  send(data: string): void;
  on(event: 'message', fn: (data: unknown) => void): void;
  on(event: 'close', fn: () => void): void;
};

/** chatId → sockets that have the chat open. */
export type Rooms = Map<string, Set<Socket>>;

/** Fixed client-facing text per error code; details stay in the server log. */
export const ERRORS = {
  bad_message: 'Invalid message',
  not_found: 'Chat not found',
  not_implemented: 'Not implemented',
  failed: 'Request failed',
  prompt_failed: 'Prompt failed',
  llm_failed: 'Model call failed',
  pseudo_down: 'Pseudonymization service unavailable',
  held: 'The previous message waits for an answer in the vault',
  memory_full: 'Memory is full',
  memory_conflict: 'Memory changed; the write no longer applies',
  memory_generated: 'MEMORY.md is generated from claims; edit the claims in Muisti › Havainnot',
  invalid: 'Invalid value',
  zdr_unavailable: 'No zero-data-retention endpoint for this model',
} as const;

export type Code = keyof typeof ERRORS;

export class NotFound extends Error {}
/** A model or policy change while the chat runs (phase-10 decision 14); answers `failed`. */
export class RunActive extends Error {}

export const send = (socket: Socket, msg: ServerMessage) => socket.send(JSON.stringify(msg));
export const errorMsg = (code: keyof typeof ERRORS, chatId?: string): ServerMessage => ({
  type: 'error',
  code,
  message: ERRORS[code],
  ...(chatId ? { chatId } : {}),
});

export function broadcast(rooms: Rooms, chatId: string, msg: ServerMessage) {
  const room = rooms.get(chatId);
  if (!room) return;
  for (const s of room) {
    try {
      send(s, msg);
    } catch {
      room.delete(s);
    }
  }
  if (room.size === 0) rooms.delete(chatId);
}
