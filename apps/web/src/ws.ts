import {
  type AttachmentRef,
  type ClientMessageInput,
  type DataPolicy,
  type ModelPolicy,
  ServerMessage,
} from '@nolla/protocol';
import { HttpError, me } from './api.ts';
import {
  type ClaimChip,
  ERROR_TEXT,
  serverIdOf,
  shift,
  thinkingKey,
  useStore,
  VERSION_FAILED,
} from './store.ts';

let ws: WebSocket | null = null;
let url = '';
let queue: string[] = [];
let backoff = 500;
let stopped = true;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Pending `chat.create` calls, oldest first: `chat.created` or an error answers in send order.
 * `reject(true)`: signed out, the text goes nowhere.
 */
let createWaiters: Array<{ resolve: (chatId: string) => void; reject: (drop?: boolean) => void }> =
  [];
/**
 * The codes a refused `chat.create` sends (server `handle`: agent or topic lookup, model and
 * modes check, session build). They name no chat, so they answer the oldest pending create; an
 * error of another request with one of these codes still can (phase-30 item 8: a `localId` echo
 * is the follow-up).
 */
const CREATE_REFUSALS = new Set(['bad_message', 'not_found', 'failed', 'pseudo_down']);
let forkTimer: ReturnType<typeof setTimeout> | undefined;
let versionTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * A data-policy change sent from this client, until its `chat.updated` confirms it. For `open`,
 * `turnId` is the refused turn's user message: the consent retries that turn and no newer one.
 */
let policyIntent: { chatId: string; dataPolicy: DataPolicy; turnId?: string } | null = null;
/**
 * A `user.retry` or a `chat.edit` (phase-24 decision 8) sent, until the run starts (the local
 * thread rewinds then) or is refused. `turnId`: the message run again or edited. `edit`: the new
 * version's local id, text and the edited message's version count.
 */
let retryIntent: {
  chatId: string;
  turnId: string;
  edit?: { localId: string; text: string; count: number };
} | null = null;
/**
 * Phase 24: the chat of an edit that ran. Its idle asks for the chat's state, so the versions
 * shown are the server's and a version guessed here cannot stay.
 */
let editRefresh: string | null = null;
/**
 * Every pending `chat.create` fails: its text goes back to the composer (`sendUserMessage`),
 * unless `drop` (a sign-out). A create still in the queue is never sent: its chat would have no
 * waiter, and its `chat.created` would answer the next create.
 */
const failCreates = (drop = false) => {
  const waiters = createWaiters;
  createWaiters = [];
  queue = queue.filter((data) => (JSON.parse(data) as { type: string }).type !== 'chat.create');
  for (const w of waiters) w.reject(drop);
};
/** The pending retry or edit is over: its edit box stops waiting. */
const endRetry = () => {
  retryIntent = null;
  if (useStore.getState().pendingEdit) useStore.setState({ pendingEdit: null });
};
// A chat switch drops the consent: its retry runs only in the chat on screen.
useStore.subscribe((s, prev) => {
  // A fork that settled (its state, an error, a switch, a close): its timeout goes too.
  if (prev.pendingFork && !s.pendingFork) clearTimeout(forkTimer);
  if (prev.pendingVersion && !s.pendingVersion) clearTimeout(versionTimer);
  if (s.activeChatId === prev.activeChatId) return;
  policyIntent = null;
  // Another chat than the source or the new fork: the fork's answer has no screen to land on.
  const fork = s.pendingFork;
  if (fork && s.activeChatId !== fork.chatId && s.activeChatId !== fork.forkId)
    useStore.setState({ pendingFork: null });
});

const lastUser = (chatId: string) => {
  const messages = useStore.getState().messages[chatId] ?? [];
  const i = messages.findLastIndex((m) => m.role === 'user');
  return { messages, i, last: messages[i] };
};

const defaultUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export function connect(to = defaultUrl()) {
  if (!stopped) return;
  url = to;
  stopped = false;
  open();
}

export function disconnect() {
  stopped = true;
  policyIntent = null;
  endRetry();
  editRefresh = null;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  failCreates(true);
  queue = [];
  // Phase 27: deltas still waiting for their frame never land after a sign-out's wipe.
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  deltas = [];
  ws?.close();
  ws = null;
}

/**
 * Signed out (Kirjaudu ulos, or this session revoked: socket close 4401): no socket and nothing of
 * the user left in memory. The device's own settings (theme, speech, thinking view, N) stay.
 */
