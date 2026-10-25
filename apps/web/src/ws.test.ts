import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store.ts';
import { connect, disconnect, send } from './ws.ts';

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
});
