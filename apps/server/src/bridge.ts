import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  type AgentSession,
  type AgentSessionEvent,
  type PromptOptions,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { chats, type Db, files, modelFavorites, topicProposals, topics } from '@pa/db';
import { FULL } from '@pa/pi-ext-memory';
import {
  type PseudoClient,
  PseudoDownError,
  type VaultEntityRow,
  type VaultPendingRow,
} from '@pa/pi-ext-pseudo';
import {
  ClientMessage,
  type ModelChoice,
  type ServerMessage,
  ToolSearch,
  type ToolStatus,
  WEB_SEARCH_TOOL,
} from '@pa/protocol';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Agents } from './agents.ts';
import type { Approvals } from './approval.ts';
import { extractArtifacts, messageArtifacts } from './artifacts.ts';
import type { Automations } from './automations.ts';
import { type ChatRow, chatRow, forkLink, ownUsage, summary, threadFiles } from './chats.ts';
import type { CollisionWaits } from './collisions.ts';
import { AttachmentNotFound, ingestAttachments, splitBlocks } from './files.ts';
import type { Fx } from './fx.ts';
import { filesOf, history, searchView, toMessage, toolRows, toolStatus } from './history.ts';
import { GENERATED, MemoryError, type MemoryStore } from './memory.ts';
import { type Modes, modeInfos } from './modes.ts';
import {
  AUTO_MODEL,
  type Catalog,
  isZdrRefusal,
  policyOf,
  providerStatus,
  resolveModelId,
} from './pi/models.ts';
import { type ChatEvent, ChatNotFound, type SessionRegistry } from './pi/registry.ts';
import { BadSubscription, type Push } from './push.ts';
import { release, restorer } from './restore.ts';
import { indexChat, related, search } from './search.ts';
import { type AgentMessage, cutText, textOf, thinkingOf, transcript } from './session-text.ts';
import {
  broadcast,
  type Code,
  ERRORS,
  errorMsg,
  NotFound,
  type Rooms,
  RunActive,
  type Socket,
  send,
} from './socket.ts';
import { topicState } from './topics.ts';
import { usageMonth } from './usage.ts';
import { childrenOf, conversationAt, LEAF_MARK, newestLeaf, versionsOf } from './versions.ts';

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

type Entry = ReturnType<AgentSession['sessionManager']['getBranch']>[number];
type UserEntry = Extract<Entry, { type: 'message' }> & { message: { role: 'user' } };
/** A prompt to send: real text (the input hook masks it) and images. */
type Sent = {
  text: string;
  images: Extract<Extract<UserEntry['message']['content'], unknown[]>[number], { type: 'image' }>[];
};

/** Reindexes the chat's shown branch in the background (embedding must not hold the caller). */
const reindex = (
  { db, userId, log }: Pick<BridgeDeps, 'db' | 'userId' | 'log'>,
  chatId: string,
  session: Pick<AgentSession, 'sessionManager'>,
) =>
  void indexChat(db, userId, chatId, transcript(session)).catch((err: unknown) =>
    log.warn({ chatId, error: err instanceof Error ? err.message : 'unknown' }, 'index failed'),
  );

/** `thinking.get` cuts at most here, before the restore. */
const THINKING_MAX = 50_000;

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
 * `message.accepted` (phase 13): the prompts of a session whose user entry is not stored yet, in
 * call order. One queue per session, shared by every socket; each prompt keeps its own `notify`.
 *
 * Pi 1.3.0 `AgentSession.prompt` (dist/core/agent-session.js) runs the input hooks first (masking),
 * then reports through `preflightResult`:
 * - `started` (idle): the run starts and stores this prompt as its first user message. `prompt`
 *   resolves only when the run ends.
 * - `queued` (a run is active, `steer`): the masked text joins the steering queue
 *   (`getSteeringMessages()`) and `prompt` resolves at once. Pi stores the message later, after the
 *   current turn, so the prompt's promise says nothing about the entry.
 * - `handled` (an input hook dropped it: sidecar down, a dropped collision): nothing is stored.
 *
 * Pi stores a message right after the public `message_end` listeners return, so the entry is read
 * in a microtask. A queued prompt matches by its masked text; the started one is the run's first
 * user message.
 */
type Accepting = {
  state: 'input' | 'started' | 'queued';
  /** The masked text of a queued prompt. */
  text?: string | undefined;
  notify: ((entryId: string) => void) | undefined;
};
const accepting = new WeakMap<AgentSession, Accepting[]>();
const unsubscribe = new WeakMap<AgentSession, () => void>();

/** Stops listening once no prompt of the session waits. */
function pruneAccepting(session: AgentSession) {
  if (accepting.get(session)?.length) return;
  unsubscribe.get(session)?.();
  unsubscribe.delete(session);
  accepting.delete(session);
}