export function signedOut() {
  disconnect();
  const s = useStore.getState();
  useStore.setState({
    ...useStore.getInitialState(),
    auth: 'out',
    theme: s.theme,
    sttAutoSend: s.sttAutoSend,
    sttLanguage: s.sttLanguage,
    showThinking: s.showThinking,
    showConfN: s.showConfN,
    sidebarOpen: s.sidebarOpen,
  });
}

export function send(msg: ClientMessageInput) {
  const data = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else queue.push(data);
}

/**
 * A claim action (phase 17): its card waits until the next `claims.state` or an error. `undo`:
 * the chip a "Kumoa" hid, restored when the reject fails.
 */
export function claimSend(
  msg: Extract<ClientMessageInput, { type: 'claims.review' | 'claims.update' | 'claims.stale' }>,
  undo?: { chatId: string; chip: ClaimChip },
) {
  useStore.setState({ claimAction: { id: msg.id, ...(undo ? { undo } : {}) }, claimError: null });
  send(msg);
}

/** Shows the search screen and runs a full-text search for `q`. */
export function runSearch(q: string) {
  useStore.setState({ search: { q, results: null }, screen: 'search' });
  send({ type: 'search.query', q });
}

/** Opens a chat (sidebar, search hit, related chip); `messageId` is scrolled into view. */
export function openChat(chatId: string, messageId?: string | null) {
  useStore.setState({ activeChatId: chatId, screen: 'chat', scrollTo: messageId ?? null });
  send({ type: 'chat.open', chatId });
}

/**
 * Sends `chat.create` with the picked agent, model and modes (phase-23 decision 8: unset modes are
 * the agent's default); resolves with the id from the next `chat.created`. Rejects on the next
 * error without a chat (a refused create never names one) or when the socket closes.
 */
export function createChat(): Promise<string> {
  return new Promise((resolve, reject) => {
    createWaiters.push({ resolve, reject });
    const st = useStore.getState();
    // A mode deleted since the toggle would refuse the whole create.
    const modes = st.pendingModes?.filter((id) => st.modes.some((m) => m.id === id));
    send({
      type: 'chat.create',
      agentId: st.pendingAgentId,
      model: st.pendingModel,
      ...(modes ? { modes } : {}),
    });
  });
}

/**
 * Shows the message at once (the server does not echo it) and sends it to `chatId`, else to the
 * open chat; creates the chat if needed. Not while an edit of that chat is on its way (phase 24):
 * the composer waits, and nothing is sent.
 */
export async function sendUserMessage(
  text: string,
  attachments: AttachmentRef[] = [],
  chatId: string | null = useStore.getState().activeChatId,
) {
  if (chatId && useStore.getState().pendingEdit?.chatId === chatId) return;
  let id = chatId;
  try {
    id ??= await createChat();
  } catch (drop) {
    // No chat: the text and files go back to the new-chat composer; the error toast says why.
    // After a sign-out they go nowhere: the next user must not see them.
    if (!drop) useStore.setState({ draft: { chatId: null, text, attachments } });
    return;
  }
  // A new turn ends a pending consent or retry of its chat: neither may act on it.
  if (policyIntent?.chatId === id) policyIntent = null;
  if (retryIntent?.chatId === id) endRetry();
  const localId = `local-${crypto.randomUUID()}`;
  useStore.getState().addLocalMessage(id, {
    id: localId,
    role: 'user',
    text,
    annotations: [],
    attachments,
    tools: [],
    createdAt: new Date().toISOString(),
  });
  // `message.accepted` gives the message its entry id (a fork needs it).
  send({ type: 'user.message', chatId: id, text, attachments, localId });
}

/** "Pysäytä" and Esc: the chat's queued message goes back to the composer (phase-20 decision 17). */
export function stopTurn(chatId: string) {
  useStore.getState().unqueue(chatId);
  send({ type: 'user.stop', chatId });
}

/**
 * Decision 17: the chat's queued message starts a new turn once the reply has ended: on its idle
 * status, or on a `chat.state` that says it is not running (an idle missed while offline).
 */
function sendQueued(msg: ServerMessage) {
  const chatId =
    msg.type === 'agent.status' ? msg.chatId : msg.type === 'chat.state' ? msg.chat.id : null;
  const st = useStore.getState();
  if (!chatId || st.agentStatus[chatId] === 'running') return;
  const q = st.takeQueued(chatId);
  if (q) void sendUserMessage(q.text, q.attachments, chatId);
}

