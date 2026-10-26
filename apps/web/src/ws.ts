import {
  type AttachmentRef,
  type ClientMessageInput,
  type DataPolicy,
  type ModelPolicy,
  ServerMessage,
} from '@pa/protocol';
import { type UiMessage, useStore } from './store.ts';

let ws: WebSocket | null = null;
let url = '';
let queue: string[] = [];
let backoff = 500;
let stopped = true;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let createWaiters: Array<(chatId: string) => void> = [];
/** Callers waiting for a chat's next `chat.state` (its server message ids). */
let stateWaiters: Array<{ chatId: string; resolve: (messages: UiMessage[]) => void }> = [];
/**
 * A data-policy change sent from this client, until its `chat.updated` confirms it. For `open`,
 * `turnId` is the refused turn's user message: the consent retries that turn and no newer one.
 */
let policyIntent: { chatId: string; dataPolicy: DataPolicy; turnId?: string } | null = null;
/** A `user.retry` sent, until the rerun starts (the local thread rewinds then) or is refused. */
let retryIntent: { chatId: string; turnId: string } | null = null;
// A chat switch drops the consent: its retry runs only in the chat on screen.
useStore.subscribe((s, prev) => {
  if (s.activeChatId !== prev.activeChatId) policyIntent = null;
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
  retryIntent = null;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  queue = [];
  ws?.close();
  ws = null;
}

export function send(msg: ClientMessageInput) {
  const data = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else queue.push(data);
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

/** Sends `chat.create` with the picked agent; resolves with the id from the next `chat.created`. */
export function createChat(): Promise<string> {
  return new Promise((resolve) => {
    createWaiters.push(resolve);
    const st = useStore.getState();
    send({ type: 'chat.create', agentId: st.pendingAgentId, model: st.pendingModel });
  });
}

/** Shows the message at once (the server does not echo it) and sends it; creates the chat if needed. */
export async function sendUserMessage(text: string, attachments: AttachmentRef[] = []) {
  // A new turn ends a pending consent or retry: neither may act on it.
  policyIntent = null;
  retryIntent = null;
  const id = useStore.getState().activeChatId ?? (await createChat());
  useStore.getState().addLocalMessage(id, {
    id: `local-${crypto.randomUUID()}`,
    role: 'user',
    text,
    annotations: [],
    attachments,
    tools: [],
    createdAt: new Date().toISOString(),
  });
  send({ type: 'user.message', chatId: id, text, attachments });
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
  if (!last) return;
  const inPlace =
    st.failed[chatId] !== 'prompt_failed' && messages.slice(i + 1).every((m) => !m.tools.length);
  if (inPlace) {
    retryIntent = { chatId, turnId: last.id };
    return send({ type: 'user.retry', chatId });
  }
  st.rewind(chatId, i + 1);
  send({ type: 'user.message', chatId, text: last.text, attachments: last.attachments });
}

/**
 * "Haarauta" (phase-13 decision 1): a new chat from the edited user message; this chat does not
 * change. A message sent in this session still has its local id, so the server's ids come first
 * (`chat.open`), matched by the message's place among the user messages.
 */
export async function forkChat(chatId: string, messageId: string, text: string) {
  const list = useStore.getState().messages[chatId] ?? [];
  const original = list.find((m) => m.id === messageId);
  const attachments = original?.attachments ?? [];
  useStore.setState({ pendingFork: { chatId, messageId, text, attachments } });
  let id = messageId;
  if (id.startsWith('local-')) {
    const nth = list.filter((m) => m.role === 'user').findIndex((m) => m.id === messageId);
    const fresh = await new Promise<UiMessage[]>((resolve) => {
      stateWaiters.push({ chatId, resolve });
      send({ type: 'chat.open', chatId });
    });
    id = fresh.filter((m) => m.role === 'user')[nth]?.id ?? id;
    useStore.setState({ pendingFork: { chatId, messageId: id, text, attachments } });
  }
  send({ type: 'chat.fork', chatId, messageId: id, text });
}

/** Opens a thinking row: its text loads once (`thinking.get`); after an error, again. */
export function loadThinking(chatId: string, messageId: string) {
  useStore.setState((s) => ({
    thinkingText: { ...s.thinkingText, [messageId]: { chatId, state: 'loading' } },
  }));
  send({ type: 'thinking.get', chatId, messageId });
}

/** Rewinds the thread on the rerun's first event; a refusal (an error for the chat) keeps it. */
function settleRetry(msg: ServerMessage) {
  const intent = retryIntent;
  if (!intent || !('chatId' in msg) || msg.chatId !== intent.chatId) return;
  if (msg.type === 'error') retryIntent = null;
  if (msg.type !== 'agent.status' || msg.state !== 'running') return;
  retryIntent = null;
  const at = (useStore.getState().messages[intent.chatId] ?? []).findIndex(
    (m) => m.id === intent.turnId,
  );
  if (at >= 0) useStore.getState().rewind(intent.chatId, at + 1);
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

function open() {
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    backoff = 500;
    for (const data of queue) sock.send(data);
    queue = [];
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 25_000);
  };
  sock.onmessage = (e) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(e.data));
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    const store = useStore.getState();
    const was = msg.type === 'chat.updated' ? store.policies[msg.chat.id] : undefined;
    store.apply(msg);
    settlePolicy(msg, was);
    settleRetry(msg);
    if (msg.type === 'chat.created') {
      const waiter = createWaiters.shift();
      waiter?.(msg.chat.id);
    }
    if (msg.type === 'chat.state')
      stateWaiters = stateWaiters.filter((w) => {
        if (w.chatId !== msg.chat.id) return true;
        w.resolve(msg.messages);
        return false;
      });
    if (msg.type === 'auth.state' && !msg.authenticated) disconnect();
    if (msg.type === 'auth.state' && msg.authenticated) {
      send({ type: 'chat.list', archived: store.archivedView });
      send({ type: 'topic.list' });
      // Baseline for the chat's memory chip diff.
      send({ type: 'memory.list' });
      // Auto, favourites and the catalog for the model chip (phase-10).
      send({ type: 'models.list' });
      reportFocus();
      if (store.activeChatId) send({ type: 'chat.open', chatId: store.activeChatId });
    }
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    // The answer to a pending consent or retry may never come; a reconnect starts clean.
    policyIntent = null;
    retryIntent = null;
    if (ws !== sock || stopped) return;
    ws = null;
    retryTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };
}
