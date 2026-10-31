import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { type AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { chats, files } from '@pa/db';
import { FULL } from '@pa/pi-ext-memory';
import { PseudoDownError } from '@pa/pi-ext-pseudo';
import { ClientMessage, type ServerMessage } from '@pa/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { messageArtifacts } from './artifacts.ts';
import { trackAccept } from './bridge/accept.ts';
import { autoApproveOf, respond, setAutoApprove } from './bridge/approvals.ts';
import {
  type BridgeDeps,
  connect,
  disconnect,
  notify,
  owned,
  toAll,
  update,
} from './bridge/connection.ts';
import {
  claimsChange,
  claimsList,
  memoryApprove,
  memoryConsolidate,
  memoryEdit,
} from './bridge/memory.ts';
import { favorite, modelsState, validChoice } from './bridge/models.ts';
import { join, reindex } from './bridge/stream.ts';
import { acceptTopic, ownTopic, rejectTopic } from './bridge/topics.ts';
import { vault } from './bridge/vault.ts';
import { type ChatRow, forkLink, ownUsage, summary, threadFiles } from './chats.ts';
import { AttachmentNotFound, ingestAttachments, splitBlocks } from './files.ts';
import { filesOf, history } from './history.ts';
import { GENERATED, MemoryError } from './memory.ts';
import { AUTO_MODEL } from './pi/models.ts';
import { ChatNotFound } from './pi/registry.ts';
import { BadSubscription } from './push.ts';
import { restorer } from './restore.ts';
import { related, search } from './search.ts';
import { type AgentMessage, cutText, textOf, thinkingOf } from './session-text.ts';
import {
  broadcast,
  type Code,
  errorMsg,
  NotFound,
  RunActive,
  type Socket,
  send,
} from './socket.ts';
import { topicState } from './topics.ts';
import { usageMonth } from './usage.ts';
import { childrenOf, conversationAt, LEAF_MARK, newestLeaf, versionsOf } from './versions.ts';

type Entry = ReturnType<AgentSession['sessionManager']['getBranch']>[number];
type UserEntry = Extract<Entry, { type: 'message' }> & { message: { role: 'user' } };
/** A prompt to send: real text (the input hook masks it) and images. */
type Sent = {
  text: string;
  images: Extract<Extract<UserEntry['message']['content'], unknown[]>[number], { type: 'image' }>[];
};

/** `thinking.get` cuts at most here, before the restore. */
const THINKING_MAX = 50_000;

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
    memory,
    push,
    catalog,
    refusals,
    collisions,
  } = deps;
  const conn = connect(socket, deps);

  const knownModes = (ids: string[]) => ids.every((id) => modes().has(id));

  /**
   * A data-policy change needs an idle chat (decision 14; phase-20 decision 15 lets a model
   * change through). Synchronous, like the row write after it: no prompt can start between the
   * check and the write.
   */
  const assertIdle = (chatId: string) => {
    if (registry.running(chatId)) throw new RunActive();
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
    owned(conn, chatId);
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
    const src = owned(conn, msg.chatId);
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
    const r = owned(conn, msg.chatId);
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
    join(conn, msg.chatId, session);
    notify(conn, msg.chatId, await chatState(r, session, true));
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
    join(conn, chatId, session);
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
      autoApprove: autoApproveOf(conn, r),
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
    const src = owned(conn, msg.chatId);
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
      join(conn, id, forked);
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
        if (msg.topicId) ownTopic(conn, msg.topicId);
        const choice = msg.model ?? { modelId: 'auto', reasoning: 'auto' };
        if (!validChoice(conn, choice) || !knownModes(msg.modes ?? []))
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
        const r = owned(conn, msg.chatId);
        const session = await registry.get(msg.chatId);
        join(conn, msg.chatId, session);
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
      case 'usage.get':
        return send(socket, usageMonth(db, userId, msg.month, catalog));
      case 'chat.related':
        owned(conn, msg.chatId);
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
        return update(conn, msg.chatId, { archived: msg.archived });
      case 'chat.rename': {
        owned(conn, msg.chatId);
        const titleMasked = pseudo ? (await pseudo.mask(msg.chatId, msg.title)).masked : msg.title;
        return update(conn, msg.chatId, { title: msg.title, titleMasked, titleLocked: true });
      }
      case 'chat.pin':
        return update(conn, msg.chatId, { pinned: msg.pinned });
      // Row first, then the stale session: a message in between already builds from the new row.
      case 'chat.setModel': {
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
      // Phase-23 decision 6: as `chat.setModel`, also during a run; the next turn has the prompt.
      case 'chat.setModes':
        owned(conn, msg.chatId);
        if (!knownModes(msg.modes)) return send(socket, errorMsg('bad_message', msg.chatId));
        update(conn, msg.chatId, { modes: [...new Set(msg.modes)] });
        await registry.evict(msg.chatId);
        return;
      case 'chat.setAutoApprove':
        return setAutoApprove(conn, msg);
      case 'chat.setDataPolicy': {
        const r = owned(conn, msg.chatId);
        if (
          msg.dataPolicy === 'open' &&
          (r.modelId === null || refusals.get(msg.chatId) !== r.modelId)
        )
          return send(socket, errorMsg('bad_message'));
        assertIdle(msg.chatId);
        update(conn, msg.chatId, { dataPolicy: msg.dataPolicy });
        await registry.evict(msg.chatId);
        return;
      }
      case 'models.list':
        return send(socket, modelsState(conn));
      case 'models.favorite':
        return favorite(conn, msg);
      case 'chat.delete': {
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
        return toAll(conn, { type: 'chat.deleted', chatId });
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
        owned(conn, chatId);
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
        join(conn, chatId, session);
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
      case 'approval.respond':
        return respond(conn, msg);
      case 'user.stop':
        owned(conn, msg.chatId);
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
      case 'topic.accept':
        return acceptTopic(conn, msg);
      case 'topic.reject':
        return rejectTopic(conn, msg);
      case 'memory.list':
        return send(socket, memory.state());
      case 'claims.list':
        return claimsList(conn);
      case 'claims.review':
      case 'claims.update':
      case 'claims.stale':
        return claimsChange(conn, msg);
      case 'memory.edit':
        return memoryEdit(conn, msg);
      case 'memory.approve':
        return memoryApprove(conn, msg);
      case 'memory.consolidate':
        return memoryConsolidate(conn);
      case 'vault.list':
      case 'vault.merge':
      case 'vault.split':
      case 'vault.pin':
      case 'vault.allowlist':
      case 'vault.regenerate':
      case 'vault.neverDetect':
      case 'vault.setMode':
      case 'vault.pending.resolve':
        return vault(conn, msg);
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

  socket.on('close', () => disconnect(conn));
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
