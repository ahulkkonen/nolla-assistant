import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { automationRuns, chats } from '@pa/db';
import { listenLocal } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { ClientMessageInput } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { boot, cleanups, connect, runCleanups } from './test-utils.ts';

// Phase-10 "Proof that the default stays ZDR-only", claims 1 and 3 to 6, and decision 10.
afterEach(runCleanups);

const FABLE = 'anthropic/claude-fable-5.1'; // no ZDR endpoint in the fake catalog
const ARGON = 'google/gemini-4-argon';
const REFUSAL = {
  error: { status: 404, message: 'No endpoints found matching your data policy' },
};
const TITLE = {
  match: 'Aiheet:',
  text: JSON.stringify({
    title: 'Otsikko',
    topics: [],
    proposed_topic: null,
    summary: 'Yhteenveto',
  }),
};

async function start(turns: Parameters<typeof boot>[0], env: Record<string, string> = {}) {
  const b = await boot(turns, env);
  const srv = await b.run();
  const c = await connect(b.config.port);
  const row = (id: string) => srv.db.select().from(chats).where(eq(chats.id, id)).get();
  /** The Pi model of the chat's session, as `registry.get` (re)builds it. */
  const sessionModel = async (id: string) => (await srv.registry.get(id)).model;
  const create = async (model?: { modelId: string; reasoning: string }) => {
    c.send({ type: 'chat.create', ...(model ? { model } : {}) } as ClientMessageInput);
    return (await c.next('chat.created')).chat;
  };
  /** `chat.setDataPolicy('open')` answers bad_message and leaves the row on zdr. */
  const refuseOpen = async (chatId: string) => {
    // Drop the `chat.updated` of the last settle.
    c.inbox.length = 0;
    c.send({ type: 'chat.setDataPolicy', chatId, dataPolicy: 'open' });
    await expect(c.next('chat.updated')).rejects.toThrow('bad_message');
    expect(row(chatId)?.dataPolicy).toBe('zdr');
  };
  return { ...b, srv, c, row, sessionModel, create, refuseOpen };
}

test('proof 1: chat.create ignores a client dataPolicy; the chat and its session are zdr', {
  timeout: 30_000,
}, async () => {
  const { llm, c, row, sessionModel, create } = await start([{ text: 'Hei!' }]);
  c.send({ type: 'chat.create', dataPolicy: 'open' } as unknown as ClientMessageInput);
  const { chat } = await c.next('chat.created');
  expect(chat.modelPolicy).toEqual({ modelId: 'auto', reasoning: 'auto', dataPolicy: 'zdr' });
  expect(row(chat.id)).toMatchObject({ modelId: 'auto', reasoning: 'auto', dataPolicy: 'zdr' });
  const model = await sessionModel(chat.id);
  expect(model?.provider).toBe('zdr');
  expect(model?.id).toBe(`zdr/${ARGON}`);

  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.next('message.final');
  await c.idle();
  // Auto thinking resolves on the server: Argon's recommended effort, sent explicitly.
  expect(llm.requests[0]?.body).toMatchObject({
    model: `zdr/${ARGON}`,
    reasoning: { effort: 'medium' },
  });

  // Server validation: a model outside the catalog or an effort the model lacks.
  for (const model of [
    { modelId: 'acme/unknown', reasoning: 'auto' },
    { modelId: ARGON, reasoning: 'max' },
  ]) {
    c.send({ type: 'chat.create', model } as ClientMessageInput);
    await expect(c.next('chat.created')).rejects.toThrow('bad_message');
  }
  const opus = await create({ modelId: 'anthropic/claude-opus-5.5', reasoning: 'high' });
  expect(opus.modelPolicy).toEqual({
    modelId: 'anthropic/claude-opus-5.5',
    reasoning: 'high',
    dataPolicy: 'zdr',
  });
});