/**
 * The entry id of the stored user message `m`: the leaf, or the nearest entry above it that holds
 * `m` (an extension may append a custom entry right after it).
 */
function storedId(sm: AgentSession['sessionManager'], m: AgentMessage) {
  let id = sm.getLeafId();
  for (let hops = 0; id && hops < 8; hops++) {
    const e = sm.getEntry(id);
    if (!e) return undefined;
    if (
      e.type === 'message' &&
      e.message.role === 'user' &&
      (e.message === m || (e.message.timestamp === m.timestamp && textOf(e.message) === textOf(m)))
    )
      return e.id;
    id = e.parentId;
  }
  return undefined;
}

function acceptEvent(session: AgentSession, e: AgentSessionEvent) {
  const items = accepting.get(session);
  if (!items) return;
  // The run is over: a started or queued prompt that got no entry never will.
  if (e.type === 'agent_settled') {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]?.state !== 'input') items.splice(i, 1);
    return pruneAccepting(session);
  }
  if (e.type !== 'message_end' || e.message.role !== 'user') return;
  const m = e.message;
  const text = textOf(m);
  const started = items.findIndex((x) => x.state === 'started');
  const i =
    started >= 0 ? started : items.findIndex((x) => x.state === 'queued' && x.text === text);
  const item = items[i];
  if (!item) return;
  items.splice(i, 1);
  queueMicrotask(() => {
    const id = storedId(session.sessionManager, m);
    if (id) item.notify?.(id);
    pruneAccepting(session);
  });
}

/**
 * Tracks one prompt until its user entry is stored, then calls `notify` with the entry id. Every
 * prompt is tracked, with or without `notify`, so queued texts stay matched in order. Pass
 * `preflightResult` in the prompt's options and call `failed` when the prompt rejects.
 */
function trackAccept(session: AgentSession, notify?: (entryId: string) => void) {
  let items = accepting.get(session);
  if (!items) {
    items = [];
    accepting.set(session, items);
    unsubscribe.set(
      session,
      session.subscribe((e) => acceptEvent(session, e)),
    );
  }
  const list = items;
  const item: Accepting = { state: 'input', notify };
  list.push(item);
  const drop = () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    pruneAccepting(session);
  };
  const preflightResult: NonNullable<PromptOptions['preflightResult']> = (d) => {
    if (d === 'handled') return drop();
    if (d === 'started') {
      item.state = 'started';
      return;
    }
    // This prompt's text: the first one in the steering queue that no other queued prompt holds.
    const held = list.filter((x) => x !== item && x.state === 'queued').map((x) => x.text);
    item.text = session.getSteeringMessages().find((t) => {
      const k = held.indexOf(t);
      if (k < 0) return true;
      held.splice(k, 1);
      return false;
    });
    item.state = 'queued';
  };
  return { preflightResult, failed: drop };
}

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

