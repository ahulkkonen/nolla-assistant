import { describe, expect, it } from 'vitest';
import {
  Annotation,
  AuthLogin,
  type CatalogModel,
  ClientMessage,
  ModelId,
  SEARCH_ENTITY_REASON,
  SEARCH_MAX_RESULTS,
  ServerMessage,
  ToolRow,
  ToolSearch,
  TreeMove,
  TreeQuery,
  TreeSaveArtifact,
  WEB_SEARCH_TOOL,
} from './index.ts';

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

describe('model messages (phase-10)', () => {
  it('ModelId takes vendor/model only', () => {
    for (const ok of ['google/gemini-4-argon', 'anthropic/claude-opus-5.5', 'x-ai/grok_4'])
      expect(ModelId.safeParse(ok).success).toBe(true);
    for (const bad of [
      '~openai/gpt-sol-latest',
      'acme/model-1:free',
      'Acme/Model',
      'strong',
      'a/b/c',
      `a/${'b'.repeat(100)}`,
    ])
      expect(ModelId.safeParse(bad).success).toBe(false);
  });
  it('chat.create strips a client dataPolicy and takes an optional model', () => {
    const r = ClientMessage.parse({ type: 'chat.create', dataPolicy: 'open' });
    expect(r).toEqual({ type: 'chat.create', agentId: 'assistant' });
    const m = ClientMessage.parse({
      type: 'chat.create',
      model: { modelId: 'anthropic/claude-opus-5.5', reasoning: 'high' },
    });
    expect(m).toMatchObject({ model: { modelId: 'anthropic/claude-opus-5.5', reasoning: 'high' } });
    expect(
      ClientMessage.safeParse({
        type: 'chat.create',
        model: { modelId: 'auto', reasoning: 'max+' },
      }).success,
    ).toBe(false);
  });
  it('parses chat.setModel, chat.setDataPolicy, models.list and models.favorite', () => {
    for (const m of [
      { type: 'chat.setModel', chatId: 'c1', modelId: 'auto', reasoning: 'auto' },
      { type: 'chat.setModel', chatId: 'c1', modelId: 'openai/gpt-5.5', reasoning: 'none' },
      { type: 'chat.setDataPolicy', chatId: 'c1', dataPolicy: 'open' },
      { type: 'models.list' },
      { type: 'models.favorite', modelId: 'openai/gpt-5.5', favorite: true },
    ])
      expect(ClientMessage.safeParse(m).success).toBe(true);
    expect(
      ClientMessage.safeParse({ type: 'chat.setDataPolicy', chatId: 'c1', dataPolicy: 'any' })
        .success,
    ).toBe(false);
    expect(
      ClientMessage.safeParse({ type: 'models.favorite', modelId: 'auto', favorite: true }).success,
    ).toBe(false);
  });
  it('parses models.state and a chat summary with its policy', () => {
    const model: CatalogModel = {
      id: 'google/gemini-4-argon',
      name: 'Gemini 4 Argon',
      zdr: true,
      vision: true,
      contextLength: 1_048_576,
      price: { input: 2, output: 10 },
      reasoning: { efforts: ['high', 'medium', 'low'], recommended: 'medium', mandatory: true },
    };
    expect(
      ServerMessage.safeParse({
        type: 'models.state',
        auto: 'google/gemini-4-argon',
        favorites: [],
        catalog: [model, { ...model, id: 'acme/plain', reasoning: null }],
        fetchedAt: null,
      }).success,
    ).toBe(true);
    const chat = {
      id: 'c1',
      title: null,
      topicId: null,
      agentId: 'assistant',
      pinned: false,
      archived: false,
      updatedAt: new Date().toISOString(),
    };
    const policy = { modelId: null, reasoning: 'auto', dataPolicy: 'zdr' };
    expect(ServerMessage.safeParse({ type: 'chat.updated', chat }).success).toBe(false);
    expect(
      ServerMessage.safeParse({ type: 'chat.updated', chat: { ...chat, modelPolicy: policy } })
        .success,
    ).toBe(true);
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

describe('file routes (phase-11)', () => {
  it('TreeQuery defaults to the work root and coerces the limit', () => {
    expect(TreeQuery.parse({})).toEqual({ root: 'work', path: '', limit: 200 });
    expect(TreeQuery.parse({ root: 'files', limit: '5' }).limit).toBe(5);
    expect(TreeQuery.safeParse({ limit: '501' }).success).toBe(false);
    expect(TreeQuery.safeParse({ root: 'etc' }).success).toBe(false);
  });
  it('paths refuse NUL; the server checks the rest', () => {
    expect(TreeMove.safeParse({ from: 'a\0', to: 'b' }).success).toBe(false);
    expect(TreeMove.safeParse({ from: '../a', to: 'b' }).success).toBe(true);
  });
  it('TreeSaveArtifact saves into the work root by default', () => {
    expect(TreeSaveArtifact.parse({ chatId: 'c1', artifactId: 'a1' }).dir).toBe('');
  });
});

describe('thread depth (phase-13)', () => {
  const usage = {
    model: 'zdr/google/gemini-4-argon',
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 5,
    costUsd: 0.0123,
    estimated: false,
  };
  it('chat.fork needs text; usage.get needs a real month', () => {
    const fork = { type: 'chat.fork', chatId: 'c1', messageId: 'e1', text: 'uusi' };
    expect(ClientMessage.safeParse(fork).success).toBe(true);
    expect(ClientMessage.safeParse({ ...fork, text: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'usage.get', month: '2026-10' }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'usage.get', month: '2026-13' }).success).toBe(false);
    expect(
      ClientMessage.safeParse({ type: 'thinking.get', chatId: 'c1', messageId: 'e1' }).success,
    ).toBe(true);
  });
  it('a message carries usage and thinking; both stay optional', () => {
    const message = {
      id: 'e1',
      role: 'assistant',
      text: 'vastaus',
      annotations: [],
      attachments: [],
      tools: [],
      createdAt: '2026-10-26T10:00:00.000Z',
    };
    const final = { type: 'message.final', chatId: 'c1', message };
    expect(ServerMessage.safeParse(final).success).toBe(true);
    const full = { ...final, message: { ...message, usage, thinking: { ms: 1200 } } };
    expect(ServerMessage.safeParse(full).success).toBe(true);
    const negative = { ...final, message: { ...message, usage: { ...usage, costUsd: -1 } } };
    expect(ServerMessage.safeParse(negative).success).toBe(false);
  });
  it('fx.state takes a rate or null; usage.state lists rows', () => {
    const rate = { usdPerEur: 1.1193, date: '2026-10-23' };
    expect(ServerMessage.safeParse({ type: 'fx.state', rate }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: 'fx.state', rate: null }).success).toBe(true);
    expect(
      ServerMessage.safeParse({ type: 'fx.state', rate: { ...rate, usdPerEur: 0 } }).success,
    ).toBe(false);
    const row = {
      model: usage.model,
      name: 'Gemini 4 Argon',
      calls: 1,
      tokens: 120,
      reasoning: 5,
      costUsd: 0.0123,
      estimated: false,
    };
    expect(
      ServerMessage.safeParse({
        type: 'usage.state',
        month: '2026-10',
        months: ['2026-10'],
        rows: [row],
      }).success,
    ).toBe(true);
  });
});

describe('web search (phase-14)', () => {
  const search = {
    query: 'Helsingin sää',
    results: [{ title: 'Sää', url: 'https://example.com/saa' }],
  };
  const end = { type: 'tool.end', chatId: 'c1', callId: 't1', status: 'ok', summary: '' };
  it('tool.end and ToolRow take an optional search with http(s) links only', () => {
    expect(ServerMessage.safeParse(end).success).toBe(true);
    expect(ServerMessage.safeParse({ ...end, search }).success).toBe(true);
    expect(
      ToolRow.safeParse({ callId: 't1', name: 'web_search', status: 'ok', summary: '', search })
        .success,
    ).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '//example.com'])
      expect(
        ServerMessage.safeParse({ ...end, search: { ...search, results: [{ title: 'x', url }] } })
          .success,
      ).toBe(false);
  });
  it('a search row holds at most SEARCH_MAX_RESULTS citations', () => {
    const results = Array.from({ length: SEARCH_MAX_RESULTS + 1 }, () => search.results[0]);
    expect(ToolSearch.safeParse({ ...search, results }).success).toBe(false);
    expect(WEB_SEARCH_TOOL).toBe('web_search');
    expect(SEARCH_ENTITY_REASON).toBe('Haku sisältää henkilötiedon');
  });
});
