import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { automationRuns, chats } from '@pa/db';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { AttachmentRef, ClientMessageInput } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, expect, test, vi } from 'vitest';
import { api, boot, cleanups, connect, login, runCleanups, sidecarProxy } from './test-utils.ts';

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
  /** A message refused for ZDR, then the consent: the chat is `open` and its turn failed. */
  const refuseThenOpen = async (chatId: string, text = 'Moi') => {
    c.send({ type: 'user.message', chatId, text });
    await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
    await c.idle();
    c.inbox.length = 0;
    c.send({ type: 'chat.setDataPolicy', chatId, dataPolicy: 'open' });
    expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('open');
  };
  /** Sends `user.retry` and expects the refusal `code` for this chat. */
  const refuseRetry = async (chatId: string, code: string) => {
    c.inbox.length = 0;
    c.send({ type: 'user.retry', chatId });
    await expect(c.next('message.final')).rejects.toThrow(`server error: ${code}`);
  };
  return { ...b, srv, c, row, sessionModel, create, refuseOpen, refuseThenOpen, refuseRetry };
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

test('phase 20: a model change during a run applies to the next turn; the data policy waits', {
  timeout: 30_000,
}, async () => {
  const OPUS = 'anthropic/claude-opus-5.5';
  const { llm, srv, c, row, create } = await start([
    // The thinking keeps the run going while the changes arrive.
    { text: 'Vanha malli vastaa.', reasoning: 'Mietin vielä hetken.', thinkMs: 1500 },
    TITLE,
    { text: 'Uusi malli vastaa.' },
  ]);
  const chat = await create({ modelId: ARGON, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  expect((await c.next('agent.status')).state).toBe('running');
  c.send({ type: 'chat.setModel', chatId: chat.id, modelId: OPUS, reasoning: 'high' });
  const changed = await c.next('chat.updated');
  expect(changed.chat.modelPolicy).toEqual({ modelId: OPUS, reasoning: 'high', dataPolicy: 'zdr' });
  expect(row(chat.id)).toMatchObject({ modelId: OPUS, reasoning: 'high', dataPolicy: 'zdr' });
  expect(srv.registry.running(chat.id)).toBe(true);
  // Consent stays an idle action.
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: failed');
  expect((await c.next('message.final')).message.text).toBe('Vanha malli vastaa.');
  await c.idle();
  expect(llm.requests[0]?.body.model).toBe(`zdr/${ARGON}`);

  // The next turn runs on a session rebuilt with the new model.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Jatketaan' });
  await vi.waitFor(
    () =>
      expect(
        c.inbox.some((m) => m.type === 'message.final' && m.message.text === 'Uusi malli vastaa.'),
      ).toBe(true),
    { timeout: 10_000, interval: 50 },
  );
  const turns = llm.requests.filter((r) => r.body.model !== 'zdr/task-small');
  expect(turns[1]?.body).toMatchObject({ model: `zdr/${OPUS}`, reasoning: { effort: 'high' } });
  expect((await srv.registry.get(chat.id)).model?.id).toBe(`zdr/${OPUS}`);
});

test('phase 20: a refusal during a model change is for the model the run used', {
  timeout: 30_000,
}, async () => {
  // The prompt waits in the masking hook, so the model changes while the run is held.
  const sc = await startFakeSidecar({});
  cleanups.push(sc.close);
  const proxy = await sidecarProxy(sc.url);
  const { llm, c, create, refuseOpen } = await start([REFUSAL], { PSEUDO_URL: proxy.url });
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  proxy.delayMs = 500;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await sleep(200);
  c.send({ type: 'chat.setModel', chatId: chat.id, modelId: ARGON, reasoning: 'auto' });
  expect((await c.next('chat.updated')).chat.modelPolicy.modelId).toBe(ARGON);
  proxy.delayMs = 0;
  const refusal = () => c.inbox.find((m) => m.type === 'error' && m.code === 'zdr_unavailable');
  await vi.waitFor(() => expect(refusal()).toBeDefined(), { timeout: 10_000, interval: 50 });
  expect(llm.requests[0]?.body.model).toBe(`zdr/${FABLE}`);
  expect(refusal()).toMatchObject({ chatId: chat.id, modelId: FABLE });
  c.inbox.splice(c.inbox.indexOf(refusal() as never), 1);
  await c.idle();
  // The refusal was Fable's: the consent for Argon, the chat's model now, is refused.
  await refuseOpen(chat.id);
});

test('user.retry runs the refused turn again in place: the model and chat.state see it once', {
  timeout: 30_000,
}, async () => {
  const { llm, c, create, refuseThenOpen, refuseRetry } = await start([
    REFUSAL,
    { text: 'Vastaus ilman ZDR:ää.' },
    TITLE,
  ]);
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  await refuseThenOpen(chat.id, 'Kerro säästä');

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

  // Nothing to run again in a chat without messages, nor after a reply that did not fail.
  await refuseRetry((await create()).id, 'bad_message');
  await refuseRetry(chat.id, 'bad_message');
});

test('user.retry holds the chat: "Palauta ZDR" during its restore step fails; the rerun stays on open/', {
  timeout: 40_000,
}, async () => {
  const sc = await startFakeSidecar({});
  cleanups.push(sc.close);
  const proxy = await sidecarProxy(sc.url);
  const { llm, c, row, create, refuseThenOpen } = await start(
    [REFUSAL, { text: 'Uudelleen.' }, TITLE],
    { PSEUDO_URL: proxy.url },
  );
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  await refuseThenOpen(chat.id);
  // The retry waits in its restore (/unmask) step while "Palauta ZDR" arrives.
  proxy.delayMs = 500;
  c.inbox.length = 0;
  c.send({ type: 'user.retry', chatId: chat.id });
  await sleep(200);
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  await expect(c.next('chat.updated')).rejects.toThrow('server error: failed');
  proxy.delayMs = 0;
  expect(row(chat.id)?.dataPolicy).toBe('open');
  expect((await c.next('message.final')).message.text).toBe('Uudelleen.');
  await c.idle();
  expect(llm.requests[1]?.body.model).toBe(`open/${FABLE}`);
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'zdr' });
  expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('zdr');
});

