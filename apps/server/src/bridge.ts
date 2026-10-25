import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { chats, type Db } from '@pa/db';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import {
  type Annotation,
  type ChatSummary,
  ClientMessage,
  type Message,
  type ServerMessage,
  type ToolRow,
  type ToolStatus,
} from '@pa/protocol';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { AttachmentNotFound, chatFiles, ingestAttachments } from './files.ts';
import { GUARD_REASON } from './pi/guard.ts';
import type { SessionRegistry } from './pi/registry.ts';

export type Socket = {
  send(data: string): void;
  on(event: 'message', fn: (data: unknown) => void): void;
  on(event: 'close', fn: () => void): void;
};

export type BridgeDeps = {
  registry: SessionRegistry;
  db: Db;
  userId: string;
  dataDir: string;
  log: FastifyBaseLogger;
  /** chatId → sockets that have the chat open. Shared by all connections of one server. */
  rooms: Map<string, Set<Socket>>;
  /** Restores surrogates for display. Unset in dev (no masking, see config `pseudoUrl`). */
  pseudo?: PseudoClient;
};

type AgentMessage = AgentSession['messages'][number];
type ChatRow = typeof chats.$inferSelect;

/** Fixed client-facing text per error code; details stay in the server log. */
const ERRORS = {
  bad_message: 'Invalid message',
  not_found: 'Chat not found',
  not_implemented: 'Not implemented',
  failed: 'Request failed',
  prompt_failed: 'Prompt failed',
  llm_failed: 'Model call failed',
  pseudo_down: 'Pseudonymization service unavailable',
} as const;

class NotFound extends Error {}

const send = (socket: Socket, msg: ServerMessage) => socket.send(JSON.stringify(msg));
export const errorMsg = (code: keyof typeof ERRORS, chatId?: string): ServerMessage => ({
  type: 'error',
  code,
  message: ERRORS[code],
  ...(chatId ? { chatId } : {}),
});

export function broadcast(rooms: BridgeDeps['rooms'], chatId: string, msg: ServerMessage) {
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

const summary = (r: ChatRow): ChatSummary => ({
  id: r.id,
  title: r.title,
  topicId: r.topicId,
  agentId: r.agentId,
  pinned: r.pinned,
  archived: r.archived,
  updatedAt: r.updatedAt,
});

function textOf(m: AgentMessage): string {
  if (!('content' in m)) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** Text blocks of a Pi tool result (`{ content: [...] }`); never the raw object. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b: { type?: unknown; text?: unknown }) =>
      b.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
    )
    .join('\n');
}

const toolStatus = (isError: boolean, text: string): ToolStatus =>
  !isError ? 'ok' : text.includes(GUARD_REASON) ? 'denied' : 'error';

