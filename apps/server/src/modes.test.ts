import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chats } from '@nolla/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { BUNDLED_AGENTS } from './config.ts';
import { loadModes, modesDir, parseMode, systemPrompt } from './modes.ts';
import { bootChat, connect, runCleanups, seedAgents, tempDir } from './test-utils.ts';

// Phase-23 decisions 1 to 7: output modes.
afterEach(runCleanups);

const bundled = loadModes(modesDir(BUNDLED_AGENTS));
const body = (id: string) => bundled.get(id)?.body ?? '';
const TITLE = {
  match: 'Aiheet:',
  text: JSON.stringify({ title: 'Otsikko', topics: [], proposed_topic: null, summary: 'Kooste' }),
};
type Conn = Awaited<ReturnType<typeof connect>>;
/** Waits for a `chat.updated` with these modes; the title job sends its own ones too. */
const updatedTo = (c: Conn, modes: string[]) =>
  vi.waitFor(() =>
    expect(
      c.inbox.some(
        (m) => m.type === 'chat.updated' && JSON.stringify(m.chat.modes) === JSON.stringify(modes),
      ),
    ).toBe(true),
  );
/** The system prompt of a model call (`developer` for a reasoning model). */
const system = (b: { messages: { role: string; content: unknown }[] } | undefined) =>
  JSON.stringify(b?.messages.find((m) => m.role === 'system' || m.role === 'developer'));

test('frontmatter parse: the shipped modes, and bad files', () => {
  expect([...bundled.keys()]).toEqual(['confidence', 'perusteellinen', 'suora']);
  expect(bundled.get('confidence')).toMatchObject({ name: 'Luottamus', renderer: 'confidence' });
  expect(body('suora')).toBe(
    "high signal, low noise, low verbosity, direct, honest, unfiltered, unhedged, uncensored, match the user's deadpan humor",
  );
  expect(body('confidence')).toMatch(/^Luottamusmerkinnät: .*⟦N⟧/);
  expect(parseMode('x', '---\nname: X\n---\n\nTee näin.\n')).toEqual({
    id: 'x',
    name: 'X',
    description: '',
    body: 'Tee näin.',
  });
  // No frontmatter, an unknown key, an unknown renderer, an empty body, a bad id.
  for (const [id, raw] of [
    ['x', 'Tee näin.'],
    ['x', '---\nname: X\nextra: 1\n---\nTee.'],
    ['x', '---\nname: X\nrenderer: emoji\n---\nTee.'],
    ['x', '---\nname: X\n---\n'],
    ['X Y', '---\nname: X\n---\nTee.'],
  ] as const)
    expect(() => parseMode(id, raw)).toThrow();
});

test('a bad file keeps the previous one; an unchanged mode keeps its object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-modes-'));
  try {
    writeFileSync(join(dir, 'a.md'), '---\nname: A\n---\nEka.');
    writeFileSync(join(dir, 'b.md'), '---\nname: B\n---\nToka.');
    const first = loadModes(dir);
    writeFileSync(join(dir, 'a.md'), '---\nname: A\nbad: 1\n---\nEka.');
    const errors: string[] = [];
    const second = loadModes(dir, (file) => errors.push(file), first);
    expect(errors).toEqual(['a.md']);
    expect(second.get('a')).toBe(first.get('a'));
    expect(second.get('b')).toBe(first.get('b'));
    // A new bad file without a previous version is left out.
    writeFileSync(join(dir, 'c.md'), 'ei frontmatteria');
    expect([...loadModes(dir, () => {}, second).keys()]).toEqual(['a', 'b']);
    expect(loadModes(join(dir, 'ei-ole')).size).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemPrompt: id order, not toggle order; an unknown id is skipped', () => {
  const p = systemPrompt('Profiili.', ['suora', 'poistettu', 'confidence', 'suora'], bundled);
  expect(p).toBe(`Profiili.\n\n${body('confidence')}\n\n${body('suora')}`);
  expect(systemPrompt('Profiili.', [], bundled)).toBe('Profiili.');
});

