import { chats, chunks } from '@pa/db';
import { ChatExport } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { BUNDLED_AGENTS } from './config.ts';
import { loadModes, modesDir } from './modes.ts';
import { api, bootChat, login, runCleanups } from './test-utils.ts';

// Phase-21 decision 4: the confidence trial; phase 23 made it the mode `confidence`.
afterEach(runCleanups);

const CONFIDENCE_PROMPT = loadModes(modesDir(BUNDLED_AGENTS)).get('confidence')?.body ?? '';

const MARKED = 'Helsinki on pääkaupunki.⟦9⟧ Väkiluku on noin 690 000.⟦6⟧';
const PLAIN = 'Helsinki on pääkaupunki. Väkiluku on noin 690 000.';
const TITLE = {
  match: 'Aiheet:',
  text: JSON.stringify({ title: 'Otsikko', topics: [], proposed_topic: null, summary: 'Kooste' }),
};
/** The system prompt of a model call (`developer` for a reasoning model). */
const system = (body: { messages: { role: string; content: unknown }[] }) =>
  JSON.stringify(body.messages.find((m) => m.role === 'system' || m.role === 'developer'));

test('chat.setModes confidence: stored, also during a run; the next turn has the prompt, off removes it', {
  timeout: 30_000,
}, async () => {
  const { c, chat, srv, llm } = await bootChat([
    // The thinking keeps the run going while the toggle arrives.
    { text: 'Ensin ilman.', reasoning: 'Mietin hetken.', thinkMs: 1500 },
    { text: MARKED },
    TITLE,
    { text: 'Taas ilman.' },
  ]);
  const row = () => srv.db.select().from(chats).where(eq(chats.id, chat.id)).get();
  expect(chat.modes).toBeNull();

  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  expect((await c.next('agent.status')).state).toBe('running');
  c.send({ type: 'chat.setModes', chatId: chat.id, modes: ['confidence'] });
  expect((await c.next('chat.updated')).chat.modes).toEqual(['confidence']);
  expect(row()?.modes).toEqual(['confidence']);
  await c.idle();
  expect(system(llm.requests[0]?.body)).not.toContain(CONFIDENCE_PROMPT);

  c.inbox.length = 0;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kerro Helsingistä' });
  // Pi's text and the thread keep the markers; the web renders them.
  expect((await c.next('message.final')).message.text).toBe(MARKED);
  await c.idle();
  expect(system(llm.requests[1]?.body)).toContain(CONFIDENCE_PROMPT);
  c.send({ type: 'chat.open', chatId: chat.id });
  const state = await c.next('chat.state');
  expect(state.chat.modes).toEqual(['confidence']);
  expect(state.messages.at(-1)?.text).toBe(MARKED);

  // The title job and the search index read the text without markers.
  await vi.waitFor(() => expect(llm.requests).toHaveLength(3), { timeout: 10_000, interval: 50 });
  expect(JSON.stringify(llm.requests[2]?.body)).toContain(PLAIN);
  expect(JSON.stringify(llm.requests[2]?.body)).not.toContain('⟦');
  await vi.waitFor(
    () => {
      const texts = srv.db
        .select({ text: chunks.text })
        .from(chunks)
        .where(eq(chunks.chatId, chat.id))
        .all()
        .map((r) => r.text);
      expect(texts).toContain(PLAIN);
      expect(texts.join('')).not.toContain('⟦');
    },
    { timeout: 20_000, interval: 100 },
  );

  c.send({ type: 'chat.setModes', chatId: chat.id, modes: [] });
  // The title job's own `chat.updated` may come first.
  await vi.waitFor(() =>
    expect(c.inbox.some((m) => m.type === 'chat.updated' && m.chat.modes?.length === 0)).toBe(true),
  );
  c.send({ type: 'user.message', chatId: chat.id, text: 'Entä nyt?' });
  await c.idle();
  expect(system(llm.requests.at(-1)?.body)).not.toContain(CONFIDENCE_PROMPT);

  c.inbox.length = 0;
  c.send({ type: 'chat.setModes', chatId: 'ei-ole', modes: ['confidence'] });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: not_found');
});

test('export strips the confidence markers in md and json', { timeout: 30_000 }, async () => {
  const reply = `${MARKED}\n\n\`\`\`html\n<h1>Sivu</h1>\n\`\`\``;
  const { c, chat, config } = await bootChat([{ text: reply }]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kerro' });
  await c.idle();
  const { cookie } = await login(config.port);
  const get = (format: string) =>
    api(config.port, `/api/chats/${chat.id}/export?format=${format}&unmask=0`, {
      headers: { cookie },
    });
  const md = await (await get('md')).text();
  expect(md).toContain(`> ${PLAIN}`);
  expect(md).not.toContain('⟦');
  const json = ChatExport.parse(await (await get('json')).json());
  expect(json.messages.at(-1)?.text).toBe(`${PLAIN}\n\n\`\`\`html\n<h1>Sivu</h1>\n\`\`\``);
  expect(json.messages.at(-1)?.artifacts).toHaveLength(1);
  expect(JSON.stringify(json)).not.toContain('⟦');
});
