import type { ChatSummary, Message } from '@pa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store.ts';

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const chat = (id: string, pinned: boolean, updatedAt: string): ChatSummary => ({
  id,
  title: id,
  topicId: null,
  agentId: 'assistant',
  pinned,
  archived: false,
  updatedAt,
});

describe('store reducers', () => {
  it('replaces the streamed message with message.final', () => {
    const { apply } = useStore.getState();
    apply({ type: 'message.delta', chatId: 'c', messageId: 's1', text: 'Hei ', annotations: [] });
    apply({
      type: 'message.delta',
      chatId: 'c',
      messageId: 's1',
      text: 'maailma',
      annotations: [],
    });
    expect(useStore.getState().streaming.c?.text).toBe('Hei maailma');

    const message: Message = {
      id: 'e1',
      role: 'assistant',
      text: 'Hei maailma',
      annotations: [],
      attachments: [],
      tools: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    apply({ type: 'message.final', chatId: 'c', message });
    const st = useStore.getState();
    expect(st.streaming.c).toBeUndefined();
    expect(st.messages.c).toEqual([message]);
  });

  it('orders chat.list pinned first, then updatedAt desc', () => {
    useStore.getState().apply({
      type: 'chat.list',
      chats: [
        chat('old', false, '2026-01-01T00:00:00.000Z'),
        chat('pin', true, '2025-01-01T00:00:00.000Z'),
        chat('new', false, '2026-02-01T00:00:00.000Z'),
      ],
    });
    expect(useStore.getState().chats.map((c) => c.id)).toEqual(['pin', 'new', 'old']);
  });

  it('shows an error toast and dismisses it after 6 s', () => {
    vi.useFakeTimers();
    useStore.getState().apply({ type: 'error', code: 'failed', message: 'Request failed' });
    expect(useStore.getState().errors.map((e) => e.message)).toEqual(['Request failed']);
    vi.advanceTimersByTime(6000);
    expect(useStore.getState().errors).toEqual([]);
    vi.useRealTimers();
  });
});
