import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chats, claims, memoryConsolidations, memoryPending, openDb, topics } from '@pa/db';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { loadModel } from './embeddings.ts';
import { lineDiff, MemoryError, memoryStore } from './memory.ts';
import { indexChat } from './search.ts';
import { bootBroker, bootChat, bootPseudo, cleanups, connect, runCleanups } from './test-utils.ts';

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
const sidecar = async (dictionary: Record<string, string> = {}) => {
  const sc = await startFakeSidecar(dictionary);
  cleanups.push(sc.close);
  return { PSEUDO_URL: sc.url };
};
const memoryDir = (dataDir: string) => join(dataDir, 'memory', 'aleksi');
const add = (t: string, target: 'user' | 'memory' = 'user') => ({
  toolCalls: [{ name: 'memory', args: { action: 'add', target, text: t } }],
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
  'recall finds a fact from a chat dated 8 days ago; since and topic filter it; the result is masked',
  { timeout: 60_000 },
  async () => {
    const day = 86_400_000;
    const iso = (days: number) => new Date(Date.now() - days * day).toISOString();
    const recall = (args: object) => ({
      toolCalls: [{ name: 'recall', args: { query: 'sähkösopimus', ...args } }],
    });
    const { llm, sc, srv, c, chat } = await bootPseudo({ 'Matti Virtanen': 'Pekka Laaksonen' }, [
      recall({}),
      { text: 'Löytyi.' },
      recall({ since: iso(7).slice(0, 10) }),
      { text: 'Ei.' },
      recall({ topic: 't-other' }),
      { text: 'Ei.' },
      recall({ topic: 't-home', since: iso(9) }),
      { text: 'Löytyi.' },
    ]);
    const old = iso(8);
    srv.db
      .insert(topics)
      .values({ id: 't-home', userId: 'aleksi', name: 'Koti', createdAt: old })
      .run();
    srv.db
      .insert(chats)
      .values({
        id: 'old-chat',
        userId: 'aleksi',
        topicId: 't-home',
        title: 'Sähkön kilpailutus',
        titleMasked: 'Sähkön kilpailutus',
        sessionPath: 'sessions/aleksi/',
        createdAt: old,
        updatedAt: old,
      })
      .run();
    // The index holds masked text.
    await indexChat(srv.db, 'aleksi', 'old-chat', [
      { id: 'm1', text: 'Pekka Laaksonen: Sähkösopimus päättyy 30.11.' },
    ]);
    const ask = async (text: string) => {
      c.send({ type: 'user.message', chatId: chat.id, text });
      await c.idle();
    };

    await ask('Milloin se päättyy?');
    const hit = lastTool(llm.requests[1]?.body);
    expect(hit).toContain('päättyy 30.11.');
    expect(hit).toContain('(old-chat)');
    expect(hit).toContain(`[${old.slice(0, 10)}]`);
    // search restored the snippet; tool_result masked it again.
    expect(hit).toContain('Pekka Laaksonen');
    expect(hit).not.toContain('Matti Virtanen');
    expect(
      sc.requests.some(
        (r) => r.path === '/mask' && JSON.stringify(r.body).includes('Matti Virtanen'),
      ),
    ).toBe(true);

    await ask('Entä viime viikolla?');
    expect(lastTool(llm.requests[3]?.body)).not.toContain('old-chat');
    await ask('Muissa aiheissa?');
    expect(lastTool(llm.requests[5]?.body)).not.toContain('old-chat');
    await ask('Kodin aiheessa?');
    expect(lastTool(llm.requests[7]?.body)).toContain('(old-chat)');
  },
);

test('a memory write after bash waits for approval, then applies and commits', {
  timeout: 60_000,
}, async () => {
  const { llm, config, c, chat } = await bootBroker(
    [
      { toolCalls: [{ name: 'bash', args: { command: 'echo hei' } }] },
      add('Sähkösopimus päättyy 30.11.'),
      { text: 'Ok.' },
    ],
    await sidecar(),
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Aja ja muista' });
  const req = await c.next('approval.request');
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  const st = await c.next('memory.state');
  expect(st.pending).toEqual([
    {
      id: expect.any(Number),
      action: 'add',
      target: 'user',
      text: 'Sähkösopimus päättyy 30.11.',
      chatId: chat.id,
    },
  ]);
  expect(st.user).toBe('');
  await c.idle();
  expect(lastTool(llm.requests[2]?.body)).toContain('odottaa hyväksyntääsi');

  c.send({ type: 'memory.approve', pendingId: st.pending[0]?.id ?? 0, approve: true });
  const after = await c.next('memory.state');
  expect(after.user).toBe('Sähkösopimus päättyy 30.11.');
  expect(after.pending).toEqual([]);
  const dir = memoryDir(config.dataDir);
  expect(readFileSync(join(dir, 'USER.md'), 'utf8')).toBe('Sähkösopimus päättyy 30.11.');
  expect(execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })).toContain(
    `memory add user (chat ${chat.id})`,
  );
});

