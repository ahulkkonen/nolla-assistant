/**
 * The WebSocket bridge: parses each client frame with the protocol schema, dispatches it by type
 * to a handler in bridge/*.ts (or one direct service call), and maps the errors a handler throws
 * to an error frame. Attach and close go through bridge/connection.ts.
 *
 * It must hold no business logic and no state: a new frame type gets a handler module, not a
 * branch here. No other module imports helpers from this file.
 */
import { FULL } from '@nolla/pi-ext-memory';
import { PseudoDownError } from '@nolla/pi-ext-pseudo';
import { ClientMessage } from '@nolla/protocol';
import { respond, setAutoApprove } from './bridge/approvals.ts';
import {
  archiveChat,
  createChat,
  deleteChat,
  listChats,
  openChat,
  pinChat,
  relatedChats,
  renameChat,
  setDataPolicy,
  setModel,
  setModes,
  thinkingText,
} from './bridge/chats.ts';
import { type BridgeDeps, connect, disconnect } from './bridge/connection.ts';
import {
  claimsChange,
  claimsList,
  memoryApprove,
  memoryConsolidate,
  memoryEdit,
} from './bridge/memory.ts';
import { favorite, modelsState } from './bridge/models.ts';
import { acceptTopic, rejectTopic } from './bridge/topics.ts';
import { fork, moveBranch, stop, userMessage } from './bridge/turns.ts';
import { vault } from './bridge/vault.ts';
import { AttachmentNotFound } from './files.ts';
import { GENERATED, MemoryError } from './memory.ts';
import { ChatNotFound } from './pi/registry.ts';
import { BadSubscription } from './push.ts';
import { search } from './search.ts';
import { errorMsg, NotFound, RunActive, type Socket, send } from './socket.ts';
import { topicState } from './topics.ts';
import { usageMonth } from './usage.ts';

export function attachBridge(socket: Socket, deps: BridgeDeps) {
  const { db, userId, log, pseudo, memory, push, catalog } = deps;
  const conn = connect(socket, deps);

  const handle = async (msg: ClientMessage) => {
    switch (msg.type) {
      case 'ping':
        return send(socket, { type: 'pong' });
      case 'chat.create':
        return createChat(conn, msg);
      case 'chat.list':
        return listChats(conn, msg);
      case 'chat.open':
        return openChat(conn, msg);
      case 'chat.fork':
        return fork(conn, msg);
      case 'thinking.get':
        return thinkingText(conn, msg);
      case 'usage.get':
        return send(socket, usageMonth(db, userId, msg.month, catalog));
      case 'chat.related':
        return relatedChats(conn, msg);
      case 'search.query':
        return send(socket, {
          type: 'search.results',
          q: msg.q,
          results: await search(db, userId, msg.q, msg.limit, pseudo),
        });
      case 'chat.archive':
        return archiveChat(conn, msg);
      case 'chat.rename':
        return renameChat(conn, msg);
      case 'chat.pin':
        return pinChat(conn, msg);
      case 'chat.setModel':
        return setModel(conn, msg);
      case 'chat.setModes':
        return setModes(conn, msg);
      case 'chat.setAutoApprove':
        return setAutoApprove(conn, msg);
      case 'chat.setDataPolicy':
        return setDataPolicy(conn, msg);
      case 'models.list':
        return send(socket, modelsState(conn));
      case 'models.favorite':
        return favorite(conn, msg);
      case 'chat.delete':
        return deleteChat(conn, msg);
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
      case 'user.message':
        return userMessage(conn, msg);
      case 'user.retry':
      case 'chat.edit':
      case 'chat.version':
        return moveBranch(conn, msg);
      case 'approval.respond':
        return respond(conn, msg);
      case 'user.stop':
        return stop(conn, msg);
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
      case 'vault.add':
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
