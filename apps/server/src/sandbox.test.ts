import { afterEach, expect, test } from 'vitest';
import { boot, bootResearch, connect, runCleanups } from './test-utils.ts';

afterEach(runCleanups);
test('bash runs through the broker after approval', { timeout: 30_000 }, async () => {
  const { c, chat, srv, broker } = await bootResearch([
    { toolCalls: [{ name: 'bash', args: { command: 'echo hei' } }] },
    { text: 'Valmis.' },
  ]);
  expect((await srv.registry.get(chat.id)).getActiveToolNames()).toContain('bash');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Aja komento' });
  const req = await c.next('approval.request');
  expect(req).toMatchObject({ tool: 'bash', args: { command: 'echo hei' } });
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  const end = await c.next('tool.end');
  expect(end.status).toBe('ok');
  expect(end.summary).toContain('hei');
  await c.idle();
  expect(broker.requests[0]?.body).toMatchObject({ chatId: chat.id, command: 'echo hei' });
});

test("without the broker a profile with bash never gets Pi's bash", {
  timeout: 30_000,
}, async () => {
  const { config, run } = await boot([]);
  const srv = await run();
  const c = await connect(config.port);
  c.send({ type: 'chat.create', agentId: 'research' });
  const { chat } = await c.next('chat.created');
  const tools = (await srv.registry.get(chat.id)).getActiveToolNames();
  expect(tools).toContain('read');
  expect(tools).not.toContain('bash');
});

test('a subagent child runs bash through the broker', { timeout: 60_000 }, async () => {
  const { c, chat, broker } = await bootResearch([
    {
      toolCalls: [
        { name: 'subagent', args: { mode: 'single', tasks: [{ label: 'a', task: 'aja' }] } },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'echo lapsi' } }] },
    { text: 'child result' },
    { text: 'Valmis.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Delegoi' });
  const req = await c.next('approval.request');
  expect(req.tool).toBe('bash');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  await c.idle();
  expect(broker.requests.map((r) => r.body.command)).toEqual(['echo lapsi']);
});