test('registry: null uses the profile default, a list overrides it; agents.state lists modes', {
  timeout: 30_000,
}, async () => {
  const { c, chat, llm } = await bootChat([{ text: 'Eka.' }, TITLE, { text: 'Toka.' }]);
  expect(chat.modes).toBeNull();
  const state = c.inbox.find((m) => m.type === 'agents.state');
  expect(state).toMatchObject({
    agents: [{ id: 'assistant', modes: ['suora', 'perusteellinen'] }],
    modes: [
      { id: 'confidence', name: 'Luottamus', renderer: 'confidence' },
      { id: 'perusteellinen', name: 'Perusteellinen' },
      { id: 'suora', name: 'Suora' },
    ],
  });
  expect(JSON.stringify(state)).not.toContain(body('suora'));

  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  const first = system(llm.requests[0]?.body);
  expect(first).toContain(body('suora'));
  expect(first).toContain(JSON.stringify(body('perusteellinen')).slice(1, -1));
  expect(first).not.toContain('Luottamusmerkinnät');

  c.send({ type: 'chat.setModes', chatId: chat.id, modes: ['confidence'] });
  await updatedTo(c, ['confidence']);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Taas' });
  await c.idle();
  const second = system(llm.requests.at(-1)?.body);
  expect(second).toContain('Luottamusmerkinnät');
  expect(second).not.toContain(body('suora'));
});

test('a mode file edit rebuilds an idle session; a running one keeps its prompt', {
  timeout: 40_000,
}, async () => {
  const agentsDir = tempDir('pa-agents-');
  seedAgents(agentsDir);
  const file = join(modesDir(agentsDir), 'suora.md');
  const { c, chat, llm } = await bootChat(
    [
      { text: 'Eka.' },
      // A tool call, then the answer: two model calls in one run.
      { toolCalls: [{ name: 'ls', args: {} }], thinkMs: 3000 },
      { text: 'Toka.' },
      { text: 'Kolmas.' },
    ],
    { AGENTS_DIR: agentsDir },
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  expect(system(llm.requests[0]?.body)).toContain(body('suora'));

  c.inbox.length = 0;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Listaa' });
  expect((await c.next('agent.status')).state).toBe('running');
  writeFileSync(file, readFileSync(file, 'utf8').replace(body('suora'), 'Uusi ääni.'));
  // The watcher reloads and tells the screens; the run goes on with its prompt.
  await c.next('agents.state');
  await c.idle();
  expect(llm.requests).toHaveLength(3);
  expect(system(llm.requests[2]?.body)).toContain(body('suora'));
  expect(system(llm.requests[2]?.body)).not.toContain('Uusi ääni.');

  c.send({ type: 'user.message', chatId: chat.id, text: 'Entä nyt?' });
  await c.idle();
  expect(system(llm.requests[3]?.body)).toContain('Uusi ääni.');
});

test('chat.setModes: an unknown id answers bad_message; during a run it writes the row', {
  timeout: 30_000,
}, async () => {
  const { c, chat, srv, config } = await bootChat([
    { text: 'Hetki.', reasoning: 'Mietin.', thinkMs: 1500 },
    TITLE,
  ]);
  const row = () => srv.db.select().from(chats).where(eq(chats.id, chat.id)).get();
  c.send({ type: 'chat.setModes', chatId: chat.id, modes: ['suora', 'ei-ole'] });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: bad_message');
  expect(row()?.modes).toBeNull();

  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  expect((await c.next('agent.status')).state).toBe('running');
  c.send({ type: 'chat.setModes', chatId: chat.id, modes: [] });
  await updatedTo(c, []);
  expect(row()?.modes).toEqual([]);
  await c.idle();

  c.inbox.length = 0;
  c.send({ type: 'chat.setModes', chatId: 'ei-ole', modes: [] });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: not_found');

  // chat.create takes the modes and checks them too.
  const c2 = await connect(config.port);
  c2.send({ type: 'chat.create', modes: ['ei-ole'] });
  await expect(c2.next('chat.created')).rejects.toThrow('server error: bad_message');
  c2.send({ type: 'chat.create', modes: ['confidence'] });
  expect((await c2.next('chat.created')).chat.modes).toEqual(['confidence']);
  await vi.waitFor(() => expect(srv.db.select().from(chats).all()).toHaveLength(2));
});
