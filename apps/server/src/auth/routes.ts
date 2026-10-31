import { randomUUID } from 'node:crypto';
import { type Db, passkeys } from '@pa/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import { verifyPassword } from './password.ts';
import {
  createSession,
  destroySession,
  getUser,
  listSessions,
  revokeAll,
  revokeSession,
  sessionCookie,
  sessionCookieName,
} from './session.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    /** sha256 of the cookie token (`authSessions.id`). */
    sessionId: string;
    sessionCreatedAt: string;
  }
}

/** Open WebSockets per session (phase-15 decision 12): revoked ones close, a rotated one moves. */
export type SessionSockets = {
  revoke(ids: string[]): void;
  rename(from: string, to: string): void;
};

type AuthConfig = Pick<
  Config,
  'authOrigin' | 'passkeyRpId' | 'passwordHash' | 'cookieSecure' | 'userId'
>;

const CHALLENGE_COOKIE = 'pa_challenge';
const CHALLENGE_PATH = '/api/auth/passkey';
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 10_000;
const FRESH_MS = 10 * 60_000;
const RP_NAME = 'Personal Assistant';

type Purpose = 'reg' | 'auth';

// One scrypt verify at a time: each allocates about 128 MiB and holds a threadpool slot.
let verifying: Promise<unknown> = Promise.resolve();
const verifyOne = (stored: string, password: string) => {
  const run = verifying.then(() => verifyPassword(stored, password));
  verifying = run.catch(() => {});
  return run;
};

/** Counts attempts per key (`fail`); blocked after `max` of them in `windowMs`. */
export function limiter(app: FastifyInstance, max = 5, windowMs = 60_000) {
  const fails = new Map<string, number[]>();
  const recent = (key: string, now = Date.now()) =>
    (fails.get(key) ?? []).filter((t) => now - t < windowMs);
  const prune = setInterval(() => {
    for (const key of fails.keys()) {
      const r = recent(key);
      if (r.length) fails.set(key, r);
      else fails.delete(key);
    }
  }, windowMs);
  prune.unref();
  app.addHook('onClose', async () => clearInterval(prune));
  return {
    blocked: (key: string) => recent(key).length >= max,
    fail: (key: string) => fails.set(key, [...recent(key), Date.now()]),
  };
}

/** preHandler: 401 without a valid session; sets `req.userId` and re-sets a refreshed cookie. */
export const requireUser =
  (db: Db, secure: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getUser(db, req, secure);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.refreshed)
      reply.setCookie(sessionCookieName(secure), user.token, sessionCookie(secure));
    req.userId = user.userId;
    req.sessionId = user.id;
    req.sessionCreatedAt = user.createdAt;
  };

/** After `requireUser`: the session was created in the last 10 minutes. */
export const isFresh = (req: FastifyRequest) =>
  Date.now() - Date.parse(req.sessionCreatedAt) < FRESH_MS;

/** preHandler after `requireUser`: 403 `reauth` unless the session is fresh. */
const requireFresh = async (req: FastifyRequest, reply: FastifyReply) => {
  if (!isFresh(req)) return reply.code(403).send({ error: 'reauth' });
};

const responseBody = {
  body: {
    type: 'object',
    required: ['response'],
    properties: { response: { type: 'object' } },
  },
} as const;