/**
 * The failed-reply alert's "Yritä uudelleen" and the ZDR consent. A failed turn without tool
 * rows runs again in place (`user.retry`), so the thread shows its message once; the thread
 * rewinds when the server starts the rerun and stays as it is when the server refuses. A
 * message that never reached the session (`prompt_failed`, the server branch already went back)
 * or a turn that ran tools (a rerun would run them again) is sent again as a new message.
 */
export function retryTurn(chatId: string) {
  const st = useStore.getState();
  const { messages, i, last } = lastUser(chatId);
  // An edit on its way owns the chat's next run (phase 24).
  if (!last || st.pendingEdit?.chatId === chatId) return;
  const inPlace =
    st.failed[chatId]?.code !== 'prompt_failed' &&
    messages.slice(i + 1).every((m) => !m.tools.length);
  // The kept message becomes a new entry: a fresh local id, and its old entry id (off the branch
  // after the rewind) goes; `message.accepted` brings the new one.
  const localId = `local-${crypto.randomUUID()}`;
  st.relocal(chatId, last.id, localId);
  if (inPlace) {
    retryIntent = { chatId, turnId: localId };
    return send({ type: 'user.retry', chatId, localId });
  }
  st.rewind(chatId, i + 1);
  send({ type: 'user.message', chatId, text: last.text, attachments: last.attachments, localId });
}

/** How long a fork may take before the edit box gives up and says so. */
const FORK_TIMEOUT_MS = 20_000;
/** How long a thinking text may load before its row shows the error. */
const THINKING_TIMEOUT_MS = 15_000;

/**
 * "Haarauta" (phase-13 decision 1): a new chat from the edited user message `messageId` (its
 * entry id); this chat does not change. One fork at a time: a second one waits for the first's
 * `chat.state` or error. A fork that never answers ends after 20 s with the error toast.
 */
export function forkChat(chatId: string, messageId: string, text: string) {
  if (useStore.getState().pendingFork) return;
  const localId = `local-${crypto.randomUUID()}`;
  useStore.setState({ pendingFork: { chatId, messageId, text, localId } });
  send({ type: 'chat.fork', chatId, messageId, text, localId });
  clearTimeout(forkTimer);
  forkTimer = setTimeout(() => {
    if (useStore.getState().pendingFork?.localId !== localId) return;
    useStore.setState({ pendingFork: null });
    useStore.getState().pushError('Haarautus epäonnistui. Yritä uudelleen.');
  }, FORK_TIMEOUT_MS);
}

/**
 * "Lähetä" in the edit box (phase-24 decision 8): a new version of the user message `messageId`
 * (its entry id) in this chat. The box waits; the thread rewinds when the run starts, and a
 * refusal keeps the box with its text.
 */
export function editMessage(chatId: string, messageId: string, text: string) {
  const st = useStore.getState();
  const m = st.messages[chatId]?.find((x) => serverIdOf(x) === messageId);
  if (st.pendingEdit || !m) return;
  const localId = `local-${crypto.randomUUID()}`;
  retryIntent = { chatId, turnId: m.id, edit: { localId, text, count: m.versions?.count ?? 1 } };
  useStore.setState({ pendingEdit: { chatId, text } });
  send({ type: 'chat.edit', chatId, messageId, text, localId });
}

/**
 * "‹ ›" (phase-24 decision 9): shows version `index` of the user message `messageId` (entry id).
 * A switch that never answers ends after 20 s with the error toast.
 */
export function switchVersion(chatId: string, messageId: string, index: number) {
  if (useStore.getState().pendingVersion) return;
  const pending = { chatId, messageId };
  useStore.setState({ pendingVersion: pending });
  send({ type: 'chat.version', chatId, messageId, index });
  clearTimeout(versionTimer);
  versionTimer = setTimeout(() => {
    if (useStore.getState().pendingVersion !== pending) return;
    useStore.setState({ pendingVersion: null });
    useStore.getState().pushError(VERSION_FAILED);
  }, FORK_TIMEOUT_MS);
}

/** Thinking rows of `chatId` (or all) that still load: they show the error, a new open asks again. */
function failThinking(chatId?: string) {
  useStore.setState((s) => ({
    thinkingText: Object.fromEntries(
      Object.entries(s.thinkingText).map(([k, t]) =>
        t.state === 'loading' && (!chatId || t.chatId === chatId)
          ? [k, { chatId: t.chatId, state: 'error' as const }]
          : [k, t],
      ),
    ),
  }));
}

