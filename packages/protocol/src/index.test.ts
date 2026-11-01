import { describe, expect, it } from 'vitest';
import {
  AgentFile,
  Annotation,
  ApprovalView,
  AuthLogin,
  artifactExt,
  artifactKind,
  artifactTitle,
  type CatalogModel,
  ClientMessage,
  CONFIDENCE_MARK,
  cronToSchedule,
  decryptCommand,
  ExportStart,
  FETCH_URL_TOOL,
  HARNESS_TOOLS,
  ModeFile,
  ModelId,
  mermaidMeta,
  type Schedule,
  SEARCH_ENTITY_REASON,
  SEARCH_MAX_RESULTS,
  ServerMessage,
  scheduleToCron,
  stripConfidence,
  ToolRow,
  ToolSearch,
  TreeMove,
  TreeQuery,
  TreeSaveArtifact,
  Versions,
  WEB_SEARCH_TOOL,
} from './index.ts';

describe('error frame', () => {
  it('keeps a known code and reads an unknown one as failed', () => {
    const error = (code: string) =>
      ServerMessage.parse({ type: 'error', code, message: 'x' }) as { code: string };
    expect(error('not_found').code).toBe('not_found');
    expect(error('code_from_a_newer_server').code).toBe('failed');
  });
});

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
  it('vault.add trims the text and takes only the kinds the sidecar seeds', () => {
    const add = (kind: string, text: string) =>
      ClientMessage.safeParse({ type: 'vault.add', kind, text });
    expect(add('PERSON', '  Late ').data).toEqual({
      type: 'vault.add',
      kind: 'PERSON',
      text: 'Late',
    });
    expect(add('PERSON', 'x'.repeat(80)).success).toBe(true);
    expect(add('PERSON', 'x'.repeat(81)).success).toBe(false);
    expect(add('PERSON', '   ').success).toBe(false);
    expect(add('SELF', 'Late').success).toBe(false);
    expect(add('ORG', 'Late').success).toBe(false);
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
  it('parses chat.setModel, chat.setDataPolicy, chat.setAutoApprove, models.list and models.favorite', () => {
    for (const m of [
      { type: 'chat.setModel', chatId: 'c1', modelId: 'auto', reasoning: 'auto' },
      { type: 'chat.setModel', chatId: 'c1', modelId: 'openai/gpt-5.5', reasoning: 'none' },
      { type: 'chat.setDataPolicy', chatId: 'c1', dataPolicy: 'open' },
      { type: 'chat.setAutoApprove', chatId: 'c1', on: true },
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
        latest: [{ lab: 'google', modelId: model.id }],
        fetchedAt: null,
      }).success,
    ).toBe(true);
    // Phase 21: an alias is never a `latest` id, and the labs are a fixed list.
    for (const latest of [
      [{ lab: 'anthropic', modelId: '~anthropic/claude-opus-latest' }],
      [{ lab: 'acme', modelId: 'acme/plain' }],
    ])
      expect(
        ServerMessage.safeParse({
          type: 'models.state',
          auto: model.id,
          favorites: [],
          catalog: [model],
          latest,
          fetchedAt: null,
        }).success,
      ).toBe(false);
    const chat = {
      id: 'c1',
      title: null,
      topicId: null,
      agentId: 'assistant',
      pinned: false,
      archived: false,
      modes: null,
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

describe('confidence markers', () => {
  it('strips every marker and nothing else', () => {
    expect(stripConfidence('Varma.⟦9⟧ Ehkä.⟦3⟧\n\n- **Kohta.⟦5⟧**')).toBe(
      'Varma. Ehkä.\n\n- **Kohta.**',
    );
    // Only a digit 1 to 9 between the brackets is a marker.
    expect(stripConfidence('⟦0⟧ ⟦10⟧ ⟦x⟧ [5] ⟦5')).toBe('⟦0⟧ ⟦10⟧ ⟦x⟧ [5] ⟦5');
    expect(CONFIDENCE_MARK.exec('Lause.⟦7⟧')?.[1]).toBe('7');
  });
});

describe('modes', () => {
  it('parses chat.setModes with valid ids only', () => {
    const msg = { type: 'chat.setModes', chatId: 'c1' };
    expect(ClientMessage.safeParse({ ...msg, modes: ['suora', 'confidence'] }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...msg, modes: [] }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...msg, modes: ['Suora'] }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...msg, modes: ['x'.repeat(33)] }).success).toBe(false);
    expect(
      ClientMessage.safeParse({ type: 'chat.setConfidence', chatId: 'c1', on: true }).success,
    ).toBe(false);
  });
  it('ModeFile refuses an unknown key and renderer', () => {
    expect(ModeFile.parse({ name: 'Suora' })).toEqual({ name: 'Suora', description: '' });
    expect(ModeFile.safeParse({ name: 'L', renderer: 'confidence' }).success).toBe(true);
    expect(ModeFile.safeParse({ name: 'L', renderer: 'emoji' }).success).toBe(false);
    expect(ModeFile.safeParse({ name: 'L', extra: 1 }).success).toBe(false);
  });
  it('AgentFile without modes parses to { default: [] }', () => {
    const base = {
      id: 'a',
      name: 'A',
      model: 'zdr/fast',
      prompt: 'prompts/a.md',
      tools: { allow: ['read'] },
    };
    expect(AgentFile.parse(base).modes).toEqual({ default: [] });
    expect(AgentFile.parse({ ...base, modes: { default: ['suora'] } }).modes).toEqual({
      default: ['suora'],
    });
    expect(AgentFile.safeParse({ ...base, modes: { default: ['Bad id'] } }).success).toBe(false);
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

describe('waiting phases (phase 26)', () => {
  const phase = { type: 'message.phase', chatId: 'c1', messageId: 's1', phase: 'sent', at: 1 };
  it('message.phase takes sent or headers and a server time', () => {
    expect(ServerMessage.safeParse(phase).success).toBe(true);
    expect(ServerMessage.safeParse({ ...phase, phase: 'headers' }).success).toBe(true);
    expect(ServerMessage.safeParse({ ...phase, phase: 'thinking' }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...phase, at: -1 }).success).toBe(false);
    expect(ServerMessage.safeParse({ ...phase, at: 1.5 }).success).toBe(false);
  });
  it('message.phase and Message.phases are strict', () => {
    expect(ServerMessage.safeParse({ ...phase, text: 'x' }).success).toBe(false);
    const message = {
      id: 'e1',
      role: 'assistant',
      text: 'vastaus',
      annotations: [],
      attachments: [],
      tools: [],
      createdAt: '2026-10-29T10:00:00.000Z',
    };
    const final = (phases: unknown) => ({
      type: 'message.final',
      chatId: 'c1',
      message: { ...message, phases },
    });
    expect(ServerMessage.safeParse(final({ queueMs: 14000, writeMs: 3000 })).success).toBe(true);
    expect(ServerMessage.safeParse(final({})).success).toBe(true);
    expect(ServerMessage.safeParse(final({ queueMs: -1 })).success).toBe(false);
    expect(ServerMessage.safeParse(final({ sentAt: 1 })).success).toBe(false);
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
  it('chat.edit and chat.version parse; Versions refuses count 1', () => {
    const edit = { type: 'chat.edit', chatId: 'c1', messageId: 'e1', text: 'uusi', localId: 'l1' };
    expect(ClientMessage.safeParse(edit).success).toBe(true);
    expect(ClientMessage.safeParse({ ...edit, text: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...edit, extra: 1 }).success).toBe(false);
    const version = { type: 'chat.version', chatId: 'c1', messageId: 'e1', index: 2 };
    expect(ClientMessage.safeParse(version).success).toBe(true);
    expect(ClientMessage.safeParse({ ...version, index: 0 }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...version, index: 1.5 }).success).toBe(false);
    expect(Versions.safeParse({ index: 2, count: 2 }).success).toBe(true);
    expect(Versions.safeParse({ index: 1, count: 1 }).success).toBe(false);
    expect(Versions.safeParse({ index: 3, count: 2 }).success).toBe(false);
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

describe('phase-15 admin', () => {
  it('schedule presets map to cron and back', () => {
    const cases: [Schedule, string][] = [
      [{ kind: 'daily', hour: 7, minute: 30 }, '30 7 * * *'],
      [{ kind: 'weekdays', hour: 18, minute: 0 }, '0 18 * * 1-5'],
      [{ kind: 'weekly', day: 0, hour: 9, minute: 5 }, '5 9 * * 0'],
      [{ kind: 'weekly', day: 6, hour: 23, minute: 59 }, '59 23 * * 6'],
    ];
    for (const [s, cron] of cases) {
      expect(scheduleToCron(s)).toBe(cron);
      expect(cronToSchedule(cron)).toEqual(s);
    }
    // 7 is Sunday too; anything else is the raw field.
    expect(cronToSchedule('0 8 * * 7')).toEqual({ kind: 'weekly', day: 0, hour: 8, minute: 0 });
    for (const raw of ['*/5 * * * *', '0 7 1 * *', '0 25 * * *', '0 7 * * 1-6', '0 0 7 * * *'])
      expect(cronToSchedule(raw)).toEqual({ kind: 'custom', cron: raw });
    expect(scheduleToCron({ kind: 'custom', cron: ' 0 7 1 * * ' })).toBe('0 7 1 * *');
  });

  it('AgentFile accepts an alias and a catalog model', () => {
    const base = { id: 'a', name: 'A', prompt: 'prompts/a.md', tools: { allow: ['read'] } };
    for (const model of ['zdr/strong', 'zdr/google/gemini-4-argon'])
      expect(AgentFile.safeParse({ ...base, model }).success).toBe(true);
    for (const model of ['open/google/gemini-4-argon', 'zdr/a/b/c', 'strong', 'zdr/'])
      expect(AgentFile.safeParse({ ...base, model }).success).toBe(false);
    expect(AgentFile.parse({ ...base, model: 'zdr/fast' })).toMatchObject({
      skills: [],
      approval: { always: [], never: [] },
      subagents: false,
    });
    expect(AgentFile.safeParse({ ...base, model: 'zdr/fast', extra: 1 }).success).toBe(false);
  });

  it('export state, job and decrypt command', () => {
    const job = {
      id: 'j1',
      status: 'ready',
      masked: true,
      done: 3,
      total: 3,
      error: null,
      size: 1024,
      fileName: 'pa-vienti-2026-10-26-masked.zip.enc',
      createdAt: '2026-10-26T10:00:00.000Z',
      expiresAt: '2026-10-26T11:00:00.000Z',
    };
    expect(ServerMessage.safeParse({ type: 'export.state', job }).success).toBe(true);
    expect(ServerMessage.safeParse({ type: 'export.state', job: null }).success).toBe(true);
    expect(ExportStart.safeParse({ passphrase: 'lyhyt' }).success).toBe(false);
    expect(ExportStart.parse({ passphrase: 'riittävän pitkä' })).toEqual({
      passphrase: 'riittävän pitkä',
      unmask: false,
    });
    expect(decryptCommand(job.fileName)).toBe(
      'openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in pa-vienti-2026-10-26-masked.zip.enc -out pa-vienti-2026-10-26-masked.zip',
    );
  });
});

describe('phase 17 claims messages', () => {
  it('parses review, update and stale; rejects a bad expiry and a long text', () => {
    expect(
      ClientMessage.parse({ type: 'claims.review', id: 3, action: 'accept', validTo: '2027-01' }),
    ).toMatchObject({ id: 3 });
    expect(ClientMessage.parse({ type: 'claims.update', id: 3, validTo: null })).toMatchObject({
      validTo: null,
    });
    expect(ClientMessage.parse({ type: 'claims.stale', id: 3, action: 'lower' })).toMatchObject({
      action: 'lower',
    });
    expect(() =>
      ClientMessage.parse({
        type: 'claims.review',
        id: 3,
        action: 'accept',
        validTo: 'ensi vuonna',
      }),
    ).toThrow();
    expect(() =>
      ClientMessage.parse({ type: 'claims.update', id: 3, text: 'x'.repeat(241) }),
    ).toThrow();
    // A real calendar date only.
    for (const bad of ['2026-02-30', '2026-13', '2026-00-10'])
      expect(() => ClientMessage.parse({ type: 'claims.update', id: 3, validTo: bad })).toThrow();
    expect(
      ClientMessage.parse({ type: 'claims.update', id: 3, validTo: '2028-02-29' }),
    ).toMatchObject({
      validTo: '2028-02-29',
    });
  });
});

describe('mermaidMeta', () => {
  it('reads a title line, but not an edge from a node called title', () => {
    expect(mermaidMeta('flowchart TD\ntitle Prosessi\nA --> B').title).toBe('Prosessi');
    expect(mermaidMeta('flowchart TD\ntitle --> B').title).toBeUndefined();
    expect(mermaidMeta('flowchart TD\ntitle -- kyllä --> B').title).toBeUndefined();
    expect(mermaidMeta('flowchart TD\naccTitle: Kulku\ntitle --> B').title).toBe('Kulku');
  });
});

describe('artifact whitelist', () => {
  it('maps the five fences only', () => {
    expect(['html', 'jsx', 'tsx', 'mermaid', 'vega-lite'].map(artifactKind)).toEqual([
      'html',
      'react',
      'react',
      'mermaid',
      'vega-lite',
    ]);
    for (const lang of ['python', '', 'md', 'svg', 'constructor'])
      expect(artifactKind(lang)).toBeUndefined();
  });

  it('reads the title of each kind', () => {
    expect(artifactTitle('vega-lite', '{"title": "Myynti", "mark": "bar"}')).toBe('Myynti');
    expect(artifactTitle('vega-lite', '{"title": {"text": ["Myynti", "2026"]}}')).toBe(
      'Myynti 2026',
    );
    // A spec that still streams is partial JSON.
    expect(artifactTitle('vega-lite', '{"title": "Myynti", "mark":')).toBeUndefined();
    expect(artifactTitle('mermaid', 'flowchart TD\n  accTitle: Loma &amp; kesä\n  A-->B')).toBe(
      'Loma & kesä',
    );
    expect(artifactTitle('mermaid', '---\ntitle: Kulku\n---\nflowchart TD\nA-->B')).toBe('Kulku');
    expect(artifactTitle('mermaid', 'flowchart TD\nA-->B')).toBeUndefined();
    expect(
      artifactTitle('html', '<html><head><title>Sivu</title></head><h1>Otsikko</h1></html>'),
    ).toBe('Sivu');
    expect(artifactTitle('html', '<h2 class="a">A &amp; <b>B</b></h2>')).toBe('A & B');
    expect(artifactTitle('html', `<p>${'x'.repeat(5000)}</p><h1>Myöhään</h1>`)).toBeUndefined();
    expect(artifactTitle('react', 'export default () => <h1>Laskuri</h1>;')).toBe('Laskuri');
    expect(artifactTitle('react', 'export default () => <div/>;')).toBeUndefined();
  });

  it('gives the file extension of each kind', () => {
    expect(artifactExt({ kind: 'html' })).toBe('html');
    expect(artifactExt({ kind: 'react', language: 'tsx' })).toBe('tsx');
    expect(artifactExt({ kind: 'react', language: 'jsx' })).toBe('jsx');
    expect(artifactExt({ kind: 'mermaid', language: 'mermaid' })).toBe('mmd');
    expect(artifactExt({ kind: 'vega-lite' })).toBe('json');
  });
});

describe('approval views (phase 25)', () => {
  const req = {
    type: 'approval.request',
    chatId: 'c1',
    requestId: 'r1',
    callId: 't1',
    tool: 'profile_edit',
    args: {},
    reason: 'x',
    expiresAt: '2026-10-29T10:00:00.000Z',
  };
  const views = [
    { kind: 'diff', file: 'prompts/assistant.md', created: false, diff: '@@ -1 +1 @@\n-a\n+b' },
    {
      kind: 'yaml',
      file: 'automations/a.yaml',
      created: true,
      yaml: 'id: a\n',
      nextRuns: ['2026-11-03T05:30:00.000Z'],
    },
    {
      kind: 'yaml',
      file: 'automations/a.yaml',
      created: false,
      yaml: 'id: a\nenabled: false\n',
      nextRuns: [],
      enabled: { from: true, to: false },
    },
    {
      kind: 'chat',
      chatId: 'c2',
      title: 'Hei',
      createdAt: '2026-10-01T10:00:00.000Z',
      messages: 4,
      query: null,
    },
    { kind: 'chat', chatId: null, title: null, createdAt: null, messages: null, query: 'loma' },
    { kind: 'fetch', url: 'https://example.com/a' },
  ];
  it('every variant parses on approval.request, with tainted', () => {
    for (const view of views)
      expect(ServerMessage.safeParse({ ...req, view, tainted: true }).success).toBe(true);
  });
  it('a request without view still parses', () => {
    expect(ServerMessage.safeParse(req).success).toBe(true);
  });
  it('views are strict and bounded', () => {
    expect(ApprovalView.safeParse({ ...views[0], extra: 1 }).success).toBe(false);
    expect(ApprovalView.safeParse({ kind: 'other' }).success).toBe(false);
    expect(
      ApprovalView.safeParse({ ...views[1], nextRuns: Array(6).fill('2026-11-03T05:30:00.000Z') })
        .success,
    ).toBe(false);
    expect(ApprovalView.safeParse({ kind: 'fetch', url: 'file:///etc/passwd' }).success).toBe(
      false,
    );
  });
  it('the harness tool list', () => {
    expect(HARNESS_TOOLS).toEqual(['profile_edit', 'automation_edit', 'chat_read']);
    expect(FETCH_URL_TOOL).toBe('fetch_url');
  });
});