test('user.retry of a turn without a reply runs it once (no user, user)', {
  timeout: 30_000,
}, async () => {
  const { llm, srv, c, create } = await start([{ text: 'Eka.' }, { text: 'Toka.' }, TITLE, TITLE]);
  const chat = await create();
  c.send({ type: 'user.message', chatId: chat.id, text: 'Eka?' });
  await c.next('message.final');
  await c.idle();
  // As after a crash during the call: the user entry is the leaf, no reply follows it.
  const session = await srv.registry.get(chat.id);
  session.sessionManager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Toka?' }],
    timestamp: Date.now(),
  });
  c.send({ type: 'user.retry', chatId: chat.id });
  expect((await c.next('message.final')).message.text).toBe('Toka.');
  await c.idle();
  const sent = llm.requests.filter((r) => r.body.model !== 'zdr/task-small')[1];
  expect(JSON.stringify(sent?.body.messages).split('Toka?')).toHaveLength(2);
  c.send({ type: 'chat.open', chatId: chat.id });
  expect((await c.next('chat.state')).messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'Eka?'],
    ['assistant', 'Eka.'],
    ['user', 'Toka?'],
    ['assistant', 'Toka.'],
  ]);
});

test('user.retry refuses a turn that ran tools and a steered turn (bad_message)', {
  timeout: 40_000,
}, async () => {
  const fail = { error: { status: 400, message: 'nope' } };
  const { srv, c, create, refuseRetry } = await start([
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
    fail,
    { toolCalls: [{ name: 'write', args: { path: 'x.txt', content: 'x' } }] },
    fail,
    TITLE,
    TITLE,
  ]);
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hei');
  // A read, then the failure: a rerun would run the read again.
  const tools = await create();
  c.send({ type: 'user.message', chatId: tools.id, text: 'Lue' });
  expect((await c.next('tool.end')).status).toBe('ok');
  // The tool-call reply has its final; the failed call after it has none.
  await expect(c.next('message.final')).resolves.toMatchObject({ type: 'message.final' });
  await expect(c.next('message.final')).rejects.toThrow('llm_failed');
  await c.idle();
  await refuseRetry(tools.id, 'bad_message');

  // A steer that arrives while a write waits for approval: the failed call follows the steer.
  const steered = await create();
  c.send({ type: 'user.message', chatId: steered.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  c.send({ type: 'user.message', chatId: steered.id, text: 'Ohjaus' });
  await sleep(100);
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: false });
  await expect(c.next('message.final')).resolves.toMatchObject({ type: 'message.final' });
  await expect(c.next('message.final')).rejects.toThrow('llm_failed');
  await c.idle();
  const branch = (await srv.registry.get(steered.id)).sessionManager.getBranch();
  const roles = branch.flatMap((e) => (e.type === 'message' ? [e.message.role] : []));
  expect(roles.slice(-3)).toEqual(['toolResult', 'user', 'assistant']);
  await refuseRetry(steered.id, 'bad_message');
});

