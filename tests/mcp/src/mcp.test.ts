// Phase-6 gate (plan section 13, decision 0005): MCP writes need approval and run with real values;
// MCP results are masked before they reach the session or the model.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FakeTurn } from '@pa/fake-llm';
import { bootPseudo, runCleanups } from '@pa/server/src/test-utils.ts';
import { afterEach, expect, test } from 'vitest';
import { startWorkspaceConfig } from '../fixtures/fake-workspace-server.ts';

afterEach(runCleanups);

const USER = { 'Aleksi Hulkkonen': 'Matti Virtanen' };
const ALLOWED = ['list_calendars', 'get_events', 'manage_event'];

async function bootMcp(turns: FakeTurn[]) {
  const { ws, yaml } = await startWorkspaceConfig({}, ALLOWED, ['manage_event']);
  const b = await bootPseudo({ ...USER }, turns, { learn: true }, { MCP_CONFIG: yaml });
  const jsonl = () => {
    const files = readdirSync(b.srv.registry.sessionDir, { recursive: true, encoding: 'utf8' });
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(b.srv.registry.sessionDir, f), 'utf8'))
      .join('\n');
  };
  const sent = () => b.llm.requests.map((r) => JSON.stringify(r.body)).join('\n');
  return { ...b, ws, jsonl, sent };
}

test('(a) manage_event asks with real values and the server gets real values', async () => {
  // The fake sidecar learns the address first (id 2), so the model sees `henkilo2@example.invalid`.
  const { c, chat, ws, sent } = await bootMcp([
    {
      toolCalls: [
        {
          name: 'mcp__workspace__manage_event',
          args: {
            action: 'create',
            summary: 'Kahvit Matti Virtanen',
            start_time: '2026-10-28T09:00:00+02:00',
            end_time: '2026-10-28T09:30:00+02:00',
            attendees: ['henkilo2@example.invalid'],
          },
        },
      ],
    },
    { text: 'Varattu.' },
  ]);
  c.send({
    type: 'user.message',
    chatId: chat.id,
    text: 'Varaa kahvit: kaisa.nieminen@example.fi',
  });
  const req = await c.next('approval.request');
  expect(req.tool).toBe('mcp__workspace__manage_event');
  expect(req.args).toMatchObject({
    summary: 'Kahvit Aleksi Hulkkonen',
    attendees: ['kaisa.nieminen@example.fi'],
  });
  expect(ws.state.created).toEqual([]);
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  expect((await c.next('tool.end')).status).toBe('ok');
  await c.idle();
  expect(ws.state.created).toEqual([
    expect.objectContaining({
      summary: 'Kahvit Aleksi Hulkkonen',
      attendees: ['kaisa.nieminen@example.fi'],
    }),
  ]);
  expect(sent()).not.toContain('kaisa.nieminen@example.fi');
  expect(sent()).not.toContain('Aleksi Hulkkonen');
});

test('(b, c, d) a fetched attendee is masked in the session and in model requests', async () => {
  const { c, chat, sc, llm, jsonl, sent } = await bootMcp([
    { toolCalls: [{ name: 'mcp__workspace__get_events', args: { detailed: true } }] },
    { text: 'Sinulla on yksi tapaaminen.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Mitä kalenterissa?' });
  expect((await c.next('tool.end')).status).toBe('ok');
  await c.idle();
  // (b) the result went through /mask (content and structuredContent), the JSONL holds no real value.
  const masks = sc.requests.filter((r) => r.path === '/mask').map((r) => JSON.stringify(r.body));
  const masked = masks.find((m) => m.includes('Kaisa Nieminen'));
  expect(masked).toBeDefined();
  expect(masked).toContain('structuredContent');
  for (const real of ['Kaisa Nieminen', 'kaisa.nieminen@example.fi']) {
    expect(jsonl()).not.toContain(real);
    // (c) masked-only: no model request holds the real value.
    expect(sent()).not.toContain(real);
  }
  expect(sent()).toContain('Budjettipalaveri');
  // (d) only allowlisted tools are declared; the server's send_gmail_message and codemode are not.
  const names: string[] = llm.requests[0]?.body.tools.map(
    (t: { function: { name: string } }) => t.function.name,
  );
  expect(names.filter((n) => n.startsWith('mcp__')).sort()).toEqual(
    ALLOWED.map((t) => `mcp__workspace__${t}`).sort(),
  );
  expect(names).not.toContain('mcp__workspace__send_gmail_message');
  expect(names).not.toContain('codemode');
});

test('(e) an MCP error result is a tool error and the chat continues', async () => {
  const { c, chat, ws, llm } = await bootMcp([
    { toolCalls: [{ name: 'mcp__workspace__get_events', args: {} }] },
    { text: 'Kalenteri ei vastaa.' },
  ]);
  ws.state.failing.add('get_events');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Mitä kalenterissa?' });
  expect((await c.next('tool.end')).status).toBe('error');
  await c.idle();
  expect(JSON.stringify(llm.requests[1]?.body)).toContain('Google API error 500');
});
