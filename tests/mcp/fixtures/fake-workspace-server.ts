// Fake google_workspace_mcp 2.1.0 (decision 0005): same tool names, same text shapes, same
// `{ result }` structured wrap, same auth-required error text and `/oauth2callback` route.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { listenLocal } from '@pa/fake-llm';
import { cleanups } from '@pa/server/src/test-utils.ts';
import { z } from 'zod';

export type FakeEvent = {
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string;
  organizer: string;
  /** `<email>: <responseStatus>` lines, as the real server prints them. */
  attendees: string[];
};

export const AUTH_URL =
  'https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x&state=abc123&code_challenge_method=S256';

export const BUDGET_MEETING: FakeEvent = {
  summary: 'Budjettipalaveri',
  start: '2026-10-27T10:00:00+02:00',
  end: '2026-10-27T11:00:00+02:00',
  description: 'Käydään läpi Q4 luvut.',
  location: 'Hämeenkatu 12, 33100 Tampere',
  organizer: 'Kaisa Nieminen <kaisa.nieminen@example.fi>',
  attendees: ['kaisa.nieminen@example.fi: accepted', 'user@example.fi: needsAction'],
};

const ACCOUNT = 'user@example.fi';
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const wrap = (t: string) => ({ ...text(t), structuredContent: { result: t } });
const error = (t: string) => ({ ...text(t), isError: true });

function eventText(events: FakeEvent[], detailed: boolean) {
  return (
    `Successfully retrieved ${events.length} events from calendar 'primary' for ${ACCOUNT}:\n` +
    events
      .map(
        (e) =>
          `- "${e.summary}" (Starts: ${e.start}, Ends: ${e.end})\n` +
          (detailed
            ? `  Description: ${e.description}\n  Location: ${e.location}\n  Organizer: ${e.organizer}\n` +
              `  Attendees: ${e.attendees.map((a) => a.split(':')[0]).join(', ')}\n` +
              `  Attendee Details: ${e.attendees.join('\n    ')}\n`
            : '') +
          '  ID: evt1 | Link: https://www.google.com/calendar/event?eid=ZXZ0MQ',
      )
      .join('\n')
  );
}

export async function startFakeWorkspace(opts: { events?: FakeEvent[]; connected?: boolean } = {}) {
  const state = {
    connected: opts.connected ?? true,
    events: opts.events ?? [BUDGET_MEETING],
    /** Tools that answer with an MCP error result. */
    failing: new Set<string>(),
    /** Arguments of every `manage_event` call. */
    created: [] as Record<string, unknown>[],
    /** Query strings that reached `/oauth2callback`. */
    callbacks: [] as string[],
  };
  const guarded =
    <A>(name: string, fn: (args: A) => ReturnType<typeof wrap>) =>
    async (args: A) => {
      if (!state.connected)
        return error(
          `Error calling tool '${name}': **ACTION REQUIRED: Google Authentication Needed for Google Calendar for '${ACCOUNT}'**\n\n` +
            `1. Open this URL in your browser to authorize Google Calendar access using all required permissions:\n   Authorization URL: ${AUTH_URL}\n` +
            '2. After successful authorization, **retry their original command**.',
        );
      if (state.failing.has(name))
        return error(`Error calling tool '${name}': Google API error 500: backendError`);
      return fn(args);
    };
  const out = { result: z.string() };

  function build() {
    const s = new McpServer({ name: 'google_workspace', version: 'fake' });
    s.registerTool(
      'list_calendars',
      { description: 'Lists calendars.', inputSchema: {}, outputSchema: out },
      guarded('list_calendars', () =>
        wrap(
          `Successfully listed 1 calendars for ${ACCOUNT}:\n- "${ACCOUNT}" (Primary) ID: ${ACCOUNT}`,
        ),
      ),
    );
    s.registerTool(
      'get_events',
      {
        description: 'Retrieves events from a Google Calendar.',
        inputSchema: { time_min: z.string().optional(), detailed: z.boolean().optional() },
        outputSchema: out,
        annotations: { readOnlyHint: true },
      },
      guarded('get_events', ({ detailed }: { detailed?: boolean | undefined }) =>
        wrap(eventText(state.events, detailed ?? false)),
      ),
    );
    s.registerTool(
      'manage_event',
      {
        description: 'Manages calendar events. Supports creating, updating, deleting, and RSVP.',
        inputSchema: {
          action: z.enum(['create', 'update', 'delete', 'rsvp']),
          summary: z.string().optional(),
          start_time: z.string().optional(),
          end_time: z.string().optional(),
          description: z.string().optional(),
          attendees: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
        },
        outputSchema: out,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      guarded('manage_event', (args: Record<string, unknown>) => {
        state.created.push(args);
        return wrap(
          `Successfully created event '${String(args.summary)}' for ${ACCOUNT}. Link: https://www.google.com/calendar/event?eid=ZXZ0Mg`,
        );
      }),
    );
    // Exists on the real server with gmail:send; never in infra/mcp.yaml.
    s.registerTool(
      'send_gmail_message',
      {
        description: 'Sends an email.',
        inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
        outputSchema: out,
      },
      guarded('send_gmail_message', () => wrap('Email sent.')),
    );
    return s;
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/oauth2callback') {
      state.callbacks.push(url.search.slice(1));
      state.connected = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<p>Authenticated</p>');
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const id = req.headers['mcp-session-id'];
    let t = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!t) {
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => void sessions.set(sid, created),
      });
      t = created;
      // The SDK's own types disagree under exactOptionalPropertyTypes.
      await build().connect(t as unknown as Parameters<McpServer['connect']>[0]);
    }
    await t.handleRequest(req, res, body);
  });
  const { origin, close } = await listenLocal(server);
  return { origin, mcpUrl: `${origin}/mcp`, state, close };
}

/** Starts the fake and writes an `mcp.yaml` for it; both are removed by `runCleanups`. */
export async function startWorkspaceConfig(
  opts: Parameters<typeof startFakeWorkspace>[0],
  tools: string[],
  writes: string[] = [],
) {
  const ws = await startFakeWorkspace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'pa-mcp-'));
  cleanups.push(ws.close, () => rmSync(dir, { recursive: true, force: true }));
  const yaml = join(dir, 'mcp.yaml');
  writeFileSync(
    yaml,
    `servers:\n  workspace:\n    url: ${ws.mcpUrl}\n    tools:\n` +
      tools.map((t) => `      - { name: ${t}, write: ${writes.includes(t)} }\n`).join(''),
  );
  return { ws, yaml };
}