const argsPreview = (args: unknown) =>
  Object.entries((args ?? {}) as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');

type Restored = { text: string; annotations: Annotation[] };
type Restore = (text: string) => Promise<Restored>;

/** Surrogates back to real values for display. On any sidecar failure: masked text plus `onDown`. */
function restorer(pseudo: PseudoClient | undefined, onDown: () => void): Restore {
  return async (text) => {
    if (!pseudo || !text) return { text, annotations: [] };
    try {
      const { restored, spans } = await pseudo.unmask(text);
      const annotations = spans.map((s) => ({
        start: s.start,
        end: s.end,
        entityId: s.entity_id,
        modelSaw: s.surrogate_form,
      }));
      return { text: restored, annotations };
    } catch {
      onDown();
      return { text, annotations: [] };
    }
  };
}

/** Masked characters held back while streaming; a surrogate up to this long is never split. */
const HOLD_BACK = 24;

/**
 * Restores the releasable part of streamed masked text. `pending` is unmasked whole (the tail is
 * context); the cut sits `HOLD_BACK` before the end, moved back to the start of any surrogate it
 * would split. Returns the restored prefix with chunk-relative annotations and the masked rest.
 */
async function release(restore: Restore, pending: string, final: boolean) {
  let cut = final ? pending.length : pending.length - HOLD_BACK;
  if (cut <= 0) return { out: { text: '', annotations: [] }, rest: pending };
  const r = await restore(pending);
  let shift = 0;
  const annotations: Annotation[] = [];
  for (const a of r.annotations) {
    const start = a.start - shift;
    const end = start + a.modelSaw.length;
    if (end > cut) {
      if (start < cut) cut = start;
      break;
    }
    annotations.push(a);
    shift += a.end - a.start - a.modelSaw.length;
  }
  return { out: { text: r.text.slice(0, cut + shift), annotations }, rest: pending.slice(cut) };
}

export function attachBridge(socket: Socket, deps: BridgeDeps) {
  const { registry, db, userId, dataDir, log, rooms, pseudo } = deps;
  const open = new Set<string>();

  const owned = (chatId: string) => {
    const r = db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .get();
    if (!r) throw new NotFound();
    return r;
  };

  const update = (chatId: string, set: Partial<ChatRow>) => {
    const r = db
      .update(chats)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .returning()
      .get();
    if (!r) throw new NotFound();
    send(socket, { type: 'chat.updated', chat: summary(r) });
  };

  const join = (chatId: string, session: AgentSession) => {
    open.add(chatId);
    let room = rooms.get(chatId);
    if (!room) rooms.set(chatId, (room = new Set()));
    room.add(socket);
    registry.subscribe(chatId, session, forward(chatId, session, deps));
  };

  const handle = async (msg: ClientMessage) => {
    switch (msg.type) {
      case 'ping':
        return send(socket, { type: 'pong' });
      case 'chat.create': {
        const id = randomUUID();
        const session = await registry.create(id);
        const now = new Date().toISOString();
        const r = db
          .insert(chats)
          .values({
            id,
            userId,
            agentId: msg.agentId,
            topicId: msg.topicId ?? null,
            // Directory key only: Pi names the JSONL file and the registry resolves it by chat id.
            sessionPath: `sessions/${userId}/`,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        join(id, session);
        return send(socket, { type: 'chat.created', chat: summary(r) });
      }
      case 'chat.list': {
        const rows = db
          .select()
          .from(chats)
          .where(and(eq(chats.userId, userId), eq(chats.archived, msg.archived ?? false)))
          .orderBy(desc(chats.pinned), desc(chats.updatedAt))
          .all();
        return send(socket, { type: 'chat.list', chats: rows.map(summary) });
      }
      case 'chat.open': {
        const r = owned(msg.chatId);
        const session = await registry.get(msg.chatId);
        join(msg.chatId, session);
        let down = false;
        const restore = restorer(pseudo, () => {
          if (!down) send(socket, errorMsg('pseudo_down', msg.chatId));
          down = true;
        });
        return send(socket, {
          type: 'chat.state',
          chat: summary(r),
          messages: await history(session, chatFiles(db, userId, msg.chatId), restore),
        });
      }
      case 'chat.archive':
        return update(msg.chatId, { archived: msg.archived });
      case 'chat.rename':
        return update(msg.chatId, { title: msg.title, titleLocked: true });
      case 'chat.pin':
        return update(msg.chatId, { pinned: msg.pinned });
      case 'user.message': {
        const { chatId } = msg;
        owned(chatId);
        const { images, text } = await ingestAttachments(
          db,
          { dataDir },
          userId,
          chatId,
          msg.attachments,
        );
        const session = await registry.get(chatId);
        join(chatId, session);
        log.debug(
          { chatId, length: msg.text.length, attachments: msg.attachments.length },
          'user.message',
        );
        session
          .prompt(msg.text + text, { streamingBehavior: 'steer', images })
          .catch((err: unknown) => {
            log.warn({ chatId, err }, 'prompt failed');
            broadcast(rooms, chatId, errorMsg('prompt_failed', chatId));
          });
        return;
      }
      case 'user.stop':
        owned(msg.chatId);
        if (registry.has(msg.chatId)) await (await registry.get(msg.chatId)).abort();
        return;
      default:
        return send(socket, errorMsg('not_implemented'));
    }
  };

  socket.on('message', (data) => {
    let parsed: ReturnType<typeof ClientMessage.safeParse>;
    try {
      parsed = ClientMessage.safeParse(JSON.parse(String(data)));
    } catch {
      return send(socket, errorMsg('bad_message'));
    }
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues.length }, 'bad client message');
      return send(socket, errorMsg('bad_message'));
    }
    handle(parsed.data).catch((err: unknown) => {
      if (err instanceof NotFound || err instanceof AttachmentNotFound)
        return send(socket, errorMsg('not_found'));
      log.warn({ err, type: parsed.data.type }, 'client message failed');
      send(socket, errorMsg('failed'));
    });
  });

  socket.on('close', () => {
    for (const chatId of open) {
      const room = rooms.get(chatId);
      room?.delete(socket);
      if (room?.size === 0) rooms.delete(chatId);
    }
  });
}

/**
 * One listener per session. Deltas carry a stream id assigned at `message_start`; `message.final`
 * carries the persisted session entry id (same id `chat.state` uses), and clients replace the
 * streamed message with it. Finals are sent at `turn_end` (or `agent_settled`) so tool rows have
 * their final status.
 */
