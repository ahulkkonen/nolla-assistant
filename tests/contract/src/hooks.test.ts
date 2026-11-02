import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import type { FakeTurn } from '@nolla/fake-llm';
import { describe, expect, test } from 'vitest';
import {
  eventOf,
  keysOf,
  lastUserText,
  probe,
  type Seen,
  setup,
  toolMessageContent,
} from './harness.ts';

// Compile-time contract: these names fail `typecheck` if Pi removes or renames them.
const apiNames: (keyof ExtensionAPI)[] = [
  'on',
  'registerTool',
  'registerCommand',
  'appendEntry',
  'sendMessage',
  'setSessionName',
  'getActiveTools',
  'setActiveTools',
  'registerMcpServer',
];
const ctxNames: (keyof ExtensionContext)[] = ['ui', 'sessionManager', 'model', 'isIdle', 'abort'];
const toolResultNames: (keyof ToolResultEvent)[] = [
  'toolCallId',
  'toolName',
  'input',
  'content',
  'structuredContent',
  'isError',
];

const readTurn = { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] };
const types = (seen: Seen[], type: string) => seen.filter((s) => s.type === type);
const note = { 'note.txt': 'NOTE' };

/** Boot with one probe, write files into cwd, run one prompt. */
async function run(
  turns: FakeTurn[],
  handlers: Parameters<typeof probe>[1] = {},
  files: Record<string, string> = {},
  extra: ExtensionFactory[] = [],
  tools?: string[],
) {
  const seen: Seen[] = [];
  const pi = await setup(turns, [...extra, probe(seen, handlers)], tools ? { tools } : {});
  for (const [f, c] of Object.entries(files)) writeFileSync(join(pi.cwd, f), c);
  await pi.session.prompt('hi');
  return { seen, ...pi };
}

const ok = [{ text: 'ok' }];
const readThenDone = [readTurn, { text: 'done' }];

describe('input', () => {
  test('payload keys; transforms chain A then B', async () => {
    const a: Seen[] = [];
    const { seen: b, llm } = await run(
      ok,
      { input: (e) => ({ action: 'transform', text: `${e.text} [B]` }) },
      {},
      [probe(a, { input: (e) => ({ action: 'transform', text: `${e.text} [A]` }) })],
    );
    expect(keysOf(a, 'input')).toEqual(['images', 'source', 'streamingBehavior', 'text', 'type']);
    expect(eventOf(a, 'input').source).toBe('interactive');
    expect(eventOf(b, 'input').text).toBe('hi [A]');
    expect(lastUserText(llm.requests[0]?.body)).toBe('hi [A] [B]');
  });

  test('handled stops the run and later input handlers', async () => {
    const { seen: b, llm } = await run(ok, {}, {}, [
      probe([], { input: () => ({ action: 'handled' }) }),
    ]);
    expect(llm.requests).toHaveLength(0);
    expect(types(b, 'input')).toHaveLength(0);
    expect(types(b, 'agent_start')).toHaveLength(0);
  });
});

describe('before_agent_start', () => {
  test('payload keys and injected message', async () => {
    const { seen, llm } = await run(ok, {
      before_agent_start: () => ({
        message: { customType: 'probe', content: 'INJECTED-MEMORY', display: false },
      }),
    });
    expect(keysOf(seen, 'before_agent_start')).toEqual([
      'images',
      'messageType',
      'prompt',
      'systemPrompt',
      'systemPromptOptions',
      'type',
    ]);
    const e = eventOf(seen, 'before_agent_start');
    expect(typeof e.systemPrompt).toBe('string');
    expect(typeof e.systemPromptOptions).toBe('object');
    expect(e.messageType).toBe('user');
    expect(e.prompt).toBe('hi');
    const injected = llm.requests[0]?.body.messages.filter((m: any) =>
      JSON.stringify(m.content).includes('INJECTED-MEMORY'),
    );
    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe('user');
  });

  test('returned systemPrompt replaces the system message', async () => {
    const { llm } = await run(ok, { before_agent_start: () => ({ systemPrompt: 'PROBE SYSTEM' }) });
    const first = llm.requests[0]?.body.messages[0];
    expect(first.role).toBe('system');
    expect(first.content).toBe('PROBE SYSTEM');
  });
});

