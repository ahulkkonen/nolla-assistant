import { type ClientMessageInput, ServerMessage } from '@pa/protocol';
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

/** Sends `chat.create` and resolves with the id from the next `chat.created`. */
export function createChat(): Promise<string> {
  return new Promise((resolve) => {
    createWaiters.push(resolve);
    send({ type: 'chat.create' });
  });
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
