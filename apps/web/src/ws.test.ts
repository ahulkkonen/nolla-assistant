import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store.ts';
import { connect, disconnect, send, setDataPolicy } from './ws.ts';

class FakeWebSocket {
  static OPEN = 1;
  static last: FakeWebSocket;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
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
  it('the consent retries once, in place, on its chat.updated; a chat switch drops it', () => {
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
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const frame = (msg: unknown) => sock.onmessage?.({ data: JSON.stringify(msg) });
    frame({ type: 'chat.list', chats: [summary('zdr')] });
    useStore.getState().setActive('c1');
    const user = {
      id: 'u1',
      role: 'user',
      text: 'Hei',
      annotations: [],
      attachments: [],
      tools: [],
    };
    useStore.setState({ messages: { c1: [{ ...user, createdAt: '' } as never] } });
    const sent = () => sock.sent.map((d) => JSON.parse(d).type);

    setDataPolicy('c1', 'open');
    frame({ type: 'chat.updated', chat: summary('open') });
    frame({ type: 'chat.updated', chat: summary('open') });
    expect(sent().filter((t) => t === 'user.retry')).toHaveLength(1);
    expect(useStore.getState().messages.c1).toHaveLength(1);

    frame({ type: 'chat.updated', chat: summary('zdr') });
    setDataPolicy('c1', 'open');
    useStore.getState().setActive(null);
    useStore.getState().setActive('c1');
    frame({ type: 'chat.updated', chat: summary('open') });
    expect(sent().filter((t) => t === 'user.retry')).toHaveLength(1);
  });
});
