import type { ChatSummary, Message } from '@pa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverIdOf, useStore } from './store.ts';

const initial = useStore.getState();
afterEach(() => useStore.setState(initial, true));

const chat = (id: string, pinned: boolean, updatedAt: string): ChatSummary => ({
  id,
  title: id,
  topicId: null,
  agentId: 'assistant',
  pinned,
  archived: false,
  modelPolicy: { modelId: 'auto', reasoning: 'auto', dataPolicy: 'zdr' },
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

  it('converts chunk-relative delta annotations to message offsets', () => {
    const { apply } = useStore.getState();
    const a = (start: number, end: number) => ({ start, end, entityId: 1, modelSaw: 'Pekka' });
    apply({ type: 'message.delta', chatId: 'c', messageId: 's', text: 'Hei ', annotations: [] });
    apply({
      type: 'message.delta',
      chatId: 'c',
      messageId: 's',
      text: 'Matti!',
      annotations: [a(0, 5)],
    });
    expect(useStore.getState().streaming.c?.annotations).toEqual([a(4, 9)]);
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

  it('counts an error toast; a failed reply in the open chat is inline until the next message', () => {
    const before = useStore.getState().errorCount;
    useStore.getState().apply({ type: 'error', code: 'failed', message: 'Request failed' });
    expect(useStore.getState().errorCount).toBe(before + 1);
    useStore.getState().setActive('c1');
    useStore.getState().apply({ type: 'error', code: 'llm_failed', message: 'x', chatId: 'c1' });
    expect(useStore.getState().failed.c1).toBe('llm_failed');
    useStore.getState().addLocalMessage('c1', {
      id: 'm1',
      role: 'user',
      text: 'Uudelleen',
      createdAt: '2026-01-01T00:00:00.000Z',
      annotations: [],
      attachments: [],
      tools: [],
    } as never);
    expect(useStore.getState().failed.c1).toBeUndefined();
  });

  it('a held message: marked while held, its text back in the composer when dropped', () => {
    const local = (id: string, text: string) =>
      useStore.getState().addLocalMessage('c1', {
        id,
        role: 'user',
        text,
        createdAt: '2026-01-01T00:00:00.000Z',
        annotations: [],
        attachments: [],
        tools: [],
      } as never);
    const { apply } = useStore.getState();
    local('m1', 'Soita Pekka Laaksonen');
    apply({ type: 'chat.held', chatId: 'c1', pendingIds: [1] });
    expect(useStore.getState().held).toEqual({ c1: 'Soita Pekka Laaksonen' });
    apply({ type: 'chat.released', chatId: 'c1', outcome: 'resumed' });
    expect(useStore.getState().held).toEqual({});
    expect(useStore.getState().draft).toBeNull();

    local('m2', 'Pekka Laaksonen?');
    apply({ type: 'chat.held', chatId: 'c1', pendingIds: [2] });
    apply({ type: 'chat.released', chatId: 'c1', outcome: 'dropped' });
    const st = useStore.getState();
    expect(st.draft).toEqual({ chatId: 'c1', text: 'Pekka Laaksonen?' });
    expect(st.messages.c1?.map((m) => m.text)).toEqual(['Soita Pekka Laaksonen']); // never sent
    apply({ type: 'chat.released', chatId: 'c1', outcome: 'dropped' }); // nothing held: ignored
    expect(useStore.getState().messages.c1).toHaveLength(1);
  });

  it('records a ZDR refusal with its model in any chat; a policy change or a rewind ends it', () => {
    const { apply } = useStore.getState();
    const fable = {
      modelId: 'anthropic/claude-fable-5.1',
      reasoning: 'auto',
      dataPolicy: 'zdr',
    } as const;
    apply({
      type: 'chat.list',
      chats: [{ ...chat('bg', false, '2026-01-01T00:00:00.000Z'), modelPolicy: fable }],
    });
    useStore.getState().setActive('other');
    apply({ type: 'error', code: 'zdr_unavailable', message: 'x', chatId: 'bg' });
    expect(useStore.getState().zdrRefused.bg).toEqual({ modelId: fable.modelId });
    // Only the level changes: the server drops its refusal record, so the alert goes too.
    const updated = (reasoning: 'auto' | 'high') =>
      apply({
        type: 'chat.updated',
        chat: {
          ...chat('bg', false, '2026-01-01T00:00:00.000Z'),
          modelPolicy: { ...fable, reasoning },
        },
      });
    updated('auto');
    expect(useStore.getState().zdrRefused.bg).toBeDefined();
    updated('high');
    expect(useStore.getState().zdrRefused.bg).toBeUndefined();

    apply({ type: 'error', code: 'zdr_unavailable', message: 'x', chatId: 'bg' });
    const m = (id: string, role: 'user' | 'assistant') =>
      ({ id, role, text: id, annotations: [], attachments: [], tools: [], createdAt: '' }) as never;
    useStore.setState({
      messages: {
        bg: [m('u1', 'user'), m('a1', 'assistant'), m('u2', 'user'), m('a2', 'assistant')],
      },
    });
    useStore.getState().rewind('bg', 3);
    expect(useStore.getState().messages.bg?.map((x) => x.id)).toEqual(['u1', 'a1', 'u2']);
    expect(useStore.getState().zdrRefused.bg).toBeUndefined();
  });

  it('a fork: its chat.state opens with the copied history plus the edited text; an error ends it', () => {
    const { apply } = useStore.getState();
    useStore.setState({
      pendingFork: { chatId: 'src', messageId: 'u2', text: 'Muokattu', localId: 'local-f' },
    });
    const m = (id: string, role: 'user' | 'assistant') =>
      ({ id, role, text: id, annotations: [], attachments: [], tools: [], createdAt: '' }) as never;
    apply({
      type: 'chat.state',
      chat: chat('fork', false, '2026-01-01T00:00:00.000Z'),
      messages: [m('u1', 'user'), m('a1', 'assistant')],
      forkedFrom: { chatId: 'src', messageId: 'u2', title: 'Lähde', deleted: false },
    });
    const st = useStore.getState();
    expect(st.messages.fork?.map((x) => x.text)).toEqual(['u1', 'a1', 'Muokattu']);
    expect(st.activeChatId).toBe('fork');
    expect(st.pendingFork).toBeNull();
    expect(st.forkedFrom.fork?.title).toBe('Lähde');

    useStore.setState({
      pendingFork: { chatId: 'src', messageId: 'u2', text: 'x', localId: 'local-g' },
    });
    // An error of another chat leaves the fork waiting; the source chat's error ends it.
    apply({ type: 'error', code: 'failed', message: 'x', chatId: 'other' });
    expect(useStore.getState().pendingFork).not.toBeNull();
    apply({ type: 'error', code: 'failed', message: 'Request failed', chatId: 'src' });
    expect(useStore.getState().pendingFork).toBeNull();
  });

  it('message.accepted gives a sent message its entry id; its own id stays', () => {
    useStore.getState().addLocalMessage('c', {
      id: 'local-1',
      role: 'user',
      text: 'Hei',
      annotations: [],
      attachments: [],
      tools: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const [before] = useStore.getState().messages.c ?? [];
    expect(before && serverIdOf(before)).toBeUndefined();
    useStore
      .getState()
      .apply({ type: 'message.accepted', chatId: 'c', localId: 'local-1', messageId: 'e1' });
    const [after] = useStore.getState().messages.c ?? [];
    expect(after?.id).toBe('local-1');
    expect(after && serverIdOf(after)).toBe('e1');
  });

  it("chat.state keeps a sent message's local id and gives it the entry id", () => {
    const local = {
      id: 'local-9',
      role: 'user' as const,
      text: 'Hei',
      annotations: [],
      attachments: [],
      tools: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    useStore.setState({ messages: { c: [local] } });
    useStore.getState().apply({
      type: 'chat.state',
      chat: chat('c', false, '2026-01-01T00:00:00.000Z'),
      messages: [{ ...local, id: 'e9' }],
    });
    const [m] = useStore.getState().messages.c ?? [];
    expect(m?.id).toBe('local-9');
    expect(m && serverIdOf(m)).toBe('e9');
  });

  it('a late tool.end patches the final row, and starts no stream', () => {
    const final = {
      id: 'a1',
      role: 'assistant' as const,
      text: '',
      annotations: [],
      attachments: [],
      tools: [{ callId: 'k1', name: 'web_search', status: 'running' as const, summary: '' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    useStore.setState({ messages: { c: [final] } });
    const search = { query: 'sää', results: [{ title: 'Yle', url: 'https://yle.fi/saa' }] };
    useStore
      .getState()
      .apply({ type: 'tool.end', chatId: 'c', callId: 'k1', status: 'ok', summary: '', search });
    const st = useStore.getState();
    expect(st.messages.c?.[0]?.tools[0]).toMatchObject({ status: 'ok', search });
    expect(st.streaming.c).toBeUndefined();
  });

  it('a thinking text that fails to load turns the row to its error', () => {
    useStore.setState({ thinkingText: { 'c:a1': { chatId: 'c', state: 'loading' } } });
    useStore.getState().apply({ type: 'error', code: 'not_found', message: 'x', chatId: 'c' });
    expect(useStore.getState().thinkingText['c:a1']?.state).toBe('error');
  });

  it('keeps approval cards until answered, resolved or the chat goes idle', () => {
    const { apply } = useStore.getState();
    const req = (requestId: string) =>
      apply({
        type: 'approval.request',
        chatId: 'c',
        requestId,
        tool: 'write',
        args: { path: 'a.txt' },
        reason: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    req('r1');
    req('r2');
    req('r3');
    apply({ type: 'approval.resolved', chatId: 'c', requestId: 'r1', outcome: 'denied' });
    apply({ type: 'approval.resolved', chatId: 'c', requestId: 'r2', outcome: 'expired' });
    const state = (a: { expired?: true; denied?: true }) =>
      a.expired ? 'expired' : a.denied ? 'denied' : 'open';
    const ids = () => useStore.getState().approvals.map((a) => [a.requestId, state(a)]);
    expect(ids()).toEqual([
      ['r1', 'denied'],
      ['r2', 'expired'],
      ['r3', 'open'],
    ]);
    // Idle drops open cards; decided ones stay for their tool rows until the next message.
    apply({ type: 'agent.status', chatId: 'c', state: 'idle' });
    expect(ids()).toEqual([
      ['r1', 'denied'],
      ['r2', 'expired'],
    ]);
  });
});