describe('tool_call', () => {
  test('payload keys; mutating input.path changes the read', async () => {
    const { seen, llm } = await run(
      readThenDone,
      {
        tool_call: (e) => {
          e.input.path = 'other.txt';
        },
      },
      { ...note, 'other.txt': 'OTHER' },
    );
    expect(keysOf(seen, 'tool_call')).toEqual(['input', 'toolCallId', 'toolName', 'type']);
    const e = eventOf(seen, 'tool_call');
    expect(typeof e.toolCallId).toBe('string');
    expect(e.toolName).toBe('read');
    expect(eventOf(seen, 'tool_result').content).toEqual([{ type: 'text', text: 'OTHER' }]);
    expect(toolMessageContent(llm.requests[1]?.body)).toBe('OTHER');
  });

  test('block returns an error result and the tool does not run', async () => {
    const { seen, llm, sessionManager } = await run(
      readThenDone,
      { tool_call: () => ({ block: true, reason: 'nope' }) },
      note,
    );
    const result = sessionManager
      .getEntries()
      .flatMap((x) =>
        x.type === 'message' && x.message.role === 'toolResult' ? [x.message] : [],
      )[0];
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain('nope');
    expect(JSON.stringify(result?.content)).not.toContain('NOTE');
    expect(toolMessageContent(llm.requests[1]?.body)).toContain('nope');
    // A blocked call emits no tool_result event in 1.3.0.
    expect(types(seen, 'tool_result')).toHaveLength(0);
  });
});

describe('tool_result', () => {
  test('payload keys; content replace reaches the model', async () => {
    const { seen, llm } = await run(
      readThenDone,
      { tool_result: () => ({ content: [{ type: 'text', text: 'MASKED' }] }) },
      note,
    );
    expect(keysOf(seen, 'tool_result')).toEqual([
      'content',
      'details',
      'input',
      'isError',
      'structuredContent',
      'toolCallId',
      'toolName',
      'type',
      'usage',
    ]);
    expect(toolMessageContent(llm.requests[1]?.body)).toBe('MASKED');
  });

  test('read payload values, including string structuredContent', async () => {
    let snapshot: unknown;
    await run(
      readThenDone,
      {
        tool_result: (e) => {
          snapshot = structuredClone(e);
        },
      },
      note,
    );
    expect(snapshot).toEqual({
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call_1',
      input: { path: 'note.txt' },
      content: [{ type: 'text', text: 'NOTE' }],
      details: undefined,
      structuredContent: 'NOTE',
      isError: false,
      usage: undefined,
    });
  });

  test('content without structuredContent drops it; both keeps it', async () => {
    const custom: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: 'sc',
        label: 'sc',
        description: 'returns structured content',
        // Plain JSON schema: typebox is not a direct dependency of this package.
        parameters: { type: 'object', properties: {} } as never,
        execute: async () => ({
          content: [{ type: 'text', text: 'RAW' }],
          structuredContent: { secret: 'S' },
          details: {},
        }),
      });
    };
    const call = (id: string) => ({ toolCalls: [{ id, name: 'sc', args: {} }] });
    const { seen } = await run(
      [call('c1'), call('c2'), call('c3'), { text: 'done' }],
      {
        tool_result: (e) => {
          if (e.toolCallId === 'c2') return { content: [{ type: 'text', text: 'C' }] };
          if (e.toolCallId === 'c3')
            return {
              content: [{ type: 'text', text: 'C' }],
              structuredContent: e.structuredContent,
            };
        },
      },
      {},
      [custom],
      // The SDK `tools` allowlist also filters extension tools.
      ['read', 'write', 'edit', 'sc'],
    );
    const ends = types(seen, 'tool_execution_end').map((s) => s.event);
    expect(ends.map((x) => x.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(ends[0].result.structuredContent).toEqual({ secret: 'S' });
    expect('structuredContent' in ends[1].result).toBe(false);
    expect(ends[2].result.structuredContent).toEqual({ secret: 'S' });
    // The ToolResultMessage (agent_end, session file) never carries structuredContent in 1.3.0.
    const msgs = eventOf(seen, 'agent_end').messages.filter((m: any) => m.role === 'toolResult');
    expect(msgs).toHaveLength(3);
    for (const m of msgs) expect('structuredContent' in m).toBe(false);
  });
});