/** Opens a thinking row: its text loads once (`thinking.get`); after an error, again. */
export function loadThinking(chatId: string, messageId: string) {
  const key = thinkingKey(chatId, messageId);
  useStore.setState((s) => ({
    thinkingText: { ...s.thinkingText, [key]: { chatId, state: 'loading' } },
  }));
  send({ type: 'thinking.get', chatId, messageId });
  setTimeout(() => {
    if (useStore.getState().thinkingText[key]?.state !== 'loading') return;
    useStore.setState((s) => ({
      thinkingText: { ...s.thinkingText, [key]: { chatId, state: 'error' } },
    }));
  }, THINKING_TIMEOUT_MS);
}

/**
 * Rewinds the thread on the rerun's first event; a refusal (an error for the chat) keeps it. An
 * edit rewinds to before its message and adds the new version (phase-24 decision 8); equal text
 * is the same version (decision 1). The edit's idle asks for the chat's state (`editRefresh`).
 */
function settleRetry(msg: ServerMessage) {
  if (msg.type === 'agent.status' && msg.state === 'idle' && msg.chatId === editRefresh) {
    editRefresh = null;
    send({ type: 'chat.open', chatId: msg.chatId });
  }
  const intent = retryIntent;
  if (!intent || !('chatId' in msg) || msg.chatId !== intent.chatId) return;
  // A held edit that the user dropped never runs (its box keeps the text).
  if (msg.type === 'error' || (msg.type === 'chat.released' && msg.outcome === 'dropped'))
    endRetry();
  if (msg.type !== 'agent.status' || msg.state !== 'running') return;
  endRetry();
  const st = useStore.getState();
  const at = (st.messages[intent.chatId] ?? []).findIndex((m) => m.id === intent.turnId);
  const old = st.messages[intent.chatId]?.[at];
  if (!old) return;
  if (!intent.edit) return st.rewind(intent.chatId, at + 1);
  const { localId, text, count } = intent.edit;
  editRefresh = intent.chatId;
  const versions =
    text.trim() === old.text.trim() ? old.versions : { index: count + 1, count: count + 1 };
  st.rewind(intent.chatId, at);
  st.addLocalMessage(intent.chatId, {
    id: localId,
    role: 'user',
    text,
    annotations: [],
    // The edited turn keeps the original images and documents (server `editedPrompt`).
    attachments: old.attachments,
    tools: [],
    createdAt: new Date().toISOString(),
    ...(versions ? { versions } : {}),
  });
  // The edit box goes with the old message: the focus goes to the composer, as after a send.
  globalThis.document?.getElementById('composer')?.focus();
}

/** The consent ("open", then the retry) or "Palauta ZDR"; both act on the server's confirmation. */
export function setDataPolicy(chatId: string, dataPolicy: DataPolicy) {
  const turnId = dataPolicy === 'open' ? lastUser(chatId).last?.id : undefined;
  policyIntent = { chatId, dataPolicy, ...(turnId ? { turnId } : {}) };
  send({ type: 'chat.setDataPolicy', chatId, dataPolicy });
}

/** Acts once on the `chat.updated` that confirms the intent; a model change or an error drops it. */
function settlePolicy(msg: ServerMessage, was: ModelPolicy | undefined) {
  const intent = policyIntent;
  if (!intent) return;
  if (msg.type === 'error') {
    if (!msg.chatId || msg.chatId === intent.chatId) policyIntent = null;
    return;
  }
  if (msg.type !== 'chat.updated' || msg.chat.id !== intent.chatId) return;
  const now = msg.chat.modelPolicy;
  // No known policy before (not loaded): this update cannot be told from another one.
  if (!was || was.modelId !== now.modelId || was.reasoning !== now.reasoning) {
    policyIntent = null;
    return;
  }
  if (now.dataPolicy !== intent.dataPolicy || was.dataPolicy === now.dataPolicy) return;
  policyIntent = null;
  if (intent.dataPolicy === 'zdr') return useStore.getState().notify('ZDR palautettu');
  // Only the refused turn runs again: a newer one is the user's own.
  if (intent.turnId && lastUser(intent.chatId).last?.id === intent.turnId) retryTurn(intent.chatId);
}

/**
 * Tells the server which chat is in the foreground (push skips it); null when hidden. Never
 * queued: a stale focus must not arrive late, and every (re)connect reports it after auth.
 */
export function reportFocus(hidden = document.hidden) {
  const st = useStore.getState();
  const chatId = hidden || st.screen !== 'chat' ? null : st.activeChatId;
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'chat.focus', chatId } satisfies ClientMessageInput));
}

export function respondApproval(requestId: string, approve: boolean) {
  send({ type: 'approval.respond', requestId, approve });
  useStore.getState().decideApproval(requestId, approve);
}

