import { type AttachmentRef, type ClientMessageInput, ServerMessage } from '@pa/protocol';
import { useStore } from './store.ts';

let ws: WebSocket | null = null;
let url = '';
let queue: string[] = [];
let backoff = 500;
let stopped = true;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let createWaiters: Array<(chatId: string) => void> = [];

const defaultUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export function connect(to = defaultUrl()) {
  if (!stopped) return;
  url = to;
  stopped = false;
  open();
}

export function disconnect() {
  stopped = true;
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
    send({ type: 'chat.create', agentId: useStore.getState().pendingAgentId });
  });
}

/** Shows the message at once (the server does not echo it) and sends it; creates the chat if needed. */
export async function sendUserMessage(text: string, attachments: AttachmentRef[] = []) {
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
  useStore.getState().dropApproval(requestId);
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
    store.apply(msg);
    if (msg.type === 'chat.created') {
      const waiter = createWaiters.shift();
      waiter?.(msg.chat.id);
    }
    if (msg.type === 'auth.state' && !msg.authenticated) disconnect();
    if (msg.type === 'auth.state' && msg.authenticated) {
      send({ type: 'chat.list', archived: store.archivedView });
      send({ type: 'topic.list' });
      // Baseline for the chat's memory chip diff.
      send({ type: 'memory.list' });
      reportFocus();
      if (store.activeChatId) send({ type: 'chat.open', chatId: store.activeChatId });
    }
  };
  sock.onclose = () => {
    clearInterval(pingTimer);
    if (ws !== sock || stopped) return;
    ws = null;
    retryTimer = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  };
}
