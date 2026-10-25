import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pushSubscriptions } from '@pa/db';
import { listenLocal } from '@pa/fake-llm';
import { afterEach, expect, test, vi } from 'vitest';
import webpush from 'web-push';
import { api, boot, bootChat, cleanups, login, runCleanups } from './test-utils.ts';

afterEach(() => {
  vi.restoreAllMocks();
  return runCleanups();
});

const vapid = webpush.generateVAPIDKeys();
const VAPID_ENV = {
  VAPID_PUBLIC: vapid.publicKey,
  VAPID_PRIVATE: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.com',
};

const subscription = (endpoint: string) => {
  const ecdh = createECDH('prime256v1');
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: ecdh.generateKeys().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
};

const json = (cookie: string, method: string, body: unknown) => ({
  method,
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function fakePushService() {
  const hits: { headers: Record<string, unknown>; body: Buffer }[] = [];
  const state = { status: 201 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(state.status).end();
    });
  });
  const { origin, close } = await listenLocal(server);
  cleanups.push(close);
  return { url: `${origin}/push/abc`, hits, state };
}

test('push: settled and approval notify unfocused chats; 410 drops the row', {
  timeout: 60_000,
}, async () => {
  const fake = await fakePushService();
  const spy = vi.spyOn(webpush, 'generateRequestDetails');
  // Skips the subscribe-time dry runs (payload 'x').
  const payloads = () =>
    spy.mock.calls.filter((c) => c[1] !== 'x').map((c) => JSON.parse(String(c[1])));
  const { c, chat, config, srv } = await bootChat(
    [
      { text: 'Yksi' },
      { text: 'Kaksi' },
      { text: 'Kolme' },
      { toolCalls: [{ name: 'write', args: { path: 'a.txt', content: 'x' } }] },
      { text: 'Valmis.' },
    ],
    { ...VAPID_ENV, PUSH_ALLOW_ANY_HOST: '1' },
  );
  const { cookie } = await login(config.port);
  const vapidRes = await api(config.port, '/api/push/vapid', { headers: { cookie } });
  expect(await vapidRes.json()).toEqual({ publicKey: vapid.publicKey });
  const sub = subscription(fake.url);
  const subscribe = () => api(config.port, '/api/push/subscribe', json(cookie, 'POST', sub));
  expect((await subscribe()).status).toBe(200);

  // No socket has the chat focused: one encrypted POST with a VAPID header.
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  await vi.waitFor(() => expect(fake.hits).toHaveLength(1));
  const hit = fake.hits[0];
  expect(String(hit?.headers.authorization)).toMatch(/^vapid t=.+, k=/);
  expect(hit?.headers['content-encoding']).toBe('aes128gcm');
  expect(hit?.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  expect(hit?.body.length).toBeGreaterThan(0);
  expect(hit?.body.toString('latin1')).not.toContain(chat.id);
  expect(payloads()).toEqual([
    { title: 'Uusi keskustelu', chatId: chat.id, kind: 'settled', tag: chat.id },
  ]);

  // Focused: no POST.
  c.send({ type: 'chat.focus', chatId: chat.id });
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  await new Promise((r) => setTimeout(r, 300));
  expect(fake.hits).toHaveLength(1);

  // 410 Gone: the subscription row is removed.
  c.send({ type: 'chat.focus', chatId: null });
  fake.state.status = 410;
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  await vi.waitFor(() => expect(srv.db.select().from(pushSubscriptions).all()).toHaveLength(0));
  expect(fake.hits).toHaveLength(2);

  // approval.request pushes with kind approval.
  fake.state.status = 201;
  expect((await subscribe()).status).toBe(200);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Kirjoita' });
  const req = await c.next('approval.request');
  expect(req.callId).toBeTruthy();
  await vi.waitFor(() => expect(fake.hits).toHaveLength(3));
  expect(payloads().at(-1)).toEqual({
    title: 'Uusi keskustelu',
    chatId: chat.id,
    kind: 'approval',
    tag: chat.id,
  });
  c.send({ type: 'approval.respond', requestId: req.requestId, approve: true });
  await c.idle();
});

test('push: endpoint allowlist, unsubscribe, disabled without VAPID', {
  timeout: 30_000,
}, async () => {
  const { config, run } = await boot([], VAPID_ENV);
  const srv = await run();
  const { cookie } = await login(config.port);
  const post = (body: unknown) =>
    api(config.port, '/api/push/subscribe', json(cookie, 'POST', body));
  expect((await post(subscription('http://127.0.0.1:9/push'))).status).toBe(400);
  expect((await post(subscription('https://evil.example/push'))).status).toBe(400);
  expect((await post({ endpoint: 'nope' })).status).toBe(400);
  const badKeys = {
    ...subscription('https://fcm.googleapis.com/x'),
    keys: { p256dh: 'AA', auth: 'AA' },
  };
  expect((await post(badKeys)).status).toBe(400);
  const ok = subscription('https://fcm.googleapis.com/fcm/send/abc');
  expect((await post(ok)).status).toBe(200);
  expect((await post(subscription('https://web.push.apple.com/x'))).status).toBe(200);
  expect(srv.db.select().from(pushSubscriptions).all()).toHaveLength(2);
  const del = json(cookie, 'DELETE', { endpoint: ok.endpoint });
  expect((await api(config.port, '/api/push/subscribe', del)).status).toBe(200);
  expect(srv.db.select().from(pushSubscriptions).all()).toHaveLength(1);
  // At most 20 per user: the oldest goes.
  for (let i = 0; i < 20; i++)
    expect((await post(subscription(`https://fcm.googleapis.com/fcm/send/n${i}`))).status).toBe(
      200,
    );
  const rows = srv.db.select().from(pushSubscriptions).all();
  expect(rows).toHaveLength(20);
  expect(rows.some((r) => r.endpoint === 'https://web.push.apple.com/x')).toBe(false);

  const off = await boot([]);
  await off.run();
  const c2 = (await login(off.config.port)).cookie;
  expect((await api(off.config.port, '/api/push/vapid', { headers: { cookie: c2 } })).status).toBe(
    404,
  );
});
