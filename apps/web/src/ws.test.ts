import type { Message } from '@pa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore, VERSION_FAILED } from './store.ts';
import {
  connect,
  disconnect,
  editMessage,
  retryTurn,
  send,
  sendUserMessage,
  setDataPolicy,
  signedOut,
  stopTurn,
  switchVersion,
} from './ws.ts';

class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(_url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);
afterEach(() => disconnect());

const USER = {
  id: 'u1',
  role: 'user' as const,
  text: 'Hei',
  annotations: [],
  attachments: [],
  tools: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** An open socket on chat `c1` (policy known, ZDR) with `messages` in its thread. */
function chat(messages: Message[] = [USER]) {
  connect('ws://test/ws');
  const sock = FakeWebSocket.last;
  sock.open();
  const policy = { modelId: 'anthropic/claude-fable-5.1', reasoning: 'auto', dataPolicy: 'zdr' };
  const summary = (dataPolicy: string) => ({
    id: 'c1',
    title: 'Hei',
    topicId: null,
    agentId: 'assistant',
    pinned: false,
    archived: false,
    modelPolicy: { ...policy, dataPolicy },
    modes: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const frame = (msg: unknown) => sock.onmessage?.({ data: JSON.stringify(msg) });
  frame({ type: 'chat.list', chats: [summary('zdr')] });
  useStore.getState().setActive('c1');
  useStore.setState({ messages: { c1: messages }, failed: {} });
  const sent = (type: string) =>
    sock.sent.map((d) => JSON.parse(d)).filter((m: { type: string }) => m.type === type);
  return { sock, frame, summary, sent };
}

describe('ws client', () => {
  it('flushes queued sends on open', () => {
    connect('ws://test/ws');
    send({ type: 'chat.list' });
    const sock = FakeWebSocket.last;
    expect(sock.sent).toEqual([]);
    sock.open();
    expect(sock.sent.map((d) => JSON.parse(d))).toEqual([{ type: 'chat.list' }]);
  });

  it('ignores frames that fail safeParse', () => {
    connect('ws://test/ws');
    const sock = FakeWebSocket.last;
    sock.open();
    const apply = vi.spyOn(useStore.getState(), 'apply');
    sock.onmessage?.({ data: JSON.stringify({ type: 'chat.list', chats: 'nope' }) });
    sock.onmessage?.({ data: 'not json' });
    expect(apply).not.toHaveBeenCalled();
    sock.onmessage?.({ data: JSON.stringify({ type: 'pong' }) });
    expect(apply).toHaveBeenCalledOnce();
  });
  it('deltas wait for the next frame: one store update, nothing lost; a final flushes first', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { frame } = chat();
    const updates = vi.fn();
    const off = useStore.subscribe(updates);
    const anno = { start: 0, end: 5, entityId: 1, modelSaw: 'Matti' };
    const delta = (text: string, annotations = [anno], messageId = 's1') =>
      frame({ type: 'message.delta', chatId: 'c1', messageId, text, annotations });
    delta('Pekka ');
    delta('Pekka');
    delta('?', []);
    expect([updates.mock.calls.length, frames.length]).toEqual([0, 1]);
    frames.shift()?.(0);
    expect(updates).toHaveBeenCalledOnce();
    expect(useStore.getState().streaming.c1).toMatchObject({
      text: 'Pekka Pekka?',
      annotations: [anno, { ...anno, start: 6, end: 11 }],
    });
    // A new message id starts its own text; the final applies after the delta before it.
    delta('Uusi', [], 's2');
    frame({
      type: 'message.final',
      chatId: 'c1',
      message: { ...USER, id: 'a1', role: 'assistant', text: 'Uusi' },
    });
    expect(useStore.getState().streaming.c1).toBeUndefined();
    expect(useStore.getState().messages.c1?.at(-1)?.text).toBe('Uusi');
    frames.shift()?.(0);
    expect(useStore.getState().streaming.c1).toBeUndefined();
    off();
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  it('the consent retries once, in place, on its chat.updated; a chat switch drops it', () => {
    const { frame, summary, sent } = chat();
    setDataPolicy('c1', 'open');
    frame({ type: 'chat.updated', chat: summary('open') });
    frame({ type: 'chat.updated', chat: summary('open') });
    expect(sent('user.retry')).toHaveLength(1);
    expect(useStore.getState().messages.c1).toHaveLength(1);

    frame({ type: 'chat.updated', chat: summary('zdr') });
    setDataPolicy('c1', 'open');
    useStore.getState().setActive(null);
    useStore.getState().setActive('c1');
    frame({ type: 'chat.updated', chat: summary('open') });
    expect(sent('user.retry')).toHaveLength(1);
  });

  it('the consent retries only its own turn; a new message, a close or an unknown policy drop it', async () => {
    const { sock, frame, summary, sent } = chat();
    // A newer turn after the consent was sent.
    setDataPolicy('c1', 'open');
    useStore.getState().addLocalMessage('c1', { ...USER, id: 'u2' });
    frame({ type: 'chat.updated', chat: summary('open') });
    frame({ type: 'chat.updated', chat: summary('zdr') });
    // The user sends a new message.
    setDataPolicy('c1', 'open');
    await sendUserMessage('Uusi');
    frame({ type: 'chat.updated', chat: summary('open') });
    frame({ type: 'chat.updated', chat: summary('zdr') });
    // The socket closes before the answer.
    setDataPolicy('c1', 'open');
    sock.onclose?.({ code: 1006 });
    frame({ type: 'chat.updated', chat: summary('open') });
    sock.open();
    // No policy known for the chat yet.
    setDataPolicy('c2', 'open');
    frame({ type: 'chat.updated', chat: { ...summary('open'), id: 'c2' } });
    expect(sent('user.retry')).toEqual([]);
  });

  it('user.retry rewinds the thread on the first event of the rerun and keeps it on a refusal', () => {
    const { frame, sent } = chat([
      USER,
      { ...USER, id: 'a1', role: 'assistant', text: 'Osittain' },
    ]);
    frame({ type: 'error', code: 'llm_failed', message: 'x', chatId: 'c1' });
    retryTurn('c1');
    expect(sent('user.retry')).toHaveLength(1);
    expect(useStore.getState().messages.c1).toHaveLength(2);
    frame({ type: 'error', code: 'failed', message: 'x', chatId: 'c1' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    expect(useStore.getState().messages.c1).toHaveLength(2);
    retryTurn('c1');
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    // The kept message runs as a new entry: a fresh local id, its old entry id gone.
    const kept = useStore.getState().messages.c1 ?? [];
    expect(kept.map((m) => m.text)).toEqual([USER.text]);
    expect(kept[0]?.id).toMatch(/^local-/);
    expect(kept[0]?.serverId).toBeUndefined();
  });

  it('phase 24: an edit waits, rewinds to before its message on the run, and adds the new version', () => {
    const file = { id: 'f1', name: 'kuva.png', mime: 'image/png', size: 1, kind: 'image' as const };
    const { frame, sent } = chat([
      { ...USER, attachments: [file] },
      { ...USER, id: 'a1', role: 'assistant', text: 'Vastaus' },
    ]);
    editMessage('c1', 'u1', 'Hei taas');
    expect(sent('chat.edit')).toMatchObject([{ chatId: 'c1', messageId: 'u1', text: 'Hei taas' }]);
    expect(useStore.getState().pendingEdit).toEqual({ chatId: 'c1', text: 'Hei taas' });
    // One at a time; a refusal keeps the thread and ends the wait.
    editMessage('c1', 'u1', 'Hei taas');
    expect(sent('chat.edit')).toHaveLength(1);
    frame({ type: 'error', code: 'failed', message: 'x', chatId: 'c1' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    expect(useStore.getState().pendingEdit).toBeNull();
    expect(useStore.getState().messages.c1).toHaveLength(2);
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });

    editMessage('c1', 'u1', 'Hei taas');
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    const [m, ...rest] = useStore.getState().messages.c1 ?? [];
    expect(rest).toEqual([]);
    expect(m).toMatchObject({
      text: 'Hei taas',
      attachments: [file],
      versions: { index: 2, count: 2 },
    });
    const localId = sent('chat.edit')[1]?.localId;
    expect(m?.id).toBe(localId);
    frame({ type: 'message.accepted', chatId: 'c1', localId, messageId: 'u2' });
    expect(useStore.getState().messages.c1?.[0]?.serverId).toBe('u2');
    expect(useStore.getState().pendingEdit).toBeNull();
  });

  it('phase 24: a held edit waits with its text; dropped, its box stops waiting', () => {
    const { frame } = chat([USER, { ...USER, id: 'a1', role: 'assistant', text: 'Vastaus' }]);
    editMessage('c1', 'u1', 'Hei Pekka');
    frame({ type: 'chat.held', chatId: 'c1', pendingIds: [1] });
    expect(useStore.getState().held.c1).toBe('Hei Pekka');
    frame({ type: 'chat.released', chatId: 'c1', outcome: 'dropped' });
    const st = useStore.getState();
    expect(st.pendingEdit).toBeNull();
    expect(st.draft).toMatchObject({ chatId: 'c1', text: 'Hei Pekka' });
    expect(st.messages.c1).toHaveLength(2);
    useStore.setState({ draft: null });
  });

  it('phase 24: while an edit is on its way, its chat sends and retries nothing; the edit still settles', async () => {
    const { frame, sent } = chat([USER, { ...USER, id: 'a1', role: 'assistant', text: 'Vastaus' }]);
    // Same text but for white space: the same version, not a new one.
    editMessage('c1', 'u1', ' Hei ');
    await sendUserMessage('Toinen');
    retryTurn('c1');
    expect([sent('user.message'), sent('user.retry')]).toEqual([[], []]);
    expect(useStore.getState().messages.c1).toHaveLength(2);
    expect(useStore.getState().pendingEdit).toEqual({ chatId: 'c1', text: ' Hei ' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    const [m, ...rest] = useStore.getState().messages.c1 ?? [];
    expect([m?.text, m?.versions, rest]).toEqual([' Hei ', undefined, []]);
    // The run's idle asks for the server's versions, once.
    expect(sent('chat.open')).toEqual([]);
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    expect(sent('chat.open')).toEqual([{ type: 'chat.open', chatId: 'c1' }]);
  });

  it('phase 24: a switch that never answers ends after 20 s with the toast', () => {
    vi.useFakeTimers();
    chat();
    const push = vi.spyOn(useStore.getState(), 'pushError').mockImplementation(() => {});
    switchVersion('c1', 'u1', 1);
    expect(useStore.getState().pendingVersion).toEqual({ chatId: 'c1', messageId: 'u1' });
    vi.advanceTimersByTime(19_999);
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(useStore.getState().pendingVersion).toBeNull();
    expect(push).toHaveBeenCalledWith(VERSION_FAILED);
    push.mockRestore();
    vi.useRealTimers();
  });

  it('a turn with tool rows, or a message that never arrived, goes again as a new message', () => {
    const tool = { callId: 't1', name: 'read', status: 'ok' as const, summary: '' };
    const { frame, sent } = chat([USER, { ...USER, id: 'a1', role: 'assistant', tools: [tool] }]);
    frame({ type: 'error', code: 'llm_failed', message: 'x', chatId: 'c1' });
    retryTurn('c1');
    frame({ type: 'error', code: 'prompt_failed', message: 'x', chatId: 'c1' });
    retryTurn('c1');
    expect(sent('user.retry')).toEqual([]);
    expect(sent('user.message')).toHaveLength(2);
  });

  it('a queued message goes once when its chat goes idle, with its attachments', () => {
    const { frame, sent } = chat();
    const file = { id: 'f1', name: 'kuva.png', mime: 'image/png', size: 1, kind: 'image' as const };
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    useStore.getState().enqueue('c1', 'Eka', []);
    useStore.getState().enqueue('c1', 'Toka', [file]);
    expect(useStore.getState().queued.c1).toEqual({ text: 'Eka\n\nToka', attachments: [file] });
    expect(sent('user.message')).toEqual([]);
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    expect(sent('user.message')).toMatchObject([
      { chatId: 'c1', text: 'Eka\n\nToka', attachments: [file] },
    ]);
    expect(useStore.getState().queued.c1).toBeUndefined();
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    expect(sent('user.message')).toHaveLength(1);
  });

  it('a stop or a failed reply gives the queued message back to the composer', () => {
    const { frame, sent } = chat();
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    useStore.getState().enqueue('c1', 'Odota', []);
    stopTurn('c1');
    expect(sent('user.stop')).toHaveLength(1);
    expect(useStore.getState().draft).toMatchObject({ chatId: 'c1', text: 'Odota' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    useStore.setState({ draft: null });
    frame({ type: 'agent.status', chatId: 'c1', state: 'running' });
    useStore.getState().enqueue('c1', 'Uudestaan', []);
    frame({ type: 'error', code: 'llm_failed', message: 'x', chatId: 'c1' });
    frame({ type: 'agent.status', chatId: 'c1', state: 'idle' });
    expect(useStore.getState().draft).toMatchObject({ chatId: 'c1', text: 'Uudestaan' });
    expect(sent('user.message')).toEqual([]);
    useStore.setState({ draft: null });
  });

  it("a queued message sent in another chat keeps this chat's pending consent", () => {
    const { frame, summary, sent } = chat();
    setDataPolicy('c1', 'open');
    frame({ type: 'agent.status', chatId: 'c2', state: 'running' });
    useStore.getState().enqueue('c2', 'Toisaalla', []);
    frame({ type: 'agent.status', chatId: 'c2', state: 'idle' });
    expect(sent('user.message')).toMatchObject([{ chatId: 'c2', text: 'Toisaalla' }]);
    frame({ type: 'chat.updated', chat: summary('open') });
    expect(sent('user.retry')).toHaveLength(1);
  });

  it('after a reconnect, a chat.state that is not running sends the queued message', () => {
    const { frame, sent } = chat();
    frame({ type: 'agent.status', chatId: 'c2', state: 'running' });
    useStore.getState().enqueue('c2', 'Jonossa', []);
    // The socket dropped while the run ended: no idle arrived. The new socket's sign-in opens
    // the chat (`auth.state` also reports the focus, which reads `document.hidden`).
    vi.stubGlobal('document', { hidden: true });
    frame({ type: 'auth.state', authenticated: true });
    Reflect.deleteProperty(globalThis, 'document');
    expect(sent('chat.open').map((m: { chatId: string }) => m.chatId)).toEqual(['c1', 'c2']);
    const c2 = { ...useStore.getState().chats[0], id: 'c2' };
    frame({ type: 'chat.state', chat: c2, messages: [], running: true });
    expect(sent('user.message')).toEqual([]);
    frame({ type: 'chat.state', chat: c2, messages: [], running: false });
    expect(sent('user.message')).toMatchObject([{ chatId: 'c2', text: 'Jonossa' }]);
    expect(useStore.getState().queued.c2).toBeUndefined();
  });

  it('a refused chat.create, or a close before chat.created, gives the text back to the composer', async () => {
    const push = vi.spyOn(useStore.getState(), 'pushError').mockImplementation(() => {});
    const file = { id: 'f1', name: 'kuva.png', mime: 'image/png', size: 1, kind: 'image' as const };
    const { sock, frame, sent } = chat();
    useStore.getState().setActive(null);
    // The server refuses: an error without a chat.
    const refused = sendUserMessage('Eka', [file]);
    expect(sent('chat.create')).toHaveLength(1);
    frame({ type: 'error', code: 'bad_message', message: 'x' });
    await refused;
    expect(useStore.getState().draft).toEqual({ chatId: null, text: 'Eka', attachments: [file] });
    expect(push).toHaveBeenCalledWith('Virheellinen viesti.');
    useStore.setState({ draft: null });
    // The socket closes before the answer.
    const lost = sendUserMessage('Toka');
    sock.onclose?.({ code: 1006 });
    await lost;
    expect(useStore.getState().draft).toMatchObject({ chatId: null, text: 'Toka' });
    expect(push).toHaveBeenLastCalledWith('Viestin lähetys epäonnistui.');
    useStore.setState({ draft: null });
    // No stale waiter: the next chat.created answers only its own create.
    disconnect();
    const next = chat();
    useStore.getState().setActive(null);
    const third = sendUserMessage('Kolmas');
    next.frame({ type: 'chat.created', chat: { ...useStore.getState().chats[0], id: 'c9' } });
    await third;
    expect(next.sent('user.message')).toMatchObject([{ chatId: 'c9', text: 'Kolmas' }]);
    expect(sent('user.message')).toEqual([]);
    push.mockRestore();
  });

  it('a sign-out drops the deltas that wait for their frame: nothing lands after the wipe', () => {
    const frames: FrameRequestCallback[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { frame } = chat();
    const delta = (text: string) =>
      frame({ type: 'message.delta', chatId: 'c1', messageId: 's1', text, annotations: [] });
    delta('Pekka');
    signedOut();
    expect(cancel).toHaveBeenCalledWith(1);
    // A frame that runs anyway applies nothing.
    frames.shift()?.(0);
    expect(useStore.getState().streaming).toEqual({});
    // The next socket's first delta asks for a frame of its own.
    const next = chat();
    next.frame({
      type: 'message.delta',
      chatId: 'c1',
      messageId: 's2',
      text: 'Uusi',
      annotations: [],
    });
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(useStore.getState().streaming.c1?.text).toBe('Uusi');
    useStore.setState({ auth: 'in' });
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
});
