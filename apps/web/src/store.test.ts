import type { Artifact, ChatSummary, Message } from '@pa/protocol';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectiveModes, failedText, serverIdOf, useStore } from './store.ts';

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
  modes: null,
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

  it('phase 26: the waiting line follows the real events and goes at idle', () => {
    vi.useFakeTimers({ now: 0 });
    const { apply } = useStore.getState();
    const at = (ms: number) => vi.setSystemTime(ms);
    const w = () => useStore.getState().waits.c;
    apply({ type: 'agent.status', chatId: 'c', state: 'running' });
    expect(w()).toMatchObject({ step: 0, accepted: false });
    apply({ type: 'message.accepted', chatId: 'c', localId: 'l', messageId: 'e' });
    expect(w()?.accepted).toBe(true);
    at(1000);
    apply({ type: 'message.phase', chatId: 'c', messageId: 's', phase: 'sent', at: 1 });
    expect(w()).toMatchObject({ step: 1, since: 1000, queued: 0 });
    at(15_000);
    apply({ type: 'message.phase', chatId: 'c', messageId: 's', phase: 'headers', at: 2 });
    expect(w()).toMatchObject({ step: 2, queued: 14_000 });
    apply({ type: 'message.thinking', chatId: 'c', messageId: 's', active: true });
    at(18_000);
    apply({ type: 'message.thinking', chatId: 'c', messageId: 's', active: false });
    expect(w()).toMatchObject({ thought: 3000, thinking: undefined });
    apply({ type: 'message.delta', chatId: 'c', messageId: 's', text: 'Hei', annotations: [] });
    expect(w()).toMatchObject({ step: 3, writing: 18_000 });
    // A tool call after the text: the thinking slot says "työkalu" while it runs.
    apply({ type: 'tool.start', chatId: 'c', callId: 't', name: 'read', argsPreview: '' });
    expect(w()).toMatchObject({ step: 2, tool: 18_000 });
    apply({ type: 'tool.end', chatId: 'c', callId: 't', status: 'ok', summary: '' });
    expect(w()?.tool).toBeUndefined();
    const message: Message = {
      id: 'e1',
      role: 'assistant',
      text: 'Hei',
      annotations: [],
      attachments: [],
      tools: [{ callId: 't', name: 'read', status: 'ok', summary: '' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    // A round with a tool call: another one follows, the live turn stays.
    apply({ type: 'message.final', chatId: 'c', message });
    expect(w()?.ended).toBe(false);
    apply({ type: 'message.phase', chatId: 'c', messageId: 's2', phase: 'sent', at: 3 });
    expect(w()).toMatchObject({ step: 1, writing: undefined });
    apply({ type: 'message.final', chatId: 'c', message: { ...message, id: 'e2', tools: [] } });
    expect(w()?.ended).toBe(true);
    apply({ type: 'agent.status', chatId: 'c', state: 'idle' });
    expect(w()).toBeUndefined();
    vi.useRealTimers();
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
    expect(useStore.getState().failed.c1).toEqual({ code: 'llm_failed' });
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

  it('a failed model call: the status in the text, the detail behind "Näytä tiedot"', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toastError = vi.spyOn(toast, 'error');
    const msg = {
      type: 'error' as const,
      code: 'llm_failed',
      message: 'Model call failed',
      status: 404,
      detail: 'No endpoints found',
    };
    useStore.getState().setActive('c1');
    useStore.getState().apply({ ...msg, chatId: 'c1' });
    const failure = { code: 'llm_failed', status: 404, detail: 'No endpoints found' } as const;
    expect(useStore.getState().failed.c1).toEqual(failure);
    expect(failedText(failure)).toBe('Mallikutsu epäonnistui (404)');
    expect(failedText({ code: 'llm_failed' })).toBe('Mallikutsu epäonnistui.');
    expect(error).toHaveBeenCalledWith('model call failed', { ...msg, chatId: 'c1' });
    // A chat in the background: a toast whose action opens the detail.
    useStore.getState().apply({ ...msg, chatId: 'c2' });
    const [text, opts] = toastError.mock.calls.at(-1) ?? [];
    expect(text).toBe('Mallikutsu epäonnistui (404)');
    const action = (opts as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe('Näytä tiedot');
    action.onClick();
    expect(useStore.getState().errorDetail).toEqual(failure);
    error.mockRestore();
    toastError.mockRestore();
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
    // Phase 20: the refused run's own model, when the chat changed model during the run.
    apply({ type: 'error', code: 'zdr_unavailable', message: 'x', chatId: 'bg', modelId: 'auto' });
    expect(useStore.getState().zdrRefused.bg).toEqual({ modelId: 'auto' });
    apply({ type: 'error', code: 'zdr_unavailable', message: 'x', chatId: 'bg' });
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

describe('artifact panel (phase 20)', () => {
  const art = (id: string, kind: Artifact['kind'] = 'html'): Artifact => ({
    id,
    kind,
    title: id,
    content: `<h1>${id}</h1>`,
  });
  const state = (artifacts: Artifact[]) => ({
    type: 'chat.state' as const,
    chat: chat('c1', false, '2026-01-01T00:00:00.000Z'),
    messages: [],
    artifacts,
  });
  const open = () => useStore.getState().openArtifact;

  it('a chat change closes the panel', () => {
    useStore.getState().setActive('c1');
    useStore.getState().showArtifact('c1', art('a1'));
    expect(open()).toEqual({ chatId: 'c1', id: 'a1' });
    useStore.getState().setActive('c2');
    expect(open()).toBeNull();
  });

  it('an upsert of a new version moves an open panel to it; a new figure does not', () => {
    const { apply } = useStore.getState();
    useStore.getState().setActive('c1');
    apply(state([art('v1')]));
    useStore.getState().showArtifact('c1', art('v1'));
    apply({ type: 'artifact.upsert', chatId: 'c1', artifact: art('f1', 'vega-lite') });
    expect(open()).toEqual({ chatId: 'c1', id: 'v1' });
    apply({ type: 'artifact.upsert', chatId: 'c1', artifact: art('v2', 'react') });
    expect(open()).toEqual({ chatId: 'c1', id: 'v2' });
    // A known id updates in place: the panel stays.
    apply({ type: 'artifact.upsert', chatId: 'c1', artifact: { ...art('v1'), content: 'x' } });
    expect(open()).toEqual({ chatId: 'c1', id: 'v2' });
  });

  it('a chat.state with a new id moves an open panel; the first chat.state opens nothing', () => {
    const { apply } = useStore.getState();
    useStore.getState().setActive('c1');
    apply(state([art('v1')]));
    expect(open()).toBeNull();
    useStore.getState().showArtifact('c1', art('v1'));
    // A reconnect after the reply: version 2 arrives in the chat's state.
    apply(state([art('v1'), art('v2')]));
    expect(open()).toEqual({ chatId: 'c1', id: 'v2' });
    // A local copy open in the panel gives way to its server twin.
    useStore.getState().showArtifact('c1', { ...art('local-x', 'mermaid'), content: 'graph TD' });
    apply(state([art('v1'), art('v2'), { ...art('s3', 'mermaid'), content: 'graph TD' }]));
    expect(open()).toEqual({ chatId: 'c1', id: 's3' });
  });

  it('chat.state carries the run state: an idle missed while offline ends the run', () => {
    const { apply } = useStore.getState();
    apply({ type: 'agent.status', chatId: 'c1', state: 'running' });
    apply({ ...state([]), running: true });
    expect(useStore.getState().agentStatus.c1).toBe('running');
    apply({ ...state([]), running: false });
    expect(useStore.getState().agentStatus.c1).toBe('idle');
  });

  it('a figure upsert with a closed panel opens nothing; an html upsert opens it', () => {
    const { apply } = useStore.getState();
    useStore.getState().setActive('c1');
    apply({ type: 'artifact.upsert', chatId: 'c1', artifact: art('f1', 'mermaid') });
    expect(open()).toBeNull();
    // Not in the chat on screen, or not on the chat screen: nothing opens.
    apply({ type: 'artifact.upsert', chatId: 'c2', artifact: art('p0') });
    expect(open()).toBeNull();
    apply({ type: 'artifact.upsert', chatId: 'c1', artifact: art('p1') });
    expect(open()).toEqual({ chatId: 'c1', id: 'p1' });
  });
});

describe('output modes (phase-23 decision 7)', () => {
  const modes = (chatId: string | null) => effectiveModes(useStore.getState(), chatId);
  const agentsState = () =>
    useStore.getState().apply({
      type: 'agents.state',
      agents: [
        {
          id: 'assistant',
          name: 'Avustaja',
          model: 'zdr/strong',
          subagents: true,
          modes: ['suora'],
        },
        {
          id: 'kirjoittaja',
          name: 'Kirjoittaja',
          model: 'zdr/strong',
          subagents: false,
          modes: [],
        },
      ],
      modes: [
        { id: 'confidence', name: 'Luottamus', description: '', renderer: 'confidence' },
        { id: 'suora', name: 'Suora', description: 'Tiivis' },
      ],
    });

  it('a chat with null modes has its agent default; a list, also an empty one, overrides it', () => {
    agentsState();
    expect(useStore.getState().modes.map((m) => m.id)).toEqual(['confidence', 'suora']);
    const { apply } = useStore.getState();
    apply({
      type: 'chat.list',
      chats: [
        chat('a', false, '2026-01-01T00:00:00.000Z'),
        { ...chat('b', false, '2026-01-02T00:00:00.000Z'), modes: ['confidence'] },
        { ...chat('c', false, '2026-01-03T00:00:00.000Z'), modes: [] },
        { ...chat('d', false, '2026-01-04T00:00:00.000Z'), agentId: 'kirjoittaja' },
      ],
    });
    expect(modes('a')).toEqual(['suora']);
    expect(modes('b')).toEqual(['confidence']);
    expect(modes('c')).toEqual([]);
    expect(modes('d')).toEqual([]);
    // The open chat's summary wins over the list.
    apply({
      type: 'chat.updated',
      chat: { ...chat('a', false, '2026-01-05T00:00:00.000Z'), modes: ['confidence', 'suora'] },
    });
    expect(modes('a')).toEqual(['confidence', 'suora']);
  });

  it('a new chat has the picked agent default until a toggle; chat.created clears the toggle', () => {
    agentsState();
    expect(modes(null)).toEqual(['suora']);
    useStore.getState().setPendingAgentId('kirjoittaja');
    expect(modes(null)).toEqual([]);
    useStore.setState({ pendingModes: ['confidence'] });
    expect(modes(null)).toEqual(['confidence']);
    useStore
      .getState()
      .apply({ type: 'chat.created', chat: chat('n', false, '2026-01-01T00:00:00.000Z') });
    expect(useStore.getState().pendingModes).toBeNull();
    // A stable reference for a selector: the same array on each read.
    expect(modes('unknown')).toBe(modes('unknown'));
  });
});
