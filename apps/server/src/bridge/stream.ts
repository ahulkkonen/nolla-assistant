/**
 * Pi session events to frames for a chat's room. `join` puts a socket in the room and
 * subscribes one `forward` listener per session: deltas with the hold-back restore, thinking,
 * tool rows, finals, artifacts, model errors and the idle state, in Pi's order.
 *
 * It must not answer a client message or change a chat's settings, and it must not send real
 * values that did not come through `restore`.
 */
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { chats } from '@pa/db';
import {
  type ServerMessage,
  type ToolSearch,
  type ToolStatus,
  WEB_SEARCH_TOOL,
} from '@pa/protocol';
import { and, eq } from 'drizzle-orm';
import { extractArtifacts } from '../artifacts.ts';
import { chatRow, summary } from '../chats.ts';
import { searchView, toMessage, toolRows, toolStatus } from '../history.ts';
import { isZdrRefusal, policyOf, providerStatus } from '../pi/models.ts';
import type { ChatEvent } from '../pi/registry.ts';
import { release, restorer } from '../restore.ts';
import { indexChat } from '../search.ts';
import { type AgentMessage, textOf, transcript } from '../session-text.ts';
import { broadcast, ERRORS, errorMsg } from '../socket.ts';
import type { BridgeDeps, Conn } from './connection.ts';

/** Reindexes the chat's shown branch in the background (embedding must not hold the caller). */
export const reindex = (
  { db, userId, log }: Pick<BridgeDeps, 'db' | 'userId' | 'log'>,
  chatId: string,
  session: Pick<AgentSession, 'sessionManager'>,
) =>
  void indexChat(db, userId, chatId, transcript(session)).catch((err: unknown) =>
    log.warn({ chatId, error: err instanceof Error ? err.message : 'unknown' }, 'index failed'),
  );

export const join = (conn: Conn, chatId: string, session: AgentSession) => {
  const { rooms, socket, registry } = conn;
  conn.open.add(chatId);
  let room = rooms.get(chatId);
  if (!room) rooms.set(chatId, (room = new Set()));
  room.add(socket);
  registry.subscribe(chatId, session, forward(chatId, session, conn));
};

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