test('proofs 3, 4, 6: open needs a recorded refusal, ends with the model; titles stay on zdr/task-small', {
  timeout: 40_000,
}, async () => {
  const { llm, c, row, sessionModel, create, refuseOpen } = await start([
    REFUSAL,
    { text: 'Vastaus ilman ZDR:ää.' },
    TITLE,
    { text: 'Taas ZDR.' },
  ]);
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  // Proof 3: no refusal recorded yet.
  await refuseOpen(chat.id);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  // Decision 10: a 404 for a model without ZDR endpoints is a refusal.
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  expect(llm.requests[0]?.body.model).toBe(`zdr/${FABLE}`);
  expect(row(chat.id)?.dataPolicy).toBe('zdr');

  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  const opened = await c.next('chat.updated');
  expect(opened.chat.modelPolicy).toEqual({
    modelId: FABLE,
    reasoning: 'auto',
    dataPolicy: 'open',
  });
  expect(row(chat.id)?.dataPolicy).toBe('open');
  expect((await sessionModel(chat.id))?.id).toBe(`open/${FABLE}`);

  // The retry runs on the open route.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  expect((await c.next('message.final')).message.text).toBe('Vastaus ilman ZDR:ää.');
  await c.idle();
  expect(llm.requests[1]?.body.model).toBe(`open/${FABLE}`);

  // Proof 6: the title job of the open chat still calls the fixed alias.
  await c.next('chat.titled');
  // Up to the job's own `chat.updated`, so later reads see only new updates.
  while ((await c.next('chat.updated')).chat.title !== 'Otsikko');
  expect(llm.requests).toHaveLength(3);
  expect(llm.requests[2]?.body.model).toBe('zdr/task-small');
  expect(JSON.stringify(llm.requests[2]?.body)).toContain('Aiheet:');

  // Proof 4: a model change sets zdr again and rebuilds the session on zdr/.
  c.inbox.length = 0;
  c.send({ type: 'chat.setModel', chatId: chat.id, modelId: 'auto', reasoning: 'low' });
  const changed = await c.next('chat.updated');
  expect(changed.chat.modelPolicy).toEqual({
    modelId: 'auto',
    reasoning: 'low',
    dataPolicy: 'zdr',
  });
  expect(row(chat.id)?.dataPolicy).toBe('zdr');
  const rebuilt = await sessionModel(chat.id);
  expect(rebuilt?.provider).toBe('zdr');
  expect(rebuilt?.id).toBe(`zdr/${ARGON}`);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Jatketaan' });
  await c.next('message.final');
  await c.idle();
  expect(llm.requests[3]?.body).toMatchObject({
    model: `zdr/${ARGON}`,
    reasoning: { effort: 'low' },
  });
  // The consent was for Fable: the new model has no refusal.
  await refuseOpen(chat.id);
});

test('user.retry runs the refused turn again in place: the model and chat.state see it once', {
  timeout: 30_000,
}, async () => {
  const { llm, c, create } = await start([REFUSAL, { text: 'Vastaus ilman ZDR:ää.' }, TITLE]);
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kerro säästä' });
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  await c.next('chat.updated');

  c.send({ type: 'user.retry', chatId: chat.id });
  expect((await c.next('message.final')).message.text).toBe('Vastaus ilman ZDR:ää.');
  await c.idle();
  expect(llm.requests[1]?.body.model).toBe(`open/${FABLE}`);
  expect(JSON.stringify(llm.requests[1]?.body.messages).split('Kerro säästä')).toHaveLength(2);
  c.send({ type: 'chat.open', chatId: chat.id });
  const { messages } = await c.next('chat.state');
  expect(messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'Kerro säästä'],
    ['assistant', 'Vastaus ilman ZDR:ää.'],
  ]);

  // Nothing to run again in a chat without messages.
  const empty = await create();
  c.send({ type: 'user.retry', chatId: empty.id });
  await expect(c.next('message.final')).rejects.toThrow('bad_message');
});