describe('context_with_system', () => {
  test('payload has system message first; returned messages reach the model', async () => {
    const { seen, llm } = await run(ok, {
      context_with_system: (e) => ({
        messages: e.messages.map((m: any, i: number) =>
          i === e.messages.length - 1 && m.role === 'user'
            ? { ...m, content: [{ type: 'text', text: 'CHANGED' }] }
            : m,
        ),
      }),
    });
    expect(keysOf(seen, 'context_with_system')).toEqual(['messages', 'type']);
    expect(eventOf(seen, 'context_with_system').messages[0].role).toBe('system');
    expect(eventOf(seen, 'context').messages.some((m: any) => m.role === 'system')).toBe(false);
    expect(lastUserText(llm.requests[0]?.body)).toBe('CHANGED');
  });
});

describe('run lifecycle', () => {
  test('agent_start, turn_start, turn_end, agent_end, agent_settled order and keys', async () => {
    const { seen } = await run([{ text: 'hello' }]);
    const lifecycle = ['agent_start', 'turn_start', 'turn_end', 'agent_end', 'agent_settled'];
    expect(seen.map((s) => s.type).filter((t) => lifecycle.includes(t))).toEqual(lifecycle);
    expect(keysOf(seen, 'agent_start')).toEqual(['type']);
    expect(keysOf(seen, 'turn_start')).toEqual(['timestamp', 'turnIndex', 'type']);
    expect(eventOf(seen, 'turn_start').turnIndex).toBe(0);
    expect(keysOf(seen, 'turn_end')).toEqual([
      'context',
      'continue',
      'entries',
      'message',
      'messageEntryId',
      'outcome',
      'toolResultEntryIds',
      'toolResults',
      'turnIndex',
      'type',
    ]);
    expect(eventOf(seen, 'turn_end').toolResults).toEqual([]);
    expect(eventOf(seen, 'turn_end').message.role).toBe('assistant');
    expect(keysOf(seen, 'agent_end')).toEqual(['messages', 'type']);
    expect(keysOf(seen, 'agent_settled')).toEqual(['aborted', 'type']);
    expect(eventOf(seen, 'agent_settled').aborted).toBe(false);
  });

  test('message_update and message_end payloads', async () => {
    const updateTypes: string[] = [];
    const { seen } = await run([{ text: 'hello' }], {
      message_update: (e) => void updateTypes.push(e.assistantMessageEvent.type),
    });
    expect(keysOf(seen, 'message_update')).toEqual(['assistantMessageEvent', 'message', 'type']);
    // `start` and `done` are not delivered as message_update in 1.3.0.
    expect(updateTypes).toEqual(['text_start', 'text_delta', 'text_end']);
    expect(keysOf(seen, 'message_end')).toEqual(['message', 'type']);
    // 1.3.0 also emits message_start/message_end for the system message.
    expect(types(seen, 'message_end').map((s) => s.event.message.role)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
  });
});

describe('appendEntry', () => {
  test('custom entry is persisted and not sent to the model', async () => {
    const { llm, sessionManager } = await run(ok, {}, {}, [
      (pi) => void pi.on('input', () => void pi.appendEntry('probe-spans', { a: 1 })),
    ]);
    const custom = sessionManager.getEntries().filter((e) => e.type === 'custom');
    expect(custom).toHaveLength(1);
    const [entry] = custom;
    expect(entry?.type).toBe('custom');
    expect(entry && 'customType' in entry && entry.customType).toBe('probe-spans');
    expect(entry && 'data' in entry && entry.data).toEqual({ a: 1 });
    for (const r of llm.requests)
      expect(JSON.stringify(r.body.messages)).not.toContain('probe-spans');
  });
});

describe('ExtensionAPI and ExtensionContext members', () => {
  test('runtime members are functions or objects', async () => {
    let api: Record<string, unknown> = {};
    let ctx: Record<string, any> = {};
    await run(
      ok,
      {
        input: (_e, c) => {
          ctx = c as never;
        },
      },
      {},
      [
        (pi) => {
          api = pi as never;
        },
      ],
    );
    for (const name of apiNames) expect(typeof api[name], name).toBe('function');
    for (const name of ctxNames) expect(ctx[name], name).toBeDefined();
    expect(typeof ctx.ui.confirm).toBe('function');
    expect(typeof ctx.sessionManager.getEntries).toBe('function');
    expect(ctx.model.provider).toBe('zdr');
    expect(ctx.model.id).toBe('zdr/strong');
    expect(typeof ctx.isIdle).toBe('function');
    expect(typeof ctx.abort).toBe('function');
    expect(toolResultNames).toContain('structuredContent');
  });
});
