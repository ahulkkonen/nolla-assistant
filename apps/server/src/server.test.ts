import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { AttachmentRef, ClientMessageInput, ServerMessage } from '@pa/protocol';
import sharp from 'sharp';
import { afterEach, expect, test } from 'vitest';
import WebSocket from 'ws';
import { hashPassword } from './auth/password.ts';
import { loadConfig } from './config.ts';
import { start } from './main.ts';

const KEY = 'sk-test-master';
const SCRIPTED = 'Hei! Miten voin auttaa?';
const PASSWORD = 'correct horse';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

async function boot(turns: FakeTurn[], env: Record<string, string> = {}) {
  const llm = await startFakeLlm(turns);
  const dataDir = mkdtempSync(join(tmpdir(), 'pa-server-'));
  process.env.LITELLM_MASTER_KEY = KEY;
  const config = loadConfig({
    DATA_DIR: dataDir,
    LITELLM_URL: llm.url,
    LITELLM_MASTER_KEY: KEY,
    PORT: String(await freePort()),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    AUTH_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'x'.repeat(32),
    AUTH_PASSWORD_HASH: PASSWORD_HASH,
    ...env,
  });
  cleanups.push(
    () => llm.close(),
    () => rmSync(dataDir, { recursive: true, force: true }),
  );
  const run = async () => {
    const srv = await start(config);
    cleanups.push(srv.close);
    return srv;
  };
  return { llm, config, run };
}

const api = (port: number, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

/** Logs in with the password and returns the `pa_session=...` cookie pair. */
async function login(port: number, password = PASSWORD) {
  const res = await api(port, '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { res, cookie: res.headers.getSetCookie()[0]?.split(';')[0] ?? '' };
}

async function connect(port: number, origin?: string, cookie?: string) {
  cookie ??= (await login(port)).cookie;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    ...(origin ? { origin } : {}),
    headers: { cookie },
  });
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)));
    for (const w of waiters.splice(0)) w();
  });
  cleanups.push(() => ws.close());
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const next = async <T extends ServerMessage['type']>(type: T) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type || m.type === 'error');
      if (i >= 0) {
        const [m] = inbox.splice(i, 1);
        if (m?.type === 'error') throw new Error(`server error: ${m.code}`);
        return m as Extract<ServerMessage, { type: T }>;
      }
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const idle = async () => {
    while ((await next('agent.status')).state !== 'idle');
  };
  const send = (m: ClientMessageInput) => ws.send(JSON.stringify(m));
  return { ws, inbox, next, idle, send };
}

const deltasOf = (inbox: ServerMessage[]) =>
  inbox.flatMap((m) => (m.type === 'message.delta' ? [m] : []));

test('create chat, stream reply, reload after restart', { timeout: 30_000 }, async () => {
  const { llm, config, run } = await boot([{ text: SCRIPTED }]);
  let srv = await run();
  await expect(connect(config.port, 'http://evil.example')).rejects.toThrow(/403/);
  let c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  const final = await c.next('message.final');
  const deltas = deltasOf(c.inbox);
  expect(deltas.length).toBeGreaterThan(0);
  expect(new Set(deltas.map((d) => d.messageId)).size).toBe(1);
  expect(deltas.map((d) => d.text).join('')).toBe(final.message.text);
  expect(final.message.text).toBe(SCRIPTED);
  expect(llm.requests[0]?.body.model).toBe('zdr/strong');
  expect(llm.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  await c.idle();
  c.ws.close();
  await srv.close();

  srv = await run();
  c = await connect(config.port);
  c.send({ type: 'chat.open', chatId: chat.id });
  const state = await c.next('chat.state');
  expect(state.messages.map((m) => [m.role, m.text])).toEqual([
    ['user', 'Moi'],
    ['assistant', SCRIPTED],
  ]);
  expect(state.messages[1]?.id).toBe(final.message.id);
  c.send({ type: 'chat.list' });
  expect((await c.next('chat.list')).chats.map((x) => x.id)).toEqual([chat.id]);
});

test('fan-out: two sockets on one chat see the same stream', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([{ text: SCRIPTED }]);
  await run();
  const a = await connect(config.port);
  const b = await connect(config.port);
  a.send({ type: 'chat.create' });
  const { chat } = await a.next('chat.created');
  b.send({ type: 'chat.open', chatId: chat.id });
  expect((await b.next('chat.state')).messages).toEqual([]);
  a.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  const [fa, fb] = await Promise.all([a.next('message.final'), b.next('message.final')]);
  expect(fb).toEqual(fa);
  expect(deltasOf(b.inbox)).toEqual(deltasOf(a.inbox));
  expect(deltasOf(a.inbox).length).toBeGreaterThan(0);
});