test('registry.get rebuilds an idle session whose stored policy changed (no stale open session)', {
  timeout: 30_000,
}, async () => {
  const { srv, row, sessionModel, create } = await start([]);
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  expect((await sessionModel(chat.id))?.id).toBe(`zdr/${FABLE}`);
  // As if "Palauta ZDR" or a model change landed while a build was in flight: no evict call.
  srv.db.update(chats).set({ dataPolicy: 'open' }).where(eq(chats.id, chat.id)).run();
  expect((await sessionModel(chat.id))?.id).toBe(`open/${FABLE}`);
  srv.db
    .update(chats)
    .set({ modelId: 'auto', dataPolicy: 'zdr' })
    .where(eq(chats.id, chat.id))
    .run();
  expect((await sessionModel(chat.id))?.id).toBe(`zdr/${ARGON}`);
  expect(row(chat.id)?.dataPolicy).toBe('zdr');
});

test('without Auto in the catalog, chat.create falls back to the profile alias on zdr', {
  timeout: 30_000,
}, async () => {
  const b = await boot([{ text: 'Hei aliakselta.' }]);
  // OpenRouter unreachable at a first start: no catalog, no cache.
  b.llm.catalog.length = 0;
  const srv = await b.run();
  const c = await connect(b.config.port);
  c.send({ type: 'models.list' });
  expect(await c.next('models.state')).toMatchObject({ catalog: [], fetchedAt: null });
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  expect(chat.modelPolicy).toEqual({ modelId: null, reasoning: 'auto', dataPolicy: 'zdr' });
  expect((await srv.registry.get(chat.id)).model?.id).toBe('zdr/strong');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  expect((await c.next('message.final')).message.text).toBe('Hei aliakselta.');
  expect(b.llm.requests[0]?.body.model).toBe('zdr/strong');
  // A catalog model cannot be picked without a catalog.
  c.send({ type: 'chat.create', model: { modelId: FABLE, reasoning: 'auto' } });
  await expect(c.next('chat.created')).rejects.toThrow('bad_message');
});

test('a message and "Palauta ZDR" sent together never leave a run on open/ under a zdr row', {
  timeout: 30_000,
}, async () => {
  const { llm, c, row, create } = await start([REFUSAL, { text: 'Kiire.' }]);
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('open');

  c.inbox.length = 0;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kiire' });
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  const restored = () =>
    c.inbox.some((m) => m.type === 'chat.updated' && m.chat.modelPolicy.dataPolicy === 'zdr');
  const refused = () => c.inbox.some((m) => m.type === 'error' && m.code === 'failed');
  await vi.waitFor(
    () => {
      expect(c.inbox.some((m) => m.type === 'message.final')).toBe(true);
      expect(c.inbox.some((m) => m.type === 'agent.status' && m.state === 'idle')).toBe(true);
      expect(restored() || refused()).toBe(true);
    },
    { timeout: 10_000, interval: 50 },
  );
  // Exactly one outcome, and the request matches the row: restored runs on zdr/, refused on open/.
  expect(restored()).not.toBe(refused());
  const sent = llm.requests.filter((r) => r.body.model !== 'zdr/task-small')[1];
  expect(sent?.body.model).toBe(`${restored() ? 'zdr' : 'open'}/${FABLE}`);
  expect(row(chat.id)?.dataPolicy).toBe(restored() ? 'zdr' : 'open');
});

test('"Palauta ZDR" during a prompt\'s input hooks waits for the prompt (failed, row stays open)', {
  timeout: 40_000,
}, async () => {
  // The sidecar behind a delay: the prompt sits in `pi-ext-pseudo`'s input hook, where Pi still
  // reports the session idle.
  const sc = await startFakeSidecar({});
  cleanups.push(sc.close);
  let delayMs = 0;
  const slow = createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', (d: Buffer) => body.push(d));
    req.on('end', async () => {
      await sleep(delayMs);
      const { host: _, 'content-length': __, ...headers } = req.headers;
      const r = await fetch(`${sc.url}${req.url}`, {
        method: req.method ?? 'GET',
        headers: headers as Record<string, string>,
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(body) }),
      });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' });
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
  const proxy = await listenLocal(slow);
  cleanups.push(proxy.close);
  const { llm, c, row, create } = await start([REFUSAL, { text: 'Kiire.' }], {
    PSEUDO_URL: proxy.origin,
  });
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('open');

  delayMs = 500;
  c.inbox.length = 0;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kiire' });
  await sleep(200);
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: failed');
  expect(row(chat.id)?.dataPolicy).toBe('open');
  expect((await c.next('message.final')).message.text).toBe('Kiire.');
  expect(llm.requests[1]?.body.model).toBe(`open/${FABLE}`);
  await c.idle();
  // Once idle, the restore goes through.
  delayMs = 0;
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('zdr');
  expect(row(chat.id)?.dataPolicy).toBe('zdr');
});

