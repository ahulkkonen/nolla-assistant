import { describe, expect, it } from 'vitest';
import {
  AuthLogin,
  ClientMessage,
  parseClientMessage,
  parseServerMessage,
  ServerMessage,
} from './index.ts';

const typeLiterals = (union: {
  options: readonly { _zod: { propValues?: Record<string, Set<unknown>> } }[];
}) => union.options.flatMap((o) => [...(o._zod.propValues?.type ?? [])]);

describe('ClientMessage', () => {
  it('parses a valid message and applies defaults', () => {
    const r = parseClientMessage({ type: 'user.message', chatId: 'c1', text: 'hei' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ type: 'user.message', chatId: 'c1', text: 'hei', attachments: [] });
  });
  it('rejects an invalid message', () => {
    expect(parseClientMessage({ type: 'chat.rename', chatId: 'c1', title: '' }).success).toBe(
      false,
    );
    expect(parseClientMessage({ type: 'nope' }).success).toBe(false);
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
    expect(parseClientMessage({ type: 'auth.login', method: 'password' }).success).toBe(false);
  });
});

describe('ServerMessage', () => {
  it('parses a valid message', () => {
    const r = parseServerMessage({
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
      parseServerMessage({
        type: 'message.delta',
        chatId: 'c1',
        messageId: 'm1',
        text: 'x',
        annotations: [{ start: -1, end: 5, entityId: 3, modelSaw: 'P' }],
      }).success,
    ).toBe(false);
  });
});

describe('type literals', () => {
  it('are unique per direction', () => {
    for (const union of [ClientMessage, ServerMessage]) {
      const types = typeLiterals(union);
      expect(new Set(types).size).toBe(types.length);
    }
    expect(typeLiterals(ClientMessage)).toHaveLength(27);
    expect(typeLiterals(ServerMessage)).toHaveLength(21);
  });
});