export function authRoutes(
  app: FastifyInstance,
  db: Db,
  config: AuthConfig,
  sockets: SessionSockets = { revoke: () => {}, rename: () => {} },
) {
  const auth = requireUser(db, config.cookieSecure);
  const cookieName = sessionCookieName(config.cookieSecure);
  /** `Secure` too: a browser ignores a `__Host-` Set-Cookie without it, the clearing one included. */
  const clearSession = { path: '/', secure: config.cookieSecure };
  const passwordLimit = limiter(app);
  // All clients together: an IP key alone fails behind a CDN or with a rotating IPv6 /64.
  const passwordGlobal = limiter(app, 10);
  // Shared by passkey login options and verify: every options request and every failed verify
  // count, so one client cannot fill the challenge map (MAX_CHALLENGES) for everyone.
  const passkeyLimit = limiter(app);
  const challenges = new Map<string, { challenge: string; purpose: Purpose; expiresAt: number }>();
  app.decorateRequest('userId', '');
  app.decorateRequest('sessionId', '');
  app.decorateRequest('sessionCreatedAt', '');

  const login = (req: FastifyRequest, reply: FastifyReply, userId: string) =>
    reply
      .setCookie(
        cookieName,
        createSession(db, userId, req.headers['user-agent']),
        sessionCookie(config.cookieSecure),
      )
      .send({ userId });

  /** Stores the challenge server-side; the signed cookie carries only a random id. */
  const setChallenge = (reply: FastifyReply, challenge: string, purpose: Purpose) => {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.expiresAt <= now) challenges.delete(id);
    const id = randomUUID();
    challenges.set(id, { challenge, purpose, expiresAt: now + CHALLENGE_TTL_MS });
    return reply.setCookie(CHALLENGE_COOKIE, id, {
      ...sessionCookie(config.cookieSecure),
      path: CHALLENGE_PATH,
      maxAge: CHALLENGE_TTL_MS / 1000,
      signed: true,
    });
  };

  /** Consumes the challenge; undefined when missing, tampered, expired or for another purpose. */
  const takeChallenge = (req: FastifyRequest, reply: FastifyReply, purpose: Purpose) => {
    reply.clearCookie(CHALLENGE_COOKIE, { path: CHALLENGE_PATH });
    const raw = req.cookies[CHALLENGE_COOKIE];
    const u = raw ? req.unsignCookie(raw) : undefined;
    if (!u?.valid || !u.value) return undefined;
    const c = challenges.get(u.value);
    challenges.delete(u.value);
    return c && c.purpose === purpose && c.expiresAt > Date.now() ? c.challenge : undefined;
  };

  const full = (reply: FastifyReply) =>
    challenges.size >= MAX_CHALLENGES ? reply.code(503).send({ error: 'busy' }) : undefined;

  app.post<{ Body: { password: string } }>(
    '/api/auth/password',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (req, reply) => {
      if (passwordLimit.blocked(req.ip) || passwordGlobal.blocked('global'))
        return reply.code(429).send({ error: 'rate_limited' });
      // Count the attempt before the verify, so requests in flight count too.
      passwordLimit.fail(req.ip);
      passwordGlobal.fail('global');
      if (!config.passwordHash || !(await verifyOne(config.passwordHash, req.body.password)))
        return reply.code(401).send({ error: 'invalid' });
      return login(req, reply, config.userId);
    },
  );

  app.get('/api/auth/me', { preHandler: auth }, async (req) => ({
    userId: req.userId,
    passkeys: db
      .select({ id: passkeys.id, createdAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt })
      .from(passkeys)
      .where(eq(passkeys.userId, req.userId))
      .all(),
  }));

  app.post('/api/auth/logout', { preHandler: auth }, async (req, reply) => {
    destroySession(db, req.cookies[cookieName] ?? '');
    sockets.revoke([req.sessionId]);
    return reply.clearCookie(cookieName, clearSession).code(204).send();
  });

  // Laitteet (phase-15 decisions 11 and 12). No fresh login: revoking protects, so it is one step.
  app.get('/api/auth/sessions', { preHandler: auth }, async (req) => ({
    sessions: listSessions(db, req.userId, req.sessionId),
  }));

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    { preHandler: auth },
    async (req, reply) => {
      if (!revokeSession(db, req.userId, req.params.id))
        return reply.code(404).send({ error: 'not_found' });
      sockets.revoke([req.params.id]);
      if (req.params.id === req.sessionId) reply.clearCookie(cookieName, clearSession);
      return reply.code(204).send();
    },
  );

  app.post('/api/auth/sessions/revoke-all', { preHandler: auth }, async (req, reply) => {
    const { token, id, revoked } = revokeAll(db, req.userId, req.sessionId);
    sockets.revoke(revoked);
    sockets.rename(req.sessionId, id);
    return reply.setCookie(cookieName, token, sessionCookie(config.cookieSecure)).code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    '/api/auth/passkey/:id',
    { preHandler: auth },
    async (req, reply) => {
      const gone = db
        .delete(passkeys)
        .where(and(eq(passkeys.id, req.params.id), eq(passkeys.userId, req.userId)))
        .returning({ id: passkeys.id })
        .get();
      return gone ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
    },
  );

  app.post(
    '/api/auth/passkey/register/options',
    { preHandler: [auth, requireFresh] },
    async (req, reply) => {
      if (full(reply)) return reply;
      const existing = db
        .select({ id: passkeys.id, transports: passkeys.transports })
        .from(passkeys)
        .where(eq(passkeys.userId, req.userId))
        .all();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: config.passkeyRpId,
        userName: req.userId,
        userID: new TextEncoder().encode(req.userId),
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ?? [] })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      return setChallenge(reply, options.challenge, 'reg').send(options);
    },
  );

  app.post<{ Body: { response: RegistrationResponseJSON } }>(
    '/api/auth/passkey/register/verify',
    { preHandler: [auth, requireFresh], schema: responseBody },
    async (req, reply) => {
      const challenge = takeChallenge(req, reply, 'reg');
      if (!challenge) return reply.code(400).send({ error: 'invalid' });
      const result = await verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: config.authOrigin,
        expectedRPID: config.passkeyRpId,
      }).catch(() => undefined);
      if (!result?.verified) return reply.code(400).send({ error: 'invalid' });
      const { credential } = result.registrationInfo;
      // Credential ids are global, so this lookup is by id alone.
      if (db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.id, credential.id)).get())
        return reply.code(409).send({ error: 'exists' });
      db.insert(passkeys)
        .values({
          id: credential.id,
          userId: req.userId,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          transports: credential.transports ?? [],
          createdAt: new Date().toISOString(),
        })
        .run();
      return { ok: true };
    },
  );

  app.post('/api/auth/passkey/login/options', async (req, reply) => {
    if (passkeyLimit.blocked(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
    passkeyLimit.fail(req.ip);
    if (full(reply)) return reply;
    const options = await generateAuthenticationOptions({
      rpID: config.passkeyRpId,
      userVerification: 'required',
    });
    return setChallenge(reply, options.challenge, 'auth').send(options);
  });

  app.post<{ Body: { response: AuthenticationResponseJSON } }>(
    '/api/auth/passkey/login/verify',
    { schema: responseBody },
    async (req, reply) => {
      if (passkeyLimit.blocked(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      const reject = () => {
        passkeyLimit.fail(req.ip);
        return reply.code(401).send({ error: 'invalid' });
      };
      const challenge = takeChallenge(req, reply, 'auth');
      const id = req.body.response.id;
      const row =
        typeof id === 'string'
          ? db.select().from(passkeys).where(eq(passkeys.id, id)).get()
          : undefined;
      if (!challenge || !row) return reject();
      const result = await verifyAuthenticationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: config.authOrigin,
        expectedRPID: config.passkeyRpId,
        credential: {
          id: row.id,
          publicKey: Buffer.from(row.publicKey, 'base64url'),
          counter: row.counter,
          transports: row.transports ?? [],
        },
      }).catch(() => undefined);
      if (!result?.verified) return reject();
      db.update(passkeys)
        .set({
          counter: result.authenticationInfo.newCounter,
          lastUsedAt: new Date().toISOString(),
        })
        .where(and(eq(passkeys.id, row.id), eq(passkeys.userId, row.userId)))
        .run();
      return login(req, reply, row.userId);
    },
  );
}