test('decision 10: a 503 for a ZDR model is an outage (llm_failed), not a refusal', {
  timeout: 30_000,
}, async () => {
  const { llm, srv, c, create, refuseOpen } = await start([
    { error: { status: 503, message: 'No provider available' } },
  ]);
  // One attempt: Pi's own auto-retry would repeat the 503 (phase-10 risk 4).
  writeFileSync(join(srv.registry.agentDir, 'settings.json'), '{"retry":{"enabled":false}}');
  const chat = await create({ modelId: ARGON, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await expect(c.next('message.final')).rejects.toThrow('llm_failed');
  await c.idle();
  expect(llm.requests[0]?.body.model).toBe(`zdr/${ARGON}`);
  await refuseOpen(chat.id);
});

test('proof 5: an automation run uses the profile alias on zdr and cannot be opened', {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-auto-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'p5.yaml'), "id: p5\ncron: '0 0 1 1 *'\nprompt: Moikka\n");
  const { llm, srv, row, c, refuseOpen } = await start([{ text: 'Valmis.' }, TITLE], {
    AUTOMATIONS_DIR: dir,
  });
  c.send({ type: 'automations.run', id: 'p5' });
  await c.next('automations.state');
  const run = () => srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'p5')).get();
  await vi.waitFor(() => expect(run()?.lastStatus).toBe('ok'), { timeout: 8000, interval: 100 });
  const chatId = run()?.lastChatId ?? '';
  expect(row(chatId)).toMatchObject({ modelId: null, reasoning: 'auto', dataPolicy: 'zdr' });
  expect(llm.requests[0]?.body.model).toBe('zdr/strong');
  await refuseOpen(chatId);
});

test('models.list and models.favorite answer models.state to the asking socket', {
  timeout: 30_000,
}, async () => {
  const { config, c } = await start([]);
  const other = await connect(config.port);
  c.send({ type: 'models.list' });
  const state = await c.next('models.state');
  expect(state).toMatchObject({ auto: ARGON, favorites: [] });
  expect(state.fetchedAt).not.toBeNull();
  expect(state.catalog.map((m) => [m.id, m.zdr])).toEqual([
    [ARGON, true],
    ['anthropic/claude-opus-5.5', true],
    [FABLE, false],
  ]);
  // Only protocol fields go out.
  expect(Object.keys(state.catalog[0] ?? {}).sort()).toEqual(
    ['contextLength', 'id', 'name', 'price', 'reasoning', 'vision', 'zdr'].sort(),
  );
  expect(state.catalog[1]?.reasoning).toMatchObject({ recommended: 'medium' });

  for (const modelId of [FABLE, ARGON]) {
    c.send({ type: 'models.favorite', modelId, favorite: true });
    await c.next('models.state');
  }
  // Shared through the database: another screen reads them at its next `models.list`.
  expect(other.inbox.some((m) => m.type === 'models.state')).toBe(false);
  other.send({ type: 'models.list' });
  expect((await other.next('models.state')).favorites).toEqual([FABLE, ARGON]);
  c.send({ type: 'models.favorite', modelId: FABLE, favorite: false });
  expect((await c.next('models.state')).favorites).toEqual([ARGON]);
  c.send({ type: 'models.favorite', modelId: 'acme/unknown', favorite: true });
  await expect(c.next('models.state')).rejects.toThrow('bad_message');
});
