import { describe, expect, it } from 'vitest';
import { Annotation, AuthLogin, ClientMessage, ServerMessage } from './index.ts';

describe('ClientMessage', () => {
  it('parses a valid message and applies defaults', () => {
    const r = ClientMessage.safeParse({ type: 'user.message', chatId: 'c1', text: 'hei' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ type: 'user.message', chatId: 'c1', text: 'hei', attachments: [] });
  });
  it('rejects an invalid message', () => {
    expect(ClientMessage.safeParse({ type: 'chat.rename', chatId: 'c1', title: '' }).success).toBe(
      false,
    );
    expect(ClientMessage.safeParse({ type: 'nope' }).success).toBe(false);
  });
  it('rejects vault.merge with intoId inside fromIds', () => {
    expect(
      ClientMessage.safeParse({ type: 'vault.merge', fromIds: [1, 2], intoId: 2 }).success,
    ).toBe(false);
  });
  it('rejects push.subscribe with a non-URL endpoint', () => {
    expect(
      ClientMessage.safeParse({
        type: 'push.subscribe',
        subscription: { endpoint: 'nope', keys: { p256dh: 'a', auth: 'b' } },
      }).success,
    ).toBe(false);
  });
});

describe('Annotation', () => {
  it('rejects end <= start', () => {
    expect(Annotation.safeParse({ start: 5, end: 5, entityId: 1, modelSaw: 'x' }).success).toBe(
      false,
    );
  });
});

describe('AuthLogin', () => {
  it('parses a valid passkey login', () => {
    expect(
      AuthLogin.safeParse({ type: 'auth.login', method: 'passkey', assertion: { id: 'x' } })
        .success,
    ).toBe(true);
  });
  it('rejects a password login without password', () => {
    expect(ClientMessage.safeParse({ type: 'auth.login', method: 'password' }).success).toBe(false);
  });
});

describe('ServerMessage', () => {
  it('parses a valid message', () => {
    const r = ServerMessage.safeParse({
      type: 'message.delta',
      chatId: 'c1',
      messageId: 'm1',
      text: 'Matti',
      annotations: [{ start: 0, end: 5, entityId: 3, modelSaw: 'Pekka' }],
    });
    expect(r.success).toBe(true);
  });
  it('rejects an invalid message', () => {
    expect(
      ServerMessage.safeParse({
        type: 'message.delta',
        chatId: 'c1',
        messageId: 'm1',
        text: 'x',
        annotations: [{ start: -1, end: 5, entityId: 3, modelSaw: 'P' }],
      }).success,
    ).toBe(false);
  });
});

describe('unions', () => {
  it('are non-empty', () => {
    expect(ClientMessage.options.length).toBeGreaterThan(0);
    expect(ServerMessage.options.length).toBeGreaterThan(0);
  });
});