test('user.retry with a document and an image: masked in the request and the session, shown once', {
  timeout: 40_000,
}, async () => {
  const sc = await startFakeSidecar({ 'Matti Virtanen': 'Pekka Laaksonen' });
  cleanups.push(sc.close);
  const { llm, srv, config, c, create } = await start([REFUSAL, { text: 'Näen kuvan.' }, TITLE], {
    PSEUDO_URL: sc.url,
  });
  const { cookie } = await login(config.port);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'dot.png');
  form.append('files', new Blob(['muistio Matti Virtanen'], { type: 'text/plain' }), 'note.txt');
  const up = await api(config.port, '/api/files', {
    method: 'POST',
    body: form,
    headers: { cookie },
  });
  const { files } = (await up.json()) as { files: AttachmentRef[] };
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  c.send({
    type: 'user.message',
    chatId: chat.id,
    text: 'Katso Matti Virtanen',
    attachments: files,
  });
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  await c.next('chat.updated');

  c.send({ type: 'user.retry', chatId: chat.id });
  expect((await c.next('message.final')).message.text).toBe('Näen kuvan.');
  await c.idle();
  const body = llm.requests[1]?.body;
  expect(body.model).toBe(`open/${FABLE}`);
  const sent = JSON.stringify(body.messages);
  expect(sent).not.toContain('Matti Virtanen');
  expect(sent.split('Katso Pekka Laaksonen')).toHaveLength(2);
  expect(sent).toContain('[Liite: note.txt]\\nmuistio Pekka Laaksonen');
  // The memory extension adds a user message of its own; the retried one is there once.
  const user = body.messages.filter((m: { role: string }) =>
    JSON.stringify(m).includes('Katso Pekka Laaksonen'),
  );
  expect(user).toHaveLength(1);
  expect(user[0].content.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  const file = readdirSync(srv.registry.sessionDir).find((f) => f.includes(chat.id));
  const jsonl = readFileSync(join(srv.registry.sessionDir, file ?? ''), 'utf8');
  expect(jsonl).toContain('Pekka Laaksonen');
  expect(jsonl).not.toContain('Matti Virtanen');
  c.send({ type: 'chat.open', chatId: chat.id });
  const users = (await c.next('chat.state')).messages.filter((m) => m.role === 'user');
  expect(users.map((m) => [m.text, m.attachments.map((a) => a.name)])).toEqual([
    ['Katso Matti Virtanen', ['dot.png', 'note.txt']],
  ]);
});

test('user.retry: a mask failure after the check keeps the old turn (pseudo_down, no call)', {
  timeout: 40_000,
}, async () => {
  const sc = await startFakeSidecar({});
  cleanups.push(sc.close);
  const proxy = await sidecarProxy(sc.url);
  const { llm, c, create, refuseThenOpen } = await start(
    [REFUSAL, { text: 'Nyt toimii.' }, TITLE],
    { PSEUDO_URL: proxy.url },
  );
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  await refuseThenOpen(chat.id);
  // /unmask (the check) answers, /mask (the input hook) does not.
  proxy.fail.add('/mask');
  c.inbox.length = 0;
  c.send({ type: 'user.retry', chatId: chat.id });
  await expect(c.next('message.final')).rejects.toThrow('pseudo_down');
  expect(llm.requests).toHaveLength(1);
  // The old turn is back on the branch: the next retry finds it and runs.
  proxy.fail.clear();
  c.send({ type: 'user.retry', chatId: chat.id });
  expect((await c.next('message.final')).message.text).toBe('Nyt toimii.');
  await c.idle();
  expect(JSON.stringify(llm.requests[1]?.body.messages).split('"Moi"')).toHaveLength(2);
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
  const proxy = await sidecarProxy(sc.url);
  const { llm, c, row, create } = await start([REFUSAL, { text: 'Kiire.' }], {
    PSEUDO_URL: proxy.url,
  });
  const chat = await create({ modelId: FABLE, reasoning: 'auto' });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await expect(c.next('message.final')).rejects.toThrow('zdr_unavailable');
  await c.idle();
  c.inbox.length = 0;
  c.send({ type: 'chat.setDataPolicy', chatId: chat.id, dataPolicy: 'open' });
  expect((await c.next('chat.updated')).chat.modelPolicy.dataPolicy).toBe('open');

  proxy.delayMs = 500;
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
  proxy.delayMs = 0;
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
  // Phase-22 decision 1: the status and the provider text go to the toast.
  const fail = vi.waitFor(() => c.inbox.find((m) => m.type === 'error') ?? Promise.reject(), {
    timeout: 10_000,
    interval: 50,
  });
  await expect(fail).resolves.toMatchObject({
    code: 'llm_failed',
    status: 503,
    detail: expect.stringContaining('No provider available'),
  });
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