const argsPreview = (args: unknown) =>
  Object.entries((args ?? {}) as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');

/**
 * One listener per session. Deltas carry a stream id assigned at `message_start`; `message.final`
 * carries the persisted session entry id (same id `chat.state` uses), and clients replace the
 * streamed message with it. Finals are sent at `turn_end` (or `agent_settled`) so tool rows have
 * their final status.
 */
function forward(
  chatId: string,
  session: AgentSession,
  { db, rooms, log, userId, pseudo, push, catalog, refusals, registry }: BridgeDeps,
) {
  const emit = (msg: ServerMessage) => broadcast(rooms, chatId, msg);
  let streamId: string = randomUUID();
  /** Phase 26: the stream id of the reply whose request is out; its `message_start` takes it. */
  let nextId: string | undefined;
  let pending: AgentMessage | undefined;
  /** Masked text of the streaming message not yet sent (the hold-back). */
  let held = '';
  let thinking = false;
  const think = (active: boolean) => {
    thinking = active;
    emit({ type: 'message.thinking', chatId, messageId: streamId, active });
  };
  const statuses = new Map<string, ToolStatus>();
  const searches = new Map<string, ToolSearch>();
  // Once per turn: the restorer reports the first failure and is reset at `agent_start`.
  const restore = restorer(pseudo, () => emit(errorMsg('pseudo_down', chatId)));

  const stream = async (final: boolean) => {
    const { out, rest } = await release(restore, held, final);
    held = rest;
    if (out.text)
      emit({
        type: 'message.delta',
        chatId,
        messageId: streamId,
        text: out.text,
        annotations: out.annotations,
      });
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
    const message = toMessage(entry?.id ?? streamId, m, toolRows(m, statuses, searches));
    ({ text: message.text, annotations: message.annotations } = await restore(message.text));
    emit({ type: 'message.final', chatId, message });
    // Ids must match `chat.state`; without the entry id the next `chat.state` carries them.
    if (entry)
      for (const artifact of extractArtifacts(entry.id, message.text))
        emit({ type: 'artifact.upsert', chatId, artifact });
  };

  const handle = async (e: ChatEvent) => {
    switch (e.type) {
      // Phase 26: Pi sends the request and gets its headers before the message starts.
      case 'provider_phase':
        if (e.phase === 'sent') nextId = randomUUID();
        return emit({
          type: 'message.phase',
          chatId,
          messageId: nextId ?? streamId,
          phase: e.phase,
          at: e.at,
        });
      case 'message_start':
        if (e.message.role === 'assistant') {
          streamId = nextId ?? randomUUID();
          nextId = undefined;
          held = '';
          thinking = false;
        }
        return;
      case 'message_update': {
        // Live "Ajattelee…" (phase-13 decision 9); Pi's `thinking_end` comes only at the end.
        const t = e.assistantMessageEvent.type;
        if (t === 'thinking_start' && !thinking) think(true);
        else if (thinking && (t === 'text_delta' || t === 'toolcall_start')) think(false);
        if (e.assistantMessageEvent.type !== 'text_delta') return;
        held += e.assistantMessageEvent.delta;
        return stream(false);
      }
      case 'message_end':
        if (e.message.role !== 'assistant') return;
        if (thinking) think(false);
        await stream(true);
        if (e.message.stopReason === 'error') {
          log.warn({ chatId, error: e.message.errorMessage }, 'model call failed');
          // The model this run used: a change during the run is in the row already (phase 20).
          const r = registry.builtWith(chatId) ?? chatRow(db, userId, chatId);
          if (r?.modelId) {
            if (isZdrRefusal(policyOf(r), e.message.errorMessage, catalog)) {
              refusals.set(chatId, r.modelId);
              const { modelId } = policyOf(r);
              return emit({
                type: 'error',
                code: 'zdr_unavailable',
                message: ERRORS.zdr_unavailable,
                chatId,
                modelId,
              });
            }
            // Shows the form LiteLLM used if a real refusal ever goes unrecognised (risk 3).
            log.warn(
              { chatId, error: e.message.errorMessage?.slice(0, 80) },
              'model error not classified as a ZDR refusal',
            );
          }
          // Phase-22 decision 1: the cause for the toast. Cut before the restore like tool output.
          const status = providerStatus(e.message.errorMessage);
          const detail = e.message.errorMessage
            ? (await restore(e.message.errorMessage.slice(0, 400))).text.slice(0, 400)
            : undefined;
          return emit({
            type: 'error',
            code: 'llm_failed',
            message: ERRORS.llm_failed,
            chatId,
            ...(status ? { status } : {}),
            ...(detail ? { detail } : {}),
          });
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
          // Cut first: a surrogate split by the cut stays masked in the preview.
          argsPreview: (await restore(argsPreview(e.args).slice(0, 200))).text,
        });
      case 'tool_execution_update':
        return emit({
          type: 'tool.update',
          chatId,
          callId: e.toolCallId,
          output: (await restore(resultText(e.partialResult).slice(0, 2000))).text,
        });
      case 'tool_execution_end': {
        const text = resultText(e.result);
        const status = toolStatus(e.isError, text);
        statuses.set(e.toolCallId, status);
        const found =
          e.toolName === WEB_SEARCH_TOOL && !e.isError
            ? await searchView(e.result?.details, restore)
            : undefined;
        if (found) searches.set(e.toolCallId, found);
        return emit({
          type: 'tool.end',
          chatId,
          callId: e.toolCallId,
          status,
          summary: (await restore(text.slice(0, 200))).text,
          ...(found ? { search: found } : {}),
        });
      }
      case 'agent_start':
        restore.reset();
        return emit({ type: 'agent.status', chatId, state: 'running' });
      case 'agent_settled': {
        await flush();
        statuses.clear();
        searches.clear();
        const r = db
          .update(chats)
          .set({ updatedAt: new Date().toISOString() })
          .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
          .returning()
          .get();
        if (r) emit({ type: 'chat.updated', chat: summary(r) });
        emit({ type: 'agent.status', chatId, state: 'idle' });
        if (!e.aborted) void push.notify(chatId, 'settled');
        return reindex({ db, userId, log }, chatId, session);
      }
    }
  };

  // Sidecar calls are async: one chain keeps every chat event in Pi's order.
  let chain = Promise.resolve();
  return (e: ChatEvent) => {
    chain = chain
      .then(() => handle(e))
      .catch((err: unknown) => log.warn({ chatId, err }, 'forward'));
  };
}
