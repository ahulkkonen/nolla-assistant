import { createHash } from 'node:crypto';
import { chats, type Db, pushSubscriptions } from '@nolla/db';
import { PushSubscription } from '@nolla/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, preHandlerHookHandler } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import type { Config } from './config.ts';

export type PushKind = 'settled' | 'approval' | 'automation';
const DEFAULT_TITLE = 'Uusi keskustelu';
const SEND_TIMEOUT_MS = 10_000;
const MAX_SUBSCRIPTIONS = 20;
const TTL = 24 * 3600;
// Apple, Google (FCM), Microsoft (WNS) and Mozilla push services.
const SUFFIXES = ['.push.apple.com', '.notify.windows.com', '.push.services.mozilla.com'];
const EXACT = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);

export class BadSubscription extends Error {}
type RequestDetailsFn = (
  sub: PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => webpush.RequestDetails;
// The typings' overloads reduce the payload variant to `never`; read at call time so tests can spy.
const requestDetails: RequestDetailsFn = (...args) =>
  (webpush.generateRequestDetails as RequestDetailsFn)(...args);

export function pushService({
  db,
  userId,
  config,
  log,
}: {
  db: Db;
  userId: string;
  config: Pick<Config, 'vapid' | 'pushAllowAnyHost'>;
  log: () => FastifyBaseLogger;
}) {
  const { vapid, pushAllowAnyHost } = config;
  /** Socket to the chat it shows in the foreground. */
  const focus = new Map<object, string>();

  const allowed = (endpoint: string) => {
    if (pushAllowAnyHost) return true;
    const { protocol, hostname } = new URL(endpoint);
    return (
      protocol === 'https:' && (EXACT.has(hostname) || SUFFIXES.some((s) => hostname.endsWith(s)))
    );
  };

  const drop = (endpoint: string) =>
    db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)))
      .run();

  return {
    enabled: !!vapid,
    publicKey: vapid?.publicKey,
    setFocus(socket: object, chatId: string | null) {
      if (chatId) focus.set(socket, chatId);
      else focus.delete(socket);
    },
    subscribe(sub: PushSubscription) {
      if (!allowed(sub.endpoint)) throw new BadSubscription();
      // Dry run: bad keys fail here (encryption needs a valid p256dh and auth), not at send time.
      try {
        requestDetails(sub, 'x', { TTL, ...(vapid ? { vapidDetails: vapid } : {}) });
      } catch {
        throw new BadSubscription();
      }
      const set = { subscription: sub, createdAt: new Date().toISOString() };
      // An endpoint keeps its first owner (`userId` is not updated): with several users, one cannot
      // take over another's subscription.
      db.insert(pushSubscriptions)
        .values({ endpoint: sub.endpoint, userId, ...set })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set })
        .run();
      const stale = db
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId))
        .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
        .all()
        .slice(MAX_SUBSCRIPTIONS)
        .map((r) => r.id);
      if (stale.length)
        db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale)).run();
    },
    unsubscribe: drop,
    /**
     * Sends `{ title, chatId, kind }` to every subscription unless a socket shows the chat. The
     * title is the restored chat title; message content never goes to a push service. Never throws.
     */
    async notify(chatId: string, kind: PushKind) {
      if (!vapid || [...focus.values()].includes(chatId)) return;
      await send(chatId, kind).catch((err: unknown) =>
        log().warn({ error: err instanceof Error ? err.message : 'unknown' }, 'push failed'),
      );
    },
  };

  async function send(chatId: string, kind: PushKind) {
    if (!vapid) return;
    const subs = db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all();
    if (subs.length === 0) return;
    const title =
      db
        .select({ title: chats.title })
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
        .get()?.title ?? DEFAULT_TITLE;
    // `tag` (notification) and `Topic` (push service) make a repeat replace the earlier one.
    const payload = JSON.stringify({ title, chatId, kind, tag: chatId });
    // Topic: at most 32 URL-safe base64 characters, so a hash of the chat id.
    const topic = createHash('sha1').update(chatId).digest('base64url');
    await Promise.all(
      subs.map(async ({ endpoint, subscription }) => {
        try {
          // web-push only speaks https; fetch sends its prepared request (and reaches test fakes).
          const req = requestDetails(subscription as PushSubscription, payload, {
            vapidDetails: vapid,
            TTL,
            topic,
          });
          // web-push sets Content-Length itself; Node 22's fetch rejects a caller-set one
          // ("invalid content-length header"). fetch computes it from the body.
          const headers = Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-length'),
          );
          const res = await fetch(req.endpoint, {
            method: req.method,
            headers,
            body: req.body as Uint8Array<ArrayBuffer>,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          if (res.status === 404 || res.status === 410) drop(endpoint);
          else if (!res.ok) log().warn({ status: res.status, kind }, 'push failed');
        } catch (err) {
          // `fetch failed` hides the socket error in `cause`; the log needs it (CI runners differ).
          const cause =
            err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
          log().warn(
            { error: err instanceof Error ? err.message + cause : 'unknown' },
            'push failed',
          );
        }
      }),
    );
  }
}
export type Push = ReturnType<typeof pushService>;

const Unsubscribe = z.object({ endpoint: z.string().max(2048) });

export function pushRoutes(app: FastifyInstance, auth: preHandlerHookHandler, push: Push) {
  app.get('/api/push/vapid', { preHandler: auth }, async (_req, reply) =>
    push.publicKey
      ? { publicKey: push.publicKey }
      : reply.code(404).send({ error: 'push_disabled' }),
  );
  app.post('/api/push/subscribe', { preHandler: auth }, async (req, reply) => {
    if (!push.enabled) return reply.code(404).send({ error: 'push_disabled' });
    const sub = PushSubscription.safeParse(req.body);
    if (!sub.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      push.subscribe(sub.data);
    } catch (err) {
      if (err instanceof BadSubscription)
        return reply.code(400).send({ error: 'bad_subscription' });
      throw err;
    }
    return { ok: true };
  });
  app.delete('/api/push/subscribe', { preHandler: auth }, async (req, reply) => {
    const body = Unsubscribe.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    push.unsubscribe(body.data.endpoint);
    return { ok: true };
  });
}