export function attachBridge(socket: Socket, deps: BridgeDeps) {
  const {
    registry,
    db,
    userId,
    dataDir,
    log,
    rooms,
    pseudo,
    agents,
    modes,
    approvals,
    sockets,
    memory,
    push,
    catalog,
    refusals,
    collisions,
    fx,
  } = deps;
  const open = new Set<string>();
  sockets.add(socket);
  /** Per-user state goes to every open screen. */
  const toAll = (msg: ServerMessage) => {
    for (const s of sockets)
      try {
        send(s, msg);
      } catch {}
  };
  const memoryToAll = () => toAll(memory.state());

  const modelsState = (): ServerMessage => ({
    type: 'models.state',
    auto: AUTO_MODEL,
    favorites: db
      .select({ modelId: modelFavorites.modelId })
      .from(modelFavorites)
      .where(eq(modelFavorites.userId, userId))
      .orderBy(asc(modelFavorites.createdAt))
      .all()
      .map((f) => f.modelId),
    catalog: catalog.list().map(({ maxTokens: _, cacheRead: __, cacheWrite: ___, ...m }) => m),
    latest: catalog.latest(),
    fetchedAt: catalog.fetchedAt(),
  });

  /** Phase-10 server validation: a catalog model, and an effort that the model offers. */
  const validChoice = ({ modelId, reasoning }: ModelChoice) => {
    const m = catalog.get(resolveModelId(modelId));
    if (modelId !== 'auto' && !m) return false;
    return reasoning === 'auto' || !!m?.reasoning?.efforts.includes(reasoning);
  };

  const knownModes = (ids: string[]) => ids.every((id) => modes().has(id));

  /**
   * A data-policy change needs an idle chat (decision 14; phase-20 decision 15 lets a model
   * change through). Synchronous, like the row write after it: no prompt can start between the
   * check and the write.
   */
  const assertIdle = (chatId: string) => {
    if (registry.running(chatId)) throw new RunActive();
  };
  send(socket, agentsState(agents(), modes()));
  send(socket, { type: 'fx.state', rate: fx.get() });
  // A reload must not lose open approvals.
  for (const r of approvals.list()) send(socket, r);
  // Nor held messages (phase-12 decision 8), nor the drops a restart caused.
  for (const m of collisions.list()) send(socket, m);

  const ownTopic = (topicId: string) => {
    const t = db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.id, topicId), eq(topics.userId, userId)))
      .get();
    if (!t) throw new NotFound();
  };

  const owned = (chatId: string) => {
    const r = chatRow(db, userId, chatId);
    if (!r) throw new NotFound();
    return r;
  };

  /** To the chat's room, and to this socket when it has not joined the room. */
  const notify = (chatId: string, msg: ServerMessage) => {
    broadcast(rooms, chatId, msg);
    if (!rooms.get(chatId)?.has(socket)) send(socket, msg);
  };

  const update = (chatId: string, set: Partial<ChatRow>) => {
    const r = db
      .update(chats)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
      .returning()
      .get();
    if (!r) throw new NotFound();
    notify(chatId, { type: 'chat.updated', chat: summary(r) });
  };

  /** Moves a pending proposal of this user to `status`. */
  const resolveProposal = (id: number, status: 'accepted' | 'rejected') => {
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

  const join = (chatId: string, session: AgentSession) => {
    open.add(chatId);
    let room = rooms.get(chatId);
    if (!room) rooms.set(chatId, (room = new Set()));
    room.add(socket);
    registry.subscribe(chatId, session, forward(chatId, session, deps));
  };

  /** Applies one vault change, then answers this socket (not the room) with a fresh state. */
  const vault = async (msg: Extract<ClientMessage, { type: `vault.${string}` }>) => {
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
    }
    send(socket, await vaultState(pseudo));
  };

  /** Runs `fn` with the chat held: `running` is true, so no policy change starts meanwhile. */
  const holding = async <T>(chatId: string, fn: () => Promise<T>): Promise<T> => {
    let release = () => {};
    registry.hold(chatId, new Promise<void>((r) => (release = r)));
    try {
      return await fn();
    } finally {
      release();
    }
  };

  /**
   * `user.retry` (phase-10): the chat's last turn failed (an error reply without tool calls, or
   * no reply yet), so its user message runs again in place, with the same text and images. The
   * thread and the model then hold that message once. Returns the refusal code, if any.
   */
  const retry = async (chatId: string, localId?: string): Promise<Code | undefined> => {
    owned(chatId);
    const session = await registry.get(chatId);
    // Synchronous from this check to the hold: no prompt or policy change starts in between.
    if (registry.running(chatId)) return 'failed';
    const last = failedTurn(session);
    if (!last) return 'bad_message';
    return holding(chatId, () => rerun(chatId, session, last, localId));
  };

  /** The user entry `messageId` on the chat's shown branch, its index there and the branch. */
  const userOnBranch = (session: AgentSession, messageId: string) => {
    const branch = session.sessionManager.getBranch();
    const at = branch.findIndex((e) => e.id === messageId);
    const e = branch[at];
    return e?.type === 'message' && e.message.role === 'user'
      ? { branch, at, edited: e as UserEntry }
      : undefined;
  };

  /**
   * "Lähetä" in the edit box (phase-24 decisions 5 to 7): a new version of the user message in the
   * same session. The old version stays as a sibling; the edited text masks and runs as a retry.
   */
  const edit = async (msg: Extract<ClientMessage, { type: 'chat.edit' }>) => {
    const src = owned(msg.chatId);
    const session = await registry.get(msg.chatId);
    // Synchronous from this check to the hold.
    if (registry.running(msg.chatId)) return 'failed';
    const found = userOnBranch(session, msg.messageId);
    if (!found) return 'bad_message';
    const { branch, at, edited } = found;
    const leaf = session.sessionManager.getLeafId();
    return holding(msg.chatId, async () => {
      const sent = await editedPrompt(src, branch, at, edited, msg.text);
      if (sent === 'pseudo_down') return sent;
      return rewindAndPrompt(msg.chatId, session, edited, sent, leaf, msg.localId);
    });
  };

  /**
   * "‹ ›" (phase-24 decision 9): shows the newest branch of another version, marks it in the file
   * (`pa-leaf`) and sends `chat.state` with `switched` to every tab of the chat.
   */
  const version = async (
    msg: Extract<ClientMessage, { type: 'chat.version' }>,
  ): Promise<Code | undefined> => {
    const r = owned(msg.chatId);
    const session = await registry.get(msg.chatId);
    if (registry.running(msg.chatId)) return 'failed';
    const sm = session.sessionManager;
    const target = versionsOf(sm).get(msg.messageId)?.ids[msg.index - 1];
    if (!target) return 'bad_message';
    const leaf = newestLeaf(childrenOf(sm.getEntries()), target);
    // A version without a stored reply: navigation would land on its parent (P2), or on a
    // `pseudo-spans` entry after a failed reply, which shows the user message with no answer.
    const end = conversationAt(sm, leaf);
    if (!end || (end.type === 'message' && end.message.role === 'user')) return 'bad_message';
    const moved = await holding(msg.chatId, async () => {
      const nav = await session.navigateTree(leaf).catch(() => ({ cancelled: true }));
      if (nav.cancelled) return false;
      sm.appendCustomEntry(LEAF_MARK, {});
      return true;
    });
    if (!moved) return 'failed';
    join(msg.chatId, session);
    notify(msg.chatId, await chatState(r, session, true));
    reindex(deps, msg.chatId, session);
    return undefined;
  };

  /**
   * The real text and the images of a stored user entry, to prompt again (`user.retry`,
   * `chat.fork`). The session keeps masked text and the input hook masks again, so the text is
   * restored first. Undefined while the sidecar is down.
   */
  const resend = async (entry: UserEntry) => {
    let down = false;
    const { text } = await restorer(pseudo, () => {
      down = true;
    })(textOf(entry.message));
    if (down) return undefined;
    const { content } = entry.message;
    const images =
      typeof content === 'string' ? [] : content.flatMap((b) => (b.type === 'image' ? [b] : []));
    return { text, images };
  };

  /**
   * Prompts `sent` in `chatId`; a failure tells the room `prompt_failed` and resolves false. The
   * stored entry goes to this socket as `localId` (`message.accepted`).
   */
  const promptOrFail = (chatId: string, session: AgentSession, sent: Sent, localId?: string) => {
    const { preflightResult, failed } = accept(chatId, session, localId);
    return session.prompt(sent.text, { images: sent.images, preflightResult }).then(
      () => true,
      (err: unknown) => {
        failed();
        log.warn({ chatId, err }, 'prompt failed');
        broadcast(rooms, chatId, errorMsg('prompt_failed', chatId));
        return false;
      },
    );
  };

  /** Tracks a prompt of `chatId`; its stored user entry goes to this socket as `localId`. */
  const accept = (chatId: string, session: AgentSession, localId: string | undefined) =>
    trackAccept(
      session,
      localId
        ? (messageId) => {
            try {
              send(socket, { type: 'message.accepted', chatId, localId, messageId });
            } catch {}
          }
        : undefined,
    );

  /** Rewinds the branch to before `last` and prompts its text again (under `retry`'s hold). */
  const rerun = async (
    chatId: string,
    session: AgentSession,
    last: UserEntry,
    localId?: string,
  ) => {
    const leaf = session.sessionManager.getLeafId();
    const sent = await resend(last);
    if (!sent) return 'pseudo_down';
    return rewindAndPrompt(chatId, session, last, sent, leaf, localId);
  };

  /**
   * Rewinds the branch to before `last` and prompts `sent` there (`user.retry`, `chat.edit`, under
   * the caller's hold). `leaf` is the leaf before the caller's await.
   */
  const rewindAndPrompt = async (
    chatId: string,
    session: AgentSession,
    last: UserEntry,
    sent: Sent,
    leaf: string | null,
    localId?: string,
  ): Promise<Code | undefined> => {
    const sm = session.sessionManager;
    // After the await: a message sent meanwhile moved the leaf or started a run.
    if (sm.getLeafId() !== leaf || !session.isIdle) return 'failed';
    // No reply yet: the leaf is the user entry, and navigating to it is a no-op. Its parent
    // (not another user entry, which navigation would skip) is the point before it.
    const target = leaf === last.id ? last.parentId : last.id;
    const parent = target === null ? undefined : sm.getEntry(target);
    if (
      !target ||
      (leaf === last.id && parent?.type === 'message' && parent.message.role === 'user')
    )
      return 'failed';
    // `failed`, not `prompt_failed`: the branch did not move.
    const nav = await session.navigateTree(target).catch(() => ({ cancelled: true }));
    if (nav.cancelled) return 'failed';
    // The dead branch ran no tool, but an approval may still wait on it.
    approvals.cancel(chatId);
    const rewound = sm.getLeafId();
    join(chatId, session);
    // `prompt_failed` means: the branch was rewound, the client sends the message anew.
    if (!(await promptOrFail(chatId, session, sent, localId))) return undefined;
    // The input hook dropped the text (the sidecar went down after the check above; it already
    // broadcast `pseudo_down`): put the old turn back. A turn without a reply cannot go back,
    // because navigation to a user entry lands on its parent.
    // ponytail: that case loses the turn on the server; the client keeps it and resends.
    if (sm.getLeafId() === rewound && leaf && leaf !== last.id)
      await session.navigateTree(leaf).catch(() => {});
    return undefined;
  };

  /** "Hyväksy automaattisesti" of a chat (phase-21 decision 7); `tools` also while it is off. */
  const autoApproveOf = (r: ChatRow) => {
    return { on: approvals.autoApprove.has(r.id), tools: registry.autoApproveTools(r.agentId) };
  };

  /** `chat.state` of a chat and its session (`chat.open`, `chat.fork`, `chat.version`). */
  const chatState = async (
    r: ChatRow,
    session: AgentSession,
    switched = false,
  ): Promise<ServerMessage> => {
    const restore = restorer(pseudo, () => send(socket, errorMsg('pseudo_down', r.id)));
    const messages = ownUsage(await history(session, threadFiles(db, userId, r), restore), r);
    const link = forkLink(db, userId, r);
    return {
      type: 'chat.state',
      chat: summary(r),
      messages,
      artifacts: messageArtifacts(messages),
      running: registry.running(r.id),
      autoApprove: autoApproveOf(r),
      ...(link ? { forkedFrom: link } : {}),
      ...(memory.claims ? { claims: memory.claims.chips(r.id) } : {}),
      ...(switched ? { switched } : {}),
    };
  };

  /**
   * "Haarauta" (phase-13 decisions 1 to 6): a new chat from the masked session up to the edited user
   * message, copied unchanged, then the edited text as its first turn. The source does not change.
   * Held like `retry`: no policy change starts on the source meanwhile.
   */
  const fork = async (msg: Extract<ClientMessage, { type: 'chat.fork' }>) => {
    const src = owned(msg.chatId);
    const session = await registry.get(msg.chatId);
    // Synchronous from this check to the hold.
    if (registry.running(msg.chatId)) return send(socket, errorMsg('failed', msg.chatId));
    const found = userOnBranch(session, msg.messageId);
    if (!found) return send(socket, errorMsg('bad_message', msg.chatId));
    const { branch, at, edited } = found;
    const code = await holding(msg.chatId, () =>
      forkFrom(src, session, branch, at, edited, msg.text, msg.localId),
    );
    if (code) send(socket, errorMsg(code, msg.chatId));
  };

  /**
   * The edited text to prompt for the user entry at `branch[at]` (`chat.fork`, `chat.edit`): `text`
   * plus the entry's document blocks, with its images (phase-13 decision 6). `pseudo_down` while
   * the sidecar cannot restore the entry.
   */
  const editedPrompt = async (
    src: ChatRow,
    branch: Entry[],
    at: number,
    edited: UserEntry,
    text: string,
  ): Promise<Sent | 'pseudo_down'> => {
    const sent = await resend(edited);
    if (!sent) return 'pseudo_down';
    const before = branch
      .slice(0, at)
      .findLast((e) => e.type === 'message' && e.message.role === 'user');
    const docs = filesOf(
      threadFiles(db, userId, src),
      before?.type === 'message' ? new Date(before.message.timestamp).toISOString() : '',
      new Date(edited.message.timestamp).toISOString(),
    )
      .filter((f) => f.kind === 'document')
      .map((f) => f.name);
    return { ...sent, text: text + sent.text.slice(splitBlocks(sent.text, docs).own.length) };
  };

  const forkFrom = async (
    src: ChatRow,
    session: AgentSession,
    branch: Entry[],
    at: number,
    edited: UserEntry,
    text: string,
    localId?: string,
  ): Promise<Code | undefined> => {
    const sm = session.sessionManager;
    const leaf = sm.getLeafId();
    // Before the edited entry, past its own `pseudo-spans` entry (pi-ext-pseudo's input hook).
    const prev = branch[at - 1];
    const pointAt = prev?.type === 'custom' && prev.customType === 'pseudo-spans' ? at - 2 : at - 1;
    // Only the system prompt and custom entries before it: nothing to copy, the fork starts empty.
    const talk = (e: Entry | undefined) =>
      e?.type === 'message' && (e.message.role === 'user' || e.message.role === 'assistant');
    const point = branch.slice(0, pointAt + 1).some(talk) ? branch[pointAt] : undefined;
    const sent = await editedPrompt(src, branch, at, edited, text);
    if (sent === 'pseudo_down') return sent;
    // After the await: a message sent meanwhile moved the leaf or started a run.
    if (sm.getLeafId() !== leaf || !session.isIdle) return 'failed';
    // The edited message's time: the fork shows the source's files up to it (decision 7).
    const editedAt = new Date(edited.message.timestamp).toISOString();

    let id: string = randomUUID();
    let inserted = false;
    try {
      if (point) {
        // The copy: the masked entries from the root to the fork point, unchanged.
        const file = sm.getSessionFile();
        if (!file) throw new Error('fork source has no file');
        const copy = SessionManager.open(file, registry.sessionDir);
        const out = copy.createBranchedSession(point.id);
        id = copy.getSessionId();
        // A path with a message is always written; without the file the fork would start empty.
        if (!out || !existsSync(out)) throw new Error('fork copy not written');
        // The sidecar must know the copied surrogates, or a tool result masks them again.
        if (pseudo) await pseudo.forkSession(src.id, id, new Date(point.timestamp).toISOString());
      }
      const now = new Date().toISOString();
      const haara = (t: string | null) => (t ? `${t} (haara)` : null);
      const r = db
        .insert(chats)
        .values({
          id,
          userId,
          agentId: src.agentId,
          topicId: src.topicId,
          title: haara(src.title),
          titleMasked: haara(src.titleMasked),
          // A bare OpenRouter id: the prefix comes from `dataPolicy` (phase-10 `piModelId`).
          modelId: src.modelId,
          reasoning: src.reasoning,
          // Consent for `open` was for the source chat only (phase-10 proof 1).
          dataPolicy: 'zdr',
          // The copied replies may hold confidence markers: the modes go on in the fork.
          modes: src.modes,
          sessionPath: src.sessionPath,
          forkedFromChatId: src.id,
          forkedFromMessageId: edited.id,
          forkedAt: editedAt,
          // Phase 17: the copied history is not mined again, and its taint goes with it.
          tainted: src.tainted,
          claimsThrough: point ? (branch.slice(0, pointAt + 1).findLast(talk)?.id ?? null) : null,
          claimsAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      inserted = true;
      const forked = await registry.get(id);
      send(socket, { type: 'chat.created', chat: summary(r) });
      send(socket, await chatState(r, forked));
      join(id, forked);
      registry.hold(id, promptOrFail(id, forked, sent, localId));
      return undefined;
    } catch (err) {
      // Nothing of a half-made fork stays: its row, its file, its sidecar scope.
      if (inserted)
        db.delete(chats)
          .where(and(eq(chats.id, id), eq(chats.userId, userId)))
          .run();
      await registry.remove(id).catch(() => {});
      if (pseudo && point) await pseudo.dropFork(id).catch(() => {});
      if (err instanceof PseudoDownError) return 'pseudo_down';
      log.warn({ chatId: src.id, err }, 'fork failed');
      return 'failed';
    }
  };

  const handle = async (msg: ClientMessage) => {
    switch (msg.type) {
      case 'ping':
        return send(socket, { type: 'pong' });
      case 'chat.create': {
        if (!agents().has(msg.agentId)) throw new NotFound();
        if (msg.topicId) ownTopic(msg.topicId);
        const choice = msg.model ?? { modelId: 'auto', reasoning: 'auto' };
        if (!validChoice(choice) || !knownModes(msg.modes ?? []))
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
        join(id, session);
        send(socket, { type: 'chat.created', chat: summary(r) });
        // No `chat.state` follows for a new chat: the composer chip needs the tool list.
        return send(socket, { type: 'chat.autoApprove', chatId: id, ...autoApproveOf(r) });
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
        send(socket, await chatState(r, session));
        for (const a of approvals.list(msg.chatId)) send(socket, a);
        if (r.summary)
          send(socket, {
            type: 'chat.related',
            chatId: r.id,
            related: related(db, userId, r.id),
          });
        return;
      }
      case 'chat.fork':
        return fork(msg);
      case 'thinking.get': {
        owned(msg.chatId);
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
      case 'usage.get':
        return send(socket, usageMonth(db, userId, msg.month, catalog));
      case 'chat.related':
        owned(msg.chatId);
        return send(socket, {
          type: 'chat.related',
          chatId: msg.chatId,
          related: related(db, userId, msg.chatId),
        });
      case 'search.query':
        return send(socket, {
          type: 'search.results',
          q: msg.q,
          results: await search(db, userId, msg.q, msg.limit, pseudo),
        });
      case 'chat.archive':
        return update(msg.chatId, { archived: msg.archived });
      case 'chat.rename': {
        owned(msg.chatId);
        const titleMasked = pseudo ? (await pseudo.mask(msg.chatId, msg.title)).masked : msg.title;
        return update(msg.chatId, { title: msg.title, titleMasked, titleLocked: true });
      }
      case 'chat.pin':
        return update(msg.chatId, { pinned: msg.pinned });
      // Row first, then the stale session: a message in between already builds from the new row.
      case 'chat.setModel': {
        owned(msg.chatId);
        if (!validChoice(msg)) return send(socket, errorMsg('bad_message'));
        // Also during a run (phase-20 decision 15): the running session ends its turn, and
        // `registry.get` rebuilds it with the new row once it settles.
        // Consent was for one model: a change ends it (phase-10 decision 9).
        refusals.delete(msg.chatId);
        update(msg.chatId, { modelId: msg.modelId, reasoning: msg.reasoning, dataPolicy: 'zdr' });
        await registry.evict(msg.chatId);
        return;
      }
      // Phase-23 decision 6: as `chat.setModel`, also during a run; the next turn has the prompt.
      case 'chat.setModes':
        owned(msg.chatId);
        if (!knownModes(msg.modes)) return send(socket, errorMsg('bad_message', msg.chatId));
        update(msg.chatId, { modes: [...new Set(msg.modes)] });
        await registry.evict(msg.chatId);
        return;
      // Also during a run: the next tool call reads it; an open card stays open.
      case 'chat.setAutoApprove': {
        const r = owned(msg.chatId);
        // A running automation keeps its own `autoApprove` list (phase-14 decision 9).
        if (approvals.unattended.has(msg.chatId))
          return send(socket, errorMsg('bad_message', msg.chatId));
        if (msg.on) approvals.autoApprove.add(msg.chatId);
        else approvals.autoApprove.delete(msg.chatId);
        return notify(msg.chatId, { type: 'chat.autoApprove', chatId: r.id, ...autoApproveOf(r) });
      }
      case 'chat.setDataPolicy': {
        const r = owned(msg.chatId);
        if (
          msg.dataPolicy === 'open' &&
          (r.modelId === null || refusals.get(msg.chatId) !== r.modelId)
        )
          return send(socket, errorMsg('bad_message'));
        assertIdle(msg.chatId);
        update(msg.chatId, { dataPolicy: msg.dataPolicy });
        await registry.evict(msg.chatId);
        return;
      }
      case 'models.list':
        return send(socket, modelsState());
      case 'models.favorite':
        if (msg.favorite) {
          if (!catalog.get(msg.modelId)) return send(socket, errorMsg('bad_message'));
          db.insert(modelFavorites)
            .values({ userId, modelId: msg.modelId, createdAt: new Date().toISOString() })
            .onConflictDoNothing()
            .run();
        } else
          db.delete(modelFavorites)
            .where(and(eq(modelFavorites.userId, userId), eq(modelFavorites.modelId, msg.modelId)))
            .run();
        // Other screens read the favourites at their next `models.list`.
        return send(socket, modelsState());
      case 'chat.delete': {
        const { chatId } = msg;
        const deleted = owned(chatId);
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
            log.warn(
              { chatId, error: err instanceof Error ? err.message : 'unknown' },
              'remove failed',
            ),
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
            log.warn(
              { chatId, error: err instanceof Error ? err.message : 'unknown' },
              'rm failed',
            );
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
        return toAll({ type: 'chat.deleted', chatId });
      }
      case 'chat.focus':
        return push.setFocus(socket, msg.chatId);
      case 'push.subscribe':
        if (!push.enabled) return send(socket, errorMsg('not_implemented'));
        try {
          return push.subscribe(msg.subscription);
        } catch (err) {
          if (err instanceof BadSubscription) return send(socket, errorMsg('bad_message'));
          throw err;
        }
      case 'user.message': {
        // `msg.agentId` is ignored: an existing chat keeps its agent (decision 1). No await
        // between `registry.get` and `hold`: a policy change (a socket message) cannot run in
        // between, and a stale session is rebuilt inside `get`.
        const { chatId } = msg;
        owned(chatId);
        // A held message comes first (phase-12 decision 8): nothing may run ahead of it.
        if (collisions.held(chatId)) return send(socket, errorMsg('held', chatId));
        const { images, text } = await ingestAttachments(
          db,
          { dataDir, warn: (m, data) => log.warn(data ?? {}, m) },
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
        const { preflightResult, failed } = accept(chatId, session, msg.localId);
        // Held from the call on: a policy change must wait for this prompt (`assertIdle`).
        registry.hold(
          chatId,
          session
            .prompt(msg.text + text, { streamingBehavior: 'steer', images, preflightResult })
            .catch((err: unknown) => {
              failed();
              log.warn({ chatId, err }, 'prompt failed');
              broadcast(rooms, chatId, errorMsg('prompt_failed', chatId));
            }),
        );
        return;
      }
      case 'user.retry':
      case 'chat.edit':
      case 'chat.version': {
        if (collisions.held(msg.chatId)) return send(socket, errorMsg('held', msg.chatId));
        const run =
          msg.type === 'user.retry'
            ? retry(msg.chatId, msg.localId)
            : msg.type === 'chat.edit'
              ? edit(msg)
              : version(msg);
        // Every refusal names the chat: the client then keeps its thread as it was.
        const code = await run.catch((err: unknown) => {
          if (err instanceof NotFound || err instanceof ChatNotFound) return 'not_found' as const;
          log.warn({ chatId: msg.chatId, err }, `${msg.type} failed`);
          return 'failed' as const;
        });
        if (code) send(socket, errorMsg(code, msg.chatId));
        return;
      }
      case 'approval.respond': {
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
      case 'user.stop':
        owned(msg.chatId);
        collisions.cancel(msg.chatId); // a message held by a collision is dropped
        if (registry.has(msg.chatId)) await (await registry.get(msg.chatId)).abort();
        return;
      case 'automations.list':
        return send(
          socket,
          deps.automations()?.state() ?? { type: 'automations.state', automations: [] },
        );
      case 'automations.run':
        if (!deps.automations()?.runNow(msg.id)) throw new NotFound();
        return send(socket, deps.automations()?.state() ?? errorMsg('failed'));
      case 'topic.list':
        return send(socket, topicState(db, userId));
      case 'topic.accept': {
        let topicId = msg.mergeIntoTopicId;
        if (topicId) ownTopic(topicId);
        const p = resolveProposal(msg.proposalId, 'accepted');
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
        update(p.chatId, { topicId });
        return notify(p.chatId, topicState(db, userId));
      }
      case 'topic.reject':
        resolveProposal(msg.proposalId, 'rejected');
        return send(socket, topicState(db, userId));
      case 'memory.list':
        return send(socket, memory.state());
      case 'claims.list':
        return memory.claims
          ? send(socket, memory.claims.state())
          : send(socket, errorMsg('not_implemented'));
      case 'claims.review':
      case 'claims.update':
      case 'claims.stale': {
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
        memoryToAll();
        return toAll(c.state());
      }
      case 'memory.edit':
        memory.edit(msg.target, msg.text);
        return memoryToAll();
      case 'memory.approve': {
        const status = await memory.approve(msg.pendingId, msg.approve);
        if (!status) throw new NotFound();
        // A failed write leaves the queue; this is its only report.
        if (status === 'failed') send(socket, errorMsg('memory_conflict'));
        return memoryToAll();
      }
      case 'memory.consolidate':
        await memory.consolidate();
        return memoryToAll();
      case 'vault.list':
      case 'vault.merge':
      case 'vault.split':
      case 'vault.pin':
      case 'vault.allowlist':
      case 'vault.regenerate':
      case 'vault.neverDetect':
      case 'vault.setMode':
      case 'vault.pending.resolve':
        return vault(msg);
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
      if (
        err instanceof NotFound ||
        err instanceof AttachmentNotFound ||
        err instanceof ChatNotFound
      )
        return send(socket, errorMsg('not_found'));
      if (err instanceof PseudoDownError) return send(socket, errorMsg('pseudo_down'));
      if (err instanceof RunActive) return send(socket, errorMsg('failed'));
      if (err instanceof MemoryError)
        return send(
          socket,
          errorMsg(
            err.message === FULL
              ? 'memory_full'
              : err.message === GENERATED
                ? 'memory_generated'
                : 'memory_conflict',
          ),
        );
      log.warn({ err, type: parsed.data.type }, 'client message failed');
      send(socket, errorMsg('failed'));
    });
  });

  socket.on('close', () => {
    sockets.delete(socket);
    push.setFocus(socket, null);
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

const hasToolCall = (m: AgentMessage) =>
  m.role === 'assistant' && m.content.some((b) => b.type === 'toolCall');

/**
 * The user entry of the branch's last turn when that turn can run again in place (`user.retry`):
 * it starts a turn (a steer follows a tool result), and after it come only assistant errors
 * without tool calls, or nothing yet. A turn with tool calls would run them again.
 */
function failedTurn(session: AgentSession): UserEntry | undefined {
  const messages = session.sessionManager
    .getBranch()
    .flatMap((e) => (e.type === 'message' ? [e] : []));
  const at = messages.findLastIndex((e) => e.message.role === 'user');
  const last = messages[at];
  if (!last || last.message.role !== 'user') return undefined;
  const prev = messages[at - 1]?.message;
  if (prev && (prev.role === 'toolResult' || hasToolCall(prev))) return undefined;
  const after = messages.slice(at + 1).map((e) => e.message);
  if (after.some((m) => m.role !== 'assistant' || hasToolCall(m))) return undefined;
  const reply = after.at(-1);
  if (reply?.role === 'assistant' && reply.stopReason !== 'error') return undefined;
  return last as UserEntry;
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
