import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import type { AttachmentRef, ServerMessage } from '@pa/protocol';
import sharp from 'sharp';
import { afterEach, expect, test, vi } from 'vitest';
import { verifyPassword } from './auth/password.ts';
import {
  api,
  boot,
  bootPseudo,
  cleanups,
  connect,
  KEY,
  login,
  openFirst,
  runCleanups,
  tempDir,
} from './test-utils.ts';

vi.mock('./auth/password.ts', async (actual) => {
  const m = await actual<typeof import('./auth/password.ts')>();
  return { ...m, verifyPassword: vi.fn(m.verifyPassword) };
});

const SCRIPTED = 'Hei! Miten voin auttaa?';
afterEach(runCleanups);

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
  // A new chat is Auto under ZDR (phase-10 decisions 5 and 6).
  expect(llm.requests[0]?.body.model).toBe('zdr/google/gemini-4-argon');
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

test('app paths answer index.html; /api and non-HTML requests do not (phase-23 decision 19)', {
  timeout: 30_000,
}, async () => {
  const web = tempDir('pa-web-');
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>app</title>');
  const { config, run } = await boot([], { WEB_DIST: web });
  await run();
  const html = { headers: { accept: 'text/html' } };
  for (const path of ['/c/abc', '/files', '/search?q=kissa', '/settings']) {
    const res = await api(config.port, path, html);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>app</title>');
  }
  expect((await api(config.port, '/api/nope', html)).status).toBe(404);
  expect((await api(config.port, '/c/abc')).status).toBe(404);
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

test('only the zdr and open providers resolve credentials (invariant 2)', {
  timeout: 30_000,
}, async () => {
  const { run } = await boot([]);
  const srv = await run();
  const available = await (await srv.registry.modelRuntime()).getAvailable();
  expect(available.length).toBeGreaterThan(0);
  // Phase-10 decision 15: `open` is the per-chat opt-out; both reach only LiteLLM.
  expect(new Set(available.map((m) => m.provider))).toEqual(new Set(['zdr', 'open']));
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

  // Every attempt counts: the login above plus four 401s, then 429 even for the right password.
  for (let i = 0; i < 4; i++) expect((await login(port, 'wrong')).res.status).toBe(401);
  expect((await login(port, 'wrong')).res.status).toBe(429);
  expect((await login(port)).res.status).toBe(429);

  const out = await api(port, '/api/auth/logout', { method: 'POST', headers: { cookie } });
  expect(out.status).toBe(204);
  expect((await api(port, '/api/auth/me', { headers: { cookie } })).status).toBe(401);
});

test('auth: parallel wrong passwords count before the verify', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  vi.mocked(verifyPassword).mockClear();
  const res = await Promise.all(
    Array.from({ length: 30 }, () => login(config.port, 'wrong').then((r) => r.res.status)),
  );
  expect(vi.mocked(verifyPassword).mock.calls.length).toBeLessThanOrEqual(5);
  expect(res.filter((s) => s === 429).length).toBe(
    30 - vi.mocked(verifyPassword).mock.calls.length,
  );
  expect(new Set(res)).toEqual(new Set([401, 429]));
});

test('auth: on https the session cookie is __Host- and Secure', async () => {
  const { config, run } = await boot([], { AUTH_ORIGIN: 'https://assistant.example.invalid' });
  await run();
  const { res, cookie } = await login(config.port);
  expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-pa_session=.+; Path=\/; .*Secure/);
  expect((await api(config.port, '/api/auth/me', { headers: { cookie } })).status).toBe(200);
  // The old name no longer authenticates.
  const old = cookie.replace('__Host-pa_session', 'pa_session');
  expect((await api(config.port, '/api/auth/me', { headers: { cookie: old } })).status).toBe(401);
  const out = await api(config.port, '/api/auth/logout', { method: 'POST', headers: { cookie } });
  expect(out.headers.getSetCookie()[0]).toMatch(/^__Host-pa_session=;.*Secure/);
});

test('the request log has no query string', async () => {
  const { config, run, logs } = await boot([], { LOG_LEVEL: 'info' });
  await run();
  await api(config.port, '/api/files/tree?root=work&path=Synteettinen%20Nimi.pdf');
  const req = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'incoming request');
  expect(req?.req).toEqual({ method: 'GET', url: '/api/files/tree' });
  expect(logs.join('')).not.toContain('Synteettinen');
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

  const first = await openFirst(c, chat.id);
  expect(first?.text).toBe('Katso');
  expect(first?.attachments.map((a) => a.name)).toEqual(['dot.png', 'note.txt']);
});