test('tool turn reports read status; guard denies paths outside workspace', {
  timeout: 30_000,
}, async () => {
  const { config, run } = await boot([
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] },
    { text: 'Read it.' },
    { toolCalls: [{ name: 'read', args: { path: '../app.db' } }] },
    { text: 'Denied.' },
  ]);
  const srv = await run();
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hello');
  const c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');

  c.send({ type: 'user.message', chatId: chat.id, text: 'Read note.txt' });
  const start = await c.next('tool.start');
  expect(start.name).toBe('read');
  expect(start.argsPreview).toBe('path: note.txt');
  expect((await c.next('tool.end')).status).toBe('ok');
  expect((await c.next('message.final')).message.tools[0]?.status).toBe('ok');
  expect((await c.next('message.final')).message.text).toBe('Read it.');
  await c.idle();

  c.send({ type: 'user.message', chatId: chat.id, text: 'Read ../app.db' });
  const end = await c.next('tool.end');
  expect(end.status).toBe('denied');
  expect(end.summary).toContain('path outside workspace');
  expect((await c.next('message.final')).message.tools[0]?.status).toBe('denied');
  await c.idle();
});

test('only the zdr provider resolves credentials (invariant 2)', { timeout: 30_000 }, async () => {
  const { run } = await boot([]);
  const srv = await run();
  const available = await (await srv.registry.modelRuntime()).getAvailable();
  expect(available.length).toBeGreaterThan(0);
  expect(available.every((m) => m.provider === 'zdr')).toBe(true);
});

test('auth: cookie required, password login, rate limit, logout', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  const { port } = config;
  await expect(connect(port, undefined, '')).rejects.toThrow(/401/);
  expect((await api(port, '/api/auth/me')).status).toBe(401);
  expect((await api(port, '/healthz')).status).toBe(200);

  const { res, cookie } = await login(port);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ userId: 'aleksi' });
  expect(res.headers.getSetCookie()[0]).toMatch(/^pa_session=.+HttpOnly; SameSite=Strict/);
  const me = await api(port, '/api/auth/me', { headers: { cookie } });
  expect(await me.json()).toEqual({ userId: 'aleksi', passkeys: [] });
  expect(me.headers.get('x-frame-options')).toBe('DENY');
  const reg = await api(port, '/api/auth/passkey/register/options', {
    method: 'POST',
    headers: { cookie },
  });
  expect(reg.status).toBe(200);
  expect(
    ((await reg.json()) as { authenticatorSelection: unknown }).authenticatorSelection,
  ).toMatchObject({ residentKey: 'required' });
  const del = await api(port, '/api/auth/passkey/nope', { method: 'DELETE', headers: { cookie } });
  expect(del.status).toBe(404);

  const c = await connect(port, undefined, cookie);
  expect(await c.next('auth.state')).toEqual({
    type: 'auth.state',
    authenticated: true,
    userId: 'aleksi',
  });

  // Only failures count: five 401s, then 429 even for the right password.
  for (let i = 0; i < 5; i++) expect((await login(port, 'wrong')).res.status).toBe(401);
  expect((await login(port, 'wrong')).res.status).toBe(429);
  expect((await login(port)).res.status).toBe(429);

  const out = await api(port, '/api/auth/logout', { method: 'POST', headers: { cookie } });
  expect(out.status).toBe(204);
  expect((await api(port, '/api/auth/me', { headers: { cookie } })).status).toBe(401);
});