test('an untainted memory write applies at once and the room gets memory.state', {
  timeout: 60_000,
}, async () => {
  const { c, chat } = await bootPseudo({}, [add('Pitää kahvista.'), { text: 'Ok.' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Muista: pidän kahvista.' });
  const st = await c.next('memory.state');
  expect(st.user).toBe('Pitää kahvista.');
  expect(st.pending).toEqual([]);
  await c.idle();
});

test('an over-cap memory write returns an error result', { timeout: 60_000 }, async () => {
  const { llm, c, chat } = await bootPseudo({}, [add('x'.repeat(1600)), { text: 'Ok.' }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Muista tämä.' });
  expect((await c.next('tool.end')).status).toBe('error');
  await c.idle();
  expect(lastTool(llm.requests[1]?.body)).toContain('Muisti on täynnä');
});

test.skipIf(!modelOk)(
  'phase 17: target memory writes claims (untainted active, tainted proposed, remove closes); consolidation regenerates MEMORY.md',
  { timeout: 60_000 },
  async () => {
    const { srv, c, chat, config } = await bootBroker(
      [
        add('Sähkösopimus päättyy 30.11.', 'memory'),
        { text: 'Ok.' },
        { toolCalls: [{ name: 'bash', args: { command: 'echo hei' } }] },
        add('Vieras väite.', 'memory'),
        { text: 'Ok.' },
        {
          toolCalls: [
            { name: 'memory', args: { action: 'remove', target: 'memory', text: 'Sähkösopimus' } },
          ],
        },
        { text: 'Ok.' },
      ],
      await sidecar(),
    );
    const rows = () => srv.db.select().from(claims).orderBy(claims.id).all();
    c.send({ type: 'user.message', chatId: chat.id, text: 'Muista sähkösopimus.' });
    await c.idle();
    expect(rows().map((r) => [r.text, r.status, r.activatedBy])).toEqual([
      ['Sähkösopimus päättyy 30.11.', 'active', 'user'],
    ]);

    // Regeneration: the template, and no commit when the bytes stay the same.
    const dir = memoryDir(config.dataDir);
    const commits = () =>
      execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' })
        .trim()
        .split('\n');
    c.inbox.length = 0; // the write's own memory.state
    c.send({ type: 'memory.consolidate' });
    expect((await c.next('memory.state')).memory).toBe('## Faktat\n- Sähkösopimus päättyy 30.11.');
    const n = commits().length;
    expect(commits()[0]).toBe('memory regenerate (1 claims)');
    c.send({ type: 'memory.consolidate' });
    await c.next('memory.state');
    expect(commits()).toHaveLength(n);
    expect(rows()[0]?.inProfile).toBe(true);

    c.send({ type: 'user.message', chatId: chat.id, text: 'Aja ja muista' });
    const req = await c.next('approval.request');
    c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
    await c.idle();
    expect(rows()[1]).toMatchObject({ text: 'Vieras väite.', status: 'proposed' });

    c.send({ type: 'user.message', chatId: chat.id, text: 'Unohda sähkösopimus.' });
    await c.idle();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({
      status: 'superseded',
      validTo: new Date().toISOString().slice(0, 10),
    });
  },
);

test('an over-cap memory.edit is refused', { timeout: 60_000 }, async () => {
  const { c } = await bootPseudo({}, []);
  c.send({ type: 'memory.edit', target: 'user', text: 'x'.repeat(1600) });
  await expect(c.next('memory.state')).rejects.toThrow('memory_full');
});

test('without the sidecar memory is off', { timeout: 60_000 }, async () => {
  const { srv, chat } = await bootChat([]);
  expect((await srv.registry.get(chat.id)).getActiveToolNames()).not.toContain('memory');
});

test('memory.state goes to every open socket', { timeout: 60_000 }, async () => {
  const { c, config } = await bootPseudo({}, []);
  const other = await connect(config.port);
  c.send({ type: 'memory.edit', target: 'memory', text: 'Jaettu.' });
  expect((await other.next('memory.state')).memory).toBe('Jaettu.');
});

/** The store without a server: pending queue and consolidation edge cases. */
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-memory-'));
  const { db, sqlite } = openDb(join(dir, 'app.db'));
  const now = new Date().toISOString();
  db.insert(chats)
    .values({ id: 'c1', userId: 'aleksi', sessionPath: 's/', createdAt: now, updatedAt: now })
    .run();
  const warnings: string[] = [];
  const m = memoryStore({
    db,
    dataDir: dir,
    userId: 'aleksi',
    warn: (msg) => void warnings.push(msg),
    sendAll: () => {},
  });
  cleanups.push(() => {
    m.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { m, db };
}

test('pending writes: dedupe, cap 5 per chat, a replace whose text is gone fails', async () => {
  const { m, db } = store();
  const w = { action: 'add', target: 'memory', text: 'a' } as const;
  expect(await m.park('c1', w)).toBe(await m.park('c1', w));
  for (const t of ['b', 'c', 'd', 'e']) await m.park('c1', { ...w, text: t });
  await expect(m.park('c1', { ...w, text: 'f' })).rejects.toThrow('liikaa odottavia kirjoituksia');

  // Rejecting one frees a slot.
  expect(await m.approve(1, false)).toBe('rejected');
  m.edit('memory', 'vanha');
  const replaceId = await m.park('c1', {
    action: 'replace',
    target: 'memory',
    text: 'uusi',
    replace: 'vanha',
  });
  m.edit('memory', 'muutettu');
  expect(await m.approve(replaceId, true)).toBe('failed');
  expect(db.select().from(memoryPending).where(eq(memoryPending.id, replaceId)).get()?.status).toBe(
    'failed',
  );
  expect(m.read('memory')).toBe('muutettu');
  expect(await m.approve(replaceId, true)).toBeUndefined();
});

test('an over-cap consolidation edit is refused', () => {
  const { m, db } = store();
  const baseHash = createHash('sha256').update('\0').digest('hex');
  const id = db
    .insert(memoryConsolidations)
    .values({
      userId: 'aleksi',
      diff: 'd',
      proposedUser: 'u',
      proposedMemory: 'm',
      baseHash,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get().id;
  expect(() => m.resolveConsolidation(id, true, { user: 'x'.repeat(1600) })).toThrow(MemoryError);
  expect(m.resolveConsolidation(id, true, { user: 'ok' })).toBe(true);
  expect(m.read('user')).toBe('ok');
});