function forward(
  chatId: string,
  session: AgentSession,
  { db, rooms, log, userId, pseudo }: BridgeDeps,
) {
  const emit = (msg: ServerMessage) => broadcast(rooms, chatId, msg);
  let streamId = randomUUID();
  let pending: AgentMessage | undefined;
  /** Masked text of the streaming message not yet sent (the hold-back). */
  let held = '';
  let downSent = false;
  const statuses = new Map<string, ToolStatus>();
  const restore = restorer(pseudo, () => {
    if (!downSent) emit(errorMsg('pseudo_down', chatId));
    downSent = true;
  });

  const stream = async (final: boolean) => {
    const { out, rest } = await release(restore, held, final);
    held = rest;
    if (out.text) emit({ type: 'message.delta', chatId, messageId: streamId, ...out });
  };

  const flush = async () => {
    const m = pending;
    pending = undefined;
    if (!m) return;
    const entry = session.sessionManager
      .getEntries()
      .findLast(
        (e) =>
          e.type === 'message' &&
          e.message.role === 'assistant' &&
          e.message.timestamp === m.timestamp,
      );
    log.debug({ chatId, length: textOf(m).length }, 'message.final');
    const message = toMessage(entry?.id ?? streamId, m, toolRows(m, statuses));
    Object.assign(message, await restore(message.text));
    emit({ type: 'message.final', chatId, message });
  };

  const handle = async (e: AgentSessionEvent) => {
    switch (e.type) {
      case 'message_start':
        if (e.message.role === 'assistant') {
          streamId = randomUUID();
          held = '';
        }
        return;
      case 'message_update':
        if (e.assistantMessageEvent.type !== 'text_delta') return;
        held += e.assistantMessageEvent.delta;
        return stream(false);
      case 'message_end':
        if (e.message.role !== 'assistant') return;
        await stream(true);
        if (e.message.stopReason === 'error') {
          log.warn({ chatId, error: e.message.errorMessage }, 'model call failed');
          return emit(errorMsg('llm_failed', chatId));
        }
        pending = e.message;
        return;
      case 'turn_end':
        return flush();
      case 'tool_execution_start':
        return emit({
          type: 'tool.start',
          chatId,
          callId: e.toolCallId,
          name: e.toolName,
          argsPreview: (await restore(argsPreview(e.args))).text.slice(0, 200),
        });
      case 'tool_execution_update':
        return emit({
          type: 'tool.update',
          chatId,
          callId: e.toolCallId,
          output: resultText(e.partialResult).slice(0, 2000),
        });
      case 'tool_execution_end': {
        const text = (await restore(resultText(e.result))).text;
        const status = toolStatus(e.isError, text);
        statuses.set(e.toolCallId, status);
        return emit({
          type: 'tool.end',
          chatId,
          callId: e.toolCallId,
          status,
          summary: text.slice(0, 200),
        });
      }
      case 'agent_start':
        downSent = false;
        return emit({ type: 'agent.status', chatId, state: 'running' });
      case 'agent_settled': {
        await flush();
        statuses.clear();
        const r = db
          .update(chats)
          .set({ updatedAt: new Date().toISOString() })
          .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
          .returning()
          .get();
        if (r) emit({ type: 'chat.updated', chat: summary(r) });
        return emit({ type: 'agent.status', chatId, state: 'idle' });
      }
    }
  };

  // Sidecar calls are async: one chain keeps every chat event in Pi's order.
  let chain = Promise.resolve();
  return (e: AgentSessionEvent) => {
    chain = chain
      .then(() => handle(e))
      .catch((err: unknown) => log.warn({ chatId, err }, 'forward'));
  };
}

function toolRows(m: AgentMessage, statuses: Map<string, ToolStatus>): ToolRow[] {
  if (m.role !== 'assistant') return [];
  return m.content.flatMap((b) =>
    b.type === 'toolCall'
      ? [{ callId: b.id, name: b.name, status: statuses.get(b.id) ?? 'running', summary: '' }]
      : [],
  );
}

function toMessage(id: string, m: AgentMessage, tools: ToolRow[]): Message {
  return {
    id,
    role: m.role === 'user' ? 'user' : 'assistant',
    text: textOf(m),
    annotations: [],
    attachments: [],
    tools,
    createdAt: new Date(m.timestamp).toISOString(),
  };
}

/**
 * Rebuilds messages from the Pi branch. A user message gets the chat's files uploaded after the
 * previous user message and up to its own timestamp; the appended `[Liite: ...]` blocks are cut
 * from its text.
 */
// ponytail: timestamp window, not a stored message link; a file uploaded but sent with a later message shows on the earlier one. Add files.messageId if that happens.
async function history(
  session: AgentSession,
  files: ReturnType<typeof chatFiles>,
  restore: Restore,
): Promise<Message[]> {
  const entries = session.sessionManager.getBranch();
  const statuses = new Map<string, ToolStatus>();
  for (const e of entries) {
    if (e.type === 'message' && e.message.role === 'toolResult') {
      statuses.set(e.message.toolCallId, toolStatus(e.message.isError, textOf(e.message)));
    }
  }
  let prev = '';
  const messages = entries.flatMap((e) => {
    if (e.type !== 'message' || (e.message.role !== 'user' && e.message.role !== 'assistant'))
      return [];
    const m = toMessage(e.id, e.message, toolRows(e.message, statuses));
    if (m.role === 'user') {
      m.attachments = files
        .filter((f) => f.createdAt > prev && f.createdAt <= m.createdAt)
        .map(({ createdAt: _, ...ref }) => ref);
      prev = m.createdAt;
      const cuts = m.attachments
        .filter((a) => a.kind === 'document')
        .map((a) => m.text.indexOf(`\n\n[Liite: ${a.name}]\n`))
        .filter((i) => i >= 0);
      if (cuts.length) m.text = m.text.slice(0, Math.min(...cuts));
    }
    return [m];
  });
  // ponytail: one /unmask per message; batch in phase 7.
  for (const m of messages) Object.assign(m, await restore(m.text));
  return messages;
}
