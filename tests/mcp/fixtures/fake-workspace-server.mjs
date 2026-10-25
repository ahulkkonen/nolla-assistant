// Fake google_workspace_mcp: same tool names, same text shapes, same {result} structured wrap.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const SECRET = process.env.MCP_SHARED_SECRET ?? 'test-secret';
const created = [];
const events = [
  {
    summary: 'Budjettipalaveri',
    start: '2026-10-27T10:00:00+02:00',
    end: '2026-10-27T11:00:00+02:00',
    description: 'Käydään läpi Q4 luvut Aino Häkkisen kanssa.',
    location: 'Hämeenkatu 12, 33100 Tampere',
    organizer: 'Pekka Laaksonen <pekka.laaksonen@example.fi>',
    attendees: ['aino.hakkinen@example.fi: accepted', 'juha-pekka.nieminen@example.fi: needsAction (optional)'],
  },
];
const out = { result: z.string() };
const wrap = (text) => ({ content: [{ type: 'text', text }], structuredContent: { result: text } });

function build() {
  const s = new McpServer({ name: 'google_workspace', version: 'fake' });
  s.registerTool('get_events', {
    description: 'Retrieves events from a Google Calendar.',
    inputSchema: { time_min: z.string().optional(), detailed: z.boolean().optional() },
    outputSchema: out,
    annotations: { readOnlyHint: true },
  }, async ({ detailed }) => wrap(
    `Successfully retrieved ${events.length} events from calendar 'primary' for user@example.fi:\n` +
    events.map((e) => `- "${e.summary}" (Starts: ${e.start}, Ends: ${e.end})\n` + (detailed
      ? `  Description: ${e.description}\n  Location: ${e.location}\n  Organizer: ${e.organizer}\n` +
        `  Attendees: ${e.attendees.map((a) => a.split(':')[0]).join(', ')}\n  Attendee Details: ${e.attendees.join('\n    ')}\n`
      : '') + '  ID: evt1 | Link: https://www.google.com/calendar/event?eid=ZXZ0MQ').join('\n'),
  ));
  s.registerTool('manage_event', {
    description: 'Manages calendar events. Supports creating, updating, deleting, and RSVP.',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete', 'rsvp']),
      summary: z.string().optional(), start_time: z.string().optional(), end_time: z.string().optional(),
      description: z.string().optional(), attendees: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    },
    outputSchema: out,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args) => {
    created.push(args);
    return wrap(`Successfully created event '${args.summary}' for user@example.fi. Link: https://www.google.com/calendar/event?eid=ZXZ0Mg`);
  });
  return s;
}

const sessions = new Map();
createServer(async (req, res) => {
  if (req.url === '/_created') return res.end(JSON.stringify(created)); // test inspection hook
  if (req.headers['x-mcp-secret'] !== SECRET) { res.statusCode = 401; return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
  let t = sessions.get(req.headers['mcp-session-id']);
  if (!t) {
    t = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => sessions.set(id, t) });
    await build().connect(t);
  }
  await t.handleRequest(req, res, body);
}).listen(Number(process.env.PORT ?? 18100), '127.0.0.1');