/** Real values and surrogates covered by delta annotations, after chunk-relative → absolute. */
function deltaSpans(deltas: Extract<ServerMessage, { type: 'message.delta' }>[], real: string) {
  let offset = 0;
  return deltas.flatMap((d) => {
    const abs = d.annotations.map((a) => [
      real.slice(a.start + offset, a.end + offset),
      a.modelSaw,
    ]);
    offset += d.text.length;
    return abs;
  });
}

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
  expect(deltaSpans(deltas, real)).toEqual([
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

test('pseudo: hold-back keeps UTF-16 pairs and long surrogates whole', {
  timeout: 30_000,
}, async () => {
  const address = 'Pitkänkadunkulmankujanristeystie 123 B 45';
  expect(address.length).toBeGreaterThan(24);
  // 'Moikka ' is 7 units, so the 8-unit fake-LLM chunks split the emoji's surrogate pair.
  const { c, chat } = await bootPseudo(
    { 'Matti Virtanen': 'Pekka Laaksonen', 'Kotikatu 1': address },
    [{ text: 'Moikka 😀 Pekka Laaksonen!' }, { text: `Osoite ${address} on oikein.` }],
  );
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const [text, real, saw] of [
    ['Moi', 'Moikka 😀 Matti Virtanen!', 'Pekka Laaksonen'],
    ['Osoite?', 'Osoite Kotikatu 1 on oikein.', address],
  ] as const) {
    c.inbox.length = 0;
    c.send({ type: 'user.message', chatId: chat.id, text });
    const final = await c.next('message.final');
    await c.idle();
    const deltas = deltasOf(c.inbox);
    expect(deltas.map((d) => d.text).join('')).toBe(real);
    for (const d of deltas) expect(d.text).not.toMatch(lone);
    expect(deltaSpans(deltas, real).map(([, m]) => m)).toEqual([saw]);
    expect(final.message.text).toBe(real);
  }
});

test('pseudo: the guard checks the restored path', { timeout: 30_000 }, async () => {
  const { c, chat } = await bootPseudo({ '../app.db': 'safe.txt' }, [
    { toolCalls: [{ name: 'read', args: { path: 'safe.txt' } }] },
    { text: 'Denied.' },
  ]);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Lue tiedosto' });
  const end = await c.next('tool.end');
  expect(end.status).toBe('denied');
  expect(end.summary).toContain('path outside workspace');
  await c.idle();
});

test('vault: list, merge, pin and pending resolve answer with vault.state', {
  timeout: 30_000,
}, async () => {
  const { c, chat } = await bootPseudo(
    { 'Matti Virtanen': 'Pekka Laaksonen', 'Liisa Korhonen': 'Anna Mäkinen' },
    [{ text: 'ok' }],
    { pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.4 }] },
  );
  c.send({
    type: 'user.message',
    chatId: chat.id,
    text: 'Matti Virtanen, Matti Virtanen ja Liisa Korhonen',
  });
  await c.idle();

  c.send({ type: 'vault.list' });
  let state = await c.next('vault.state');
  expect(state.entities.map((e) => [e.canonical, e.surrogate, e.seenCount])).toEqual([
    ['Matti Virtanen', 'Pekka Laaksonen', 2],
    ['Liisa Korhonen', 'Anna Mäkinen', 1],
  ]);
  expect(state.entities[0]?.lastSeen).toMatch(/Z$/);
  expect(state.pending).toEqual([
    {
      id: 1,
      kind: 'PERSON',
      text: 'Koski',
      detector: 'gliner',
      score: 0.4,
      chatId: '',
      reason: 'uncertain',
      entityId: null,
    },
  ]);
  const [matti, liisa] = state.entities.map((e) => e.id) as [number, number];

  c.send({ type: 'vault.merge', fromIds: [liisa], intoId: matti });
  state = await c.next('vault.state');
  expect(state.entities.map((e) => [e.id, e.seenCount])).toEqual([[matti, 3]]);

  c.send({ type: 'vault.pin', entityId: matti, pinned: true });
  state = await c.next('vault.state');
  expect(state.entities[0]?.pinned).toBe(true);

  c.send({ type: 'vault.pending.resolve', pendingId: 1, action: 'confirm' });
  state = await c.next('vault.state');
  expect(state.pending).toEqual([]);
  expect(state.entities.map((e) => e.canonical)).toEqual(['Matti Virtanen', 'Koski']);
});

test('vault: without PSEUDO_URL replies not_implemented', { timeout: 30_000 }, async () => {
  const { config, run } = await boot([]);
  await run();
  const c = await connect(config.port);
  c.send({ type: 'vault.list' });
  await expect(c.next('vault.state')).rejects.toThrow('not_implemented');
});