type Delta = Extract<ServerMessage, { type: 'message.delta' }>;
/** Phase 27: the deltas since the last frame, one per chat (a new message id starts another). */
let deltas: Delta[] = [];
let frame = 0;

/** Holds a delta until the next frame, joined to the chat's waiting one: one commit per frame. */
function queueDelta(d: Delta) {
  const last = deltas.findLast((x) => x.chatId === d.chatId);
  if (last?.messageId === d.messageId) {
    last.annotations = [...last.annotations, ...shift(d.annotations, last.text.length)];
    last.text += d.text;
  } else deltas.push({ ...d });
  frame ||= requestAnimationFrame(flushDeltas);
}

/** Applies the waiting deltas now. */
function flushDeltas() {
  if (!deltas.length) return;
  cancelAnimationFrame(frame);
  frame = 0;
  const list = deltas;
  deltas = [];
  for (const d of list) useStore.getState().apply(d);
}

/** How long the answer to a ping may take before the socket counts as lost. */
const PONG_TIMEOUT_MS = 10_000;

function open() {
  const sock = new WebSocket(url);
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    backoff = 500;
    for (const data of queue) sock.send(data);
    queue = [];
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      send({ type: 'ping' });
      // A half-open socket (a network switch) stays OPEN: no frame in time, and it counts as
      // closed now, so the frames sent after it are queued for the next socket.
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        sock.onclose = null;
        sock.close();
        closed(sock, opened, 1006);
      }, PONG_TIMEOUT_MS);
    }, 25_000);
  };
  sock.onmessage = (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    // A socket that counts as closed (no pong) may still deliver: its answers belong to nothing.
    if (!parsed.success || ws !== sock) return;
    // Any frame shows the socket is alive.
    clearTimeout(pongTimer);
    const msg = parsed.data;
    if (msg.type === 'message.delta') return queueDelta(msg);
    // Any other frame comes after the deltas before it (a final, a tool row, the idle status).
    flushDeltas();
    const store = useStore.getState();
    const was = msg.type === 'chat.updated' ? store.policies[msg.chat.id] : undefined;
    store.apply(msg);
    settlePolicy(msg, was);
    settleRetry(msg);
    sendQueued(msg);
    if (msg.type === 'chat.created') createWaiters.shift()?.resolve(msg.chat.id);
    if (msg.type === 'error' && !msg.chatId && CREATE_REFUSALS.has(msg.code))
      createWaiters.shift()?.reject();
    if (msg.type === 'auth.state' && !msg.authenticated) disconnect();
    if (msg.type === 'auth.state' && msg.authenticated) {
      send({ type: 'chat.list', archived: store.archivedView });
      send({ type: 'topic.list' });
      // Baseline for the chat's memory chip diff.
      send({ type: 'memory.list' });
      // Auto, favourites and the catalog for the model chip (phase-10).
      send({ type: 'models.list' });
      reportFocus();
      // The open chat, and every chat with a queued message: its `chat.state` tells if it runs.
      for (const chatId of new Set([store.activeChatId, ...Object.keys(store.queued)]))
        if (chatId) send({ type: 'chat.open', chatId });
    }
  };
  sock.onclose = (e) => closed(sock, opened, e.code);
}

function closed(sock: WebSocket, opened: boolean, code: number) {
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  // 4401: this device's session was revoked (Laitteet, phase 15): signed out, no reconnect.
  if (code === 4401) return signedOut();
  // A refused upgrade (revoked while offline) closes as 1006 before `onopen`: the browser hides
  // the HTTP 401. `/api/auth/me` tells it apart from a server that is down.
  if (!opened && !stopped && globalThis.navigator?.onLine !== false)
    me().catch((err: unknown) => {
      if (err instanceof HttpError && err.status === 401 && !stopped) signedOut();
    });
  if (createWaiters.length) {
    failCreates();
    useStore.getState().pushError(ERROR_TEXT.prompt_failed);
  }
  // The answer to a pending consent, retry, edit, switch, fork or thinking text may never come;
  // a reconnect starts clean.
  policyIntent = null;
  endRetry();
  editRefresh = null;
  if (useStore.getState().pendingFork) useStore.setState({ pendingFork: null });
  if (useStore.getState().pendingVersion) useStore.setState({ pendingVersion: null });
  failThinking();
  if (ws !== sock || stopped) return;
  ws = null;
  retryTimer = setTimeout(open, backoff);
  backoff = Math.min(backoff * 2, 10_000);
}