test('attachments: image and txt reach the model; owner-only download', {
  timeout: 30_000,
}, async () => {
  const { llm, config, run } = await boot([{ text: SCRIPTED }]);
  await run();
  const { port } = config;
  const { cookie } = await login(port);
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#f00' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'dot.png');
  form.append('files', new Blob(['muistiinpano 42'], { type: 'text/plain' }), 'note.txt');
  const up = await api(port, '/api/files', { method: 'POST', body: form, headers: { cookie } });
  expect(up.status).toBe(200);
  const { files } = (await up.json()) as { files: AttachmentRef[] };
  expect(files.map((f) => [f.name, f.kind])).toEqual([
    ['dot.png', 'image'],
    ['note.txt', 'document'],
  ]);

  const got = await api(port, `/api/files/${files[0]?.id}`, { headers: { cookie } });
  expect(got.headers.get('content-type')).toBe('image/png');
  expect(got.headers.get('content-disposition')).toMatch(/^inline;/);
  expect(got.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  const txt = await api(port, `/api/files/${files[1]?.id}`, { headers: { cookie } });
  expect(txt.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''note.txt");
  const fake = new FormData();
  fake.append('files', new Blob(['not a png'], { type: 'image/png' }), 'x.png');
  const bad = await api(port, '/api/files', { method: 'POST', body: fake, headers: { cookie } });
  expect(bad.status).toBe(415);
  expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
  expect((await api(port, `/api/files/${randomUUID()}`, { headers: { cookie } })).status).toBe(404);

  const c = await connect(port, undefined, cookie);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Katso', attachments: files });
  await c.next('message.final');
  await c.idle();
  const user = llm.requests[0]?.body.messages.find((m: { role: string }) => m.role === 'user');
  const text = user.content.find((p: { type: string }) => p.type === 'text').text;
  expect(text).toContain('Katso');
  expect(text).toContain('[Liite: note.txt]\nmuistiinpano 42');
  const image = user.content.find((p: { type: string }) => p.type === 'image_url');
  expect(image).toEqual({
    type: 'image_url',
    image_url: { url: expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/) },
  });

  c.send({ type: 'chat.open', chatId: chat.id });
  const [first] = (await c.next('chat.state')).messages;
  expect(first?.text).toBe('Katso');
  expect(first?.attachments.map((a) => a.name)).toEqual(['dot.png', 'note.txt']);
});

test('pseudo: model sees surrogates, client sees restored text with annotations', {
  timeout: 30_000,
}, async () => {
  const sc = await startFakeSidecar({
    'Matti Virtanen': 'Pekka Laaksonen',
    '010190-123A': '010190-900B',
  });
  cleanups.push(sc.close);
  const { llm, config, run } = await boot([{ text: 'Hei Pekka Laaksonen, hetu 010190-900B.' }], {
    PSEUDO_URL: sc.url,
  });
  let srv = await run();
  let c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi Matti Virtanen' });
  const final = await c.next('message.final');
  await c.idle();
  const body = JSON.stringify(llm.requests[0]?.body);
  expect(body).toContain('Pekka Laaksonen');
  expect(body).not.toContain('Matti Virtanen');

  const real = 'Hei Matti Virtanen, hetu 010190-123A.';
  const deltas = deltasOf(c.inbox);
  expect(deltas.length).toBeGreaterThan(1);
  expect(deltas.map((d) => d.text).join('')).toBe(real);
  let offset = 0;
  const spans = deltas.flatMap((d) => {
    const abs = d.annotations.map((a) => [
      real.slice(a.start + offset, a.end + offset),
      a.modelSaw,
    ]);
    offset += d.text.length;
    return abs;
  });
  expect(spans).toEqual([
    ['Matti Virtanen', 'Pekka Laaksonen'],
    ['010190-123A', '010190-900B'],
  ]);
  expect(final.message.text).toBe(real);
  const covered = (m: { text: string; annotations: { start: number; end: number }[] }) =>
    m.annotations.map((a) => m.text.slice(a.start, a.end));
  expect(covered(final.message)).toEqual(['Matti Virtanen', '010190-123A']);
  c.ws.close();
  await srv.close();

  srv = await run();
  c = await connect(config.port);
  c.send({ type: 'chat.open', chatId: chat.id });
  const state = await c.next('chat.state');
  expect(state.messages.map((m) => m.text)).toEqual(['Moi Matti Virtanen', real]);
  expect(state.messages.map(covered)).toEqual([
    ['Matti Virtanen'],
    ['Matti Virtanen', '010190-123A'],
  ]);
});

test('pseudo: sidecar down sends pseudo_down and no model request', {
  timeout: 30_000,
}, async () => {
  const sc = await startFakeSidecar({ 'Matti Virtanen': 'Pekka Laaksonen' });
  const { llm, config, run } = await boot([{ text: SCRIPTED }], { PSEUDO_URL: sc.url });
  await run();
  await sc.close();
  const c = await connect(config.port);
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi Matti Virtanen' });
  await expect(c.next('message.final')).rejects.toThrow('pseudo_down');
  expect(llm.requests).toHaveLength(0);
});
