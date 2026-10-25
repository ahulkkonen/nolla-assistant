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
  SESSION_COOKIE,
  sessionCookie,
} from './session.ts';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

type AuthConfig = Pick<
  Config,
  'authOrigin' | 'passkeyRpId' | 'passwordHash' | 'cookieSecure' | 'userId'
>;

const CHALLENGE_COOKIE = 'pa_challenge';
const RP_NAME = 'Personal Assistant';

/** 5 attempts per minute per key. */
// ponytail: in-memory, per process; IPs that stop sending keep one stale entry. Move to the DB or prune on a timer if this ever faces many IPs.
function limiter(max = 5, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > max;
  };
}

/** preHandler: 401 without a valid session; sets `req.userId` and re-sets a refreshed cookie. */
export const requireUser =
  (db: Db, secure: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = getUser(db, req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (user.refreshed) reply.setCookie(SESSION_COOKIE, user.token, sessionCookie(secure));
    req.userId = user.userId;
  };

const responseBody = {
  body: {
    type: 'object',
    required: ['response'],
    properties: { response: { type: 'object' } },
  },
} as const;

export function authRoutes(app: FastifyInstance, db: Db, config: AuthConfig) {
  const auth = requireUser(db, config.cookieSecure);
  const passwordLimit = limiter();
  const passkeyLimit = limiter();
  app.decorateRequest('userId', '');

  const login = (reply: FastifyReply, userId: string) =>
    reply
      .setCookie(SESSION_COOKIE, createSession(db, userId), sessionCookie(config.cookieSecure))
      .send({ userId });

  const setChallenge = (reply: FastifyReply, challenge: string) =>
    reply.setCookie(CHALLENGE_COOKIE, challenge, {
      ...sessionCookie(config.cookieSecure),
      path: '/api/auth/passkey',
      maxAge: 300,
      signed: true,
    });

  /** Reads and clears the signed challenge; undefined when missing or tampered. */
  const takeChallenge = (req: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(CHALLENGE_COOKIE, { path: '/api/auth/passkey' });
    const raw = req.cookies[CHALLENGE_COOKIE];
    const u = raw ? req.unsignCookie(raw) : undefined;
    return u?.valid ? (u.value ?? undefined) : undefined;
  };

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
      if (passwordLimit(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      if (!config.passwordHash || !verifyPassword(config.passwordHash, req.body.password))
        return reply.code(401).send({ error: 'invalid' });
      return login(reply, config.userId);
    },
  );

  app.get('/api/auth/me', { preHandler: auth }, async (req) => ({
    userId: req.userId,
    passkeys: await db.$count(passkeys, eq(passkeys.userId, req.userId)),
  }));

  app.post('/api/auth/logout', { preHandler: auth }, async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE] ?? '');
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.post('/api/auth/passkey/register/options', { preHandler: auth }, async (req, reply) => {
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
    });
    return setChallenge(reply, options.challenge).send(options);
  });

  app.post<{ Body: { response: RegistrationResponseJSON } }>(
    '/api/auth/passkey/register/verify',
    { preHandler: auth, schema: responseBody },
    async (req, reply) => {
      const challenge = takeChallenge(req, reply);
      if (!challenge) return reply.code(400).send({ error: 'invalid' });
      const result = await verifyRegistrationResponse({
        response: req.body.response,
        expectedChallenge: challenge,
        expectedOrigin: config.authOrigin,
        expectedRPID: config.passkeyRpId,
      }).catch(() => undefined);
      if (!result?.verified) return reply.code(400).send({ error: 'invalid' });
      const { credential } = result.registrationInfo;
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

  app.post('/api/auth/passkey/login/options', async (_req, reply) => {
    const options = await generateAuthenticationOptions({ rpID: config.passkeyRpId });
    return setChallenge(reply, options.challenge).send(options);
  });

  app.post<{ Body: { response: AuthenticationResponseJSON } }>(
    '/api/auth/passkey/login/verify',
    { schema: responseBody },
    async (req, reply) => {
      if (passkeyLimit(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
      const challenge = takeChallenge(req, reply);
      const id = req.body.response.id;
      const row =
        typeof id === 'string'
          ? db.select().from(passkeys).where(eq(passkeys.id, id)).get()
          : undefined;
      if (!challenge || !row) return reply.code(401).send({ error: 'invalid' });
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
      if (!result?.verified) return reply.code(401).send({ error: 'invalid' });
      db.update(passkeys)
        .set({
          counter: result.authenticationInfo.newCounter,
          lastUsedAt: new Date().toISOString(),
        })
        .where(and(eq(passkeys.id, row.id), eq(passkeys.userId, row.userId)))
        .run();
      return login(reply, row.userId);
    },
  );
}
