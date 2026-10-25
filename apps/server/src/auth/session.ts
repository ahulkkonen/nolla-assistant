import { createHash, randomBytes } from 'node:crypto';
import { authSessions, type Db } from '@pa/db';
import { eq, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'pa_session';
const DAY = 86_400_000;
const TTL = 30 * DAY;
const REFRESH_BELOW = 15 * DAY;

export const sessionCookie = (secure: boolean) =>
  ({
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: TTL / 1000,
  }) as const;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Returns the raw token; only its sha256 is stored. */
export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.insert(authSessions)
    .values({
      id: hash(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
    })
    .run();
  return token;
}

/** `refreshed` means the expiry moved and the caller must re-set the cookie. */
export function getUser(
  db: Db,
  req: FastifyRequest,
): { userId: string; token: string; refreshed: boolean; createdAt: string } | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const id = hash(token);
  const row = db.select().from(authSessions).where(eq(authSessions.id, id)).get();
  if (!row) return null;
  const now = Date.now();
  const left = Date.parse(row.expiresAt) - now;
  if (left <= 0) {
    db.delete(authSessions).where(eq(authSessions.id, id)).run();
    return null;
  }
  const refreshed = left < REFRESH_BELOW;
  if (refreshed || now - Date.parse(row.lastSeenAt) > 60_000)
    db.update(authSessions)
      .set({
        lastSeenAt: new Date(now).toISOString(),
        ...(refreshed ? { expiresAt: new Date(now + TTL).toISOString() } : {}),
      })
      .where(eq(authSessions.id, id))
      .run();
  return { userId: row.userId, token, refreshed, createdAt: row.createdAt };
}

export function destroySession(db: Db, token: string): void {
  db.delete(authSessions)
    .where(eq(authSessions.id, hash(token)))
    .run();
}

/** Deletes expired sessions of all users (housekeeping, not a user query). */
export function purgeExpiredSessions(db: Db): void {
  db.delete(authSessions).where(lt(authSessions.expiresAt, new Date().toISOString())).run();
}
