import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, chunks } from '@pa/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { loadModel } from './embeddings.ts';
import { lineDiff } from './memory.ts';
import { indexChat } from './search.ts';
import { bootChat, bootPseudo, bootResearch, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const modelOk = await loadModel().then(
  () => true,
  () => false,
);
type Msg = { role: string; content: unknown };
const text = (m: Msg | undefined) =>
  typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
const messages = (body: { messages: Msg[] } | undefined) => body?.messages ?? [];
const lastTool = (body: { messages: Msg[] } | undefined) =>
  text(messages(body).findLast((m) => m.role === 'tool'));
const memoryDir = (dataDir: string) => join(dataDir, 'memory', 'aleksi');
const add = (t: string) => ({
  toolCalls: [{ name: 'memory', args: { action: 'add', target: 'memory', text: t } }],
});

test('lineDiff marks removed and added lines', () => {
  expect(lineDiff('M.md', 'a\nb\nc', 'a\nc\nd')).toBe(
    '--- a/M.md\n+++ b/M.md\n@@ -1,3 +1,3 @@\n a\n-b\n c\n+d',
  );
  expect(lineDiff('M.md', 'x', 'x')).toBe('');
});

test('injected memory is masked and byte-stable across two turns', {
  timeout: 60_000,
}, async () => {
  const { llm, sc, c, chat } = await bootPseudo({ 'Aleksi Hulkkonen': 'Pekka Laaksonen' }, [
    { text: 'Hei.' },
    { text: 'Hyvää.' },
  ]);
  c.send({
    type: 'memory.edit',
    target: 'user',
    text: 'Nimi: Aleksi Hulkkonen\nAsuu Helsingissä.',
  });
  expect((await c.next('memory.state')).user).toContain('Aleksi Hulkkonen');
  for (const t of ['Hei', 'Mitä kuuluu?']) {
    c.send({ type: 'user.message', chatId: chat.id, text: t });
    await c.idle();
  }
  const injected = llm.requests
    .slice(0, 2)
    .map((r) => text(messages(r.body).findLast((m) => text(m).includes('## Käyttäjä'))));
  expect(injected[0]).toContain('Pekka Laaksonen');
  expect(injected[0]).toContain('## Muisti');
  expect(injected[0]).not.toContain('Aleksi Hulkkonen');
  expect(injected[1]).toBe(injected[0]);
  // Masked once through /mask, then served from the cache.
  const masks = sc.requests.filter(
    (r) => r.path === '/mask' && String(r.body.text).startsWith('## Käyttäjä'),
  );
  expect(masks).toHaveLength(1);
});

test.skipIf(!modelOk)(
  'recall finds a fact from a chat dated 8 days ago',
  {
    timeout: 60_000,
  },
  async () => {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const { llm, srv, c, chat } = await bootChat([
      { toolCalls: [{ name: 'recall', args: { query: 'sähkösopimus' } }] },
      { text: 'Löytyi.' },
      { toolCalls: [{ name: 'recall', args: { query: 'sähkösopimus', since } }] },
      { text: 'Ei löytynyt.' },
    ]);
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    srv.db
      .insert(chats)
      .values({
        id: 'old-chat',
        userId: 'aleksi',
        title: 'Sähkön kilpailutus',
        titleMasked: 'Sähkön kilpailutus',
        sessionPath: 'sessions/aleksi/',
        createdAt: old,
        updatedAt: old,
      })
      .run();
    await indexChat(srv.db, 'aleksi', 'old-chat', [
      { id: 'm1', text: 'Sähkösopimus päättyy 30.11.' },
    ]);
    srv.db.update(chunks).set({ createdAt: old }).where(eq(chunks.chatId, 'old-chat')).run();

    c.send({ type: 'user.message', chatId: chat.id, text: 'Milloin se päättyy?' });
    await c.idle();
    const hit = lastTool(llm.requests[1]?.body);
    expect(hit).toContain('päättyy 30.11.');
    expect(hit).toContain('(old-chat)');
    expect(hit).toContain(`[${old.slice(0, 10)}]`);

    c.send({ type: 'user.message', chatId: chat.id, text: 'Entä viime viikolla?' });
    await c.idle();
    expect(lastTool(llm.requests[3]?.body)).not.toContain('old-chat');
  },
);

test('a memory write after bash waits for approval, then applies and commits', {
  timeout: 60_000,
}, async () => {
  const { llm, config, c, chat } = await bootResearch([
    { toolCalls: [{ name: 'bash', args: { command: 'echo hei' } }] },
    add('Sähkösopimus päättyy 30.11.'),
    { text: 'Ok.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Aja ja muista' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  const st = await c.next('memory.state');
  expect(st.pending).toEqual([
    {
      id: expect.any(Number),
      action: 'add',
      target: 'memory',
      text: 'Sähkösopimus päättyy 30.11.',
      chatId: chat.id,
    },
  ]);
  expect(st.memory).toBe('');
  await c.idle();
  expect(lastTool(llm.requests[2]?.body)).toContain('odottaa hyväksyntääsi');

  c.send({ type: 'memory.approve', pendingId: st.pending[0]?.id ?? 0, approve: true });
  const after = await c.next('memory.state');
  expect(after.memory).toBe('Sähkösopimus päättyy 30.11.');
  expect(after.pending).toEqual([]);
  const dir = memoryDir(config.dataDir);
  expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('Sähkösopimus päättyy 30.11.');
  expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })).toContain(
    `memory add memory (chat ${chat.id})`,
  );
});

test('an untainted memory write applies at once and the room gets memory.state', {
  timeout: 60_000,
}, async () => {
  const { c, chat } = await bootChat([add('Pitää kahvista.'), { text: 'Ok.' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Muista: pidän kahvista.' });
  const st = await c.next('memory.state');
  expect(st.memory).toBe('Pitää kahvista.');
  expect(st.pending).toEqual([]);
  await c.idle();
});

test('an over-cap memory write returns an error result', { timeout: 60_000 }, async () => {
  const { llm, c, chat } = await bootChat([add('x'.repeat(2600)), { text: 'Ok.' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Muista tämä.' });
  expect((await c.next('tool.end')).status).toBe('error');
  await c.idle();
  expect(lastTool(llm.requests[1]?.body)).toContain('Muisti on täynnä');
});

test('consolidation stores a diff and accepting writes the files', {
  timeout: 60_000,
}, async () => {
  const proposal = { user: 'Nimi: Aleksi', memory: 'Sähkösopimus päättyy 30.11.' };
  const { llm, c, config } = await bootChat([{ text: JSON.stringify(proposal) }]);
  c.send({
    type: 'memory.edit',
    target: 'memory',
    text: 'Sähkösopimus päättyy 30.11.\nSähkösopimus päättyy marraskuussa.',
  });
  await c.next('memory.state');
  c.send({ type: 'memory.consolidate' });
  const st = await c.next('memory.state');
  expect(llm.requests[0]?.body.model).toBe('zdr/task-small');
  expect(st.consolidation?.diff).toContain('-Sähkösopimus päättyy marraskuussa.');
  expect(st.consolidation?.diff).toContain('+Nimi: Aleksi');

  c.send({ type: 'memory.consolidation.resolve', id: st.consolidation?.id ?? 0, accept: true });
  const after = await c.next('memory.state');
  expect(after).toMatchObject({ ...proposal, consolidation: null });
  expect(readFileSync(join(memoryDir(config.dataDir), 'USER.md'), 'utf8')).toBe(proposal.user);
});
