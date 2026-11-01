import { createHash, randomBytes } from 'node:crypto';
import { authSessions, type Db } from '@pa/db';
import type { DeviceSession } from '@pa/protocol';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

/**
 * `__Host-` on https: the browser then refuses the cookie from a sibling subdomain and without
 * `Secure` and `Path=/`, so a same-site host cannot plant or overwrite it.
 */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-pa_session' : 'pa_session');
const DAY = 86_400_000;
const TTL = 30 * DAY;
const REFRESH_BELOW = 15 * DAY;
/** Hard cap from the login (phase 35): use extends a session, but never past this age. */
export const MAX_AGE = 90 * DAY;
/** The sliding expiry, capped at `MAX_AGE` after `created`. */
const expiry = (created: number, now: number) => Math.min(now + TTL, created + MAX_AGE);

export const sessionCookie = (secure: boolean) =>
  ({
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: TTL / 1000,
  }) as const;

/** The session id: sha256 hex of the cookie token. */
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * "Safari · iPhone" from a User-Agent header (phase-15 decision 11); null when neither part is
 * known. The header itself is not stored.
 */
export function deviceLabel(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  // iOS user agents also say "Mac OS X".
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'macOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : null;
  return [browser, os].filter(Boolean).join(' · ') || null;
}

const newToken = () => randomBytes(32).toString('base64url');

/** Returns the raw token; only its sha256 is stored. */
export function createSession(db: Db, userId: string, userAgent?: string): string {
  const token = newToken();
  const now = Date.now();
  db.insert(authSessions)
    .values({
      id: hash(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      deviceLabel: deviceLabel(userAgent)?.slice(0, 80) ?? null,
    })
    .run();
  return token;
}

/** The user's signed-in devices, newest activity first; `currentId` is the request's session. */
export function listSessions(db: Db, userId: string, currentId: string): DeviceSession[] {
  return db
    .select()
    .from(authSessions)
    .where(
      and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date().toISOString())),
    )
    .orderBy(desc(authSessions.lastSeenAt))
    .all()
    .map((r) => ({
      id: r.id,
      label: r.deviceLabel,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      current: r.id === currentId,
    }));
}

/** Deletes one session of the user; false when there is none. */
export function revokeSession(db: Db, userId: string, id: string): boolean {
  return !!db
    .delete(authSessions)
    .where(and(eq(authSessions.id, id), eq(authSessions.userId, userId)))
    .returning({ id: authSessions.id })
    .get();
}

/**
 * Deletes every session of the user and gives the current one a new token (phase-15 decision 12):
 * a copy of the old cookie stops working too. The new row keeps `createdAt` (the fresh-login rule)
 * and the label. Returns the new token, the new id and the deleted ids other than the current one.
 */
export function revokeAll(db: Db, userId: string, currentId: string) {
  const token = newToken();
  const id = hash(token);
  const now = Date.now();
  const revoked = db.transaction((tx) => {
    const own = eq(authSessions.userId, userId);
    const rows = tx.select().from(authSessions).where(own).all();
    const cur = rows.find((r) => r.id === currentId);
    if (!cur) throw new Error('current session missing');
    tx.delete(authSessions).where(own).run();
    tx.insert(authSessions)
      .values({
        ...cur,
        id,
        expiresAt: new Date(expiry(Date.parse(cur.createdAt), now)).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
      })
      .run();
    return rows.filter((r) => r.id !== currentId).map((r) => r.id);
  });
  return { token, id, revoked };
}

/** `refreshed` means the expiry moved and the caller must re-set the cookie. */
export function getUser(
  db: Db,
  req: FastifyRequest,
  secure: boolean,
): { userId: string; id: string; token: string; refreshed: boolean; createdAt: string } | null {
  const token = req.cookies[sessionCookieName(secure)];
  if (!token) return null;
  const id = hash(token);
  const row = db.select().from(authSessions).where(eq(authSessions.id, id)).get();
  if (!row) return null;
  const now = Date.now();
  const created = Date.parse(row.createdAt);
  const left = Date.parse(row.expiresAt) - now;
  // The age check also ends a row whose expiry was set before the cap existed.
  if (left <= 0 || now - created >= MAX_AGE) {
    db.delete(authSessions).where(eq(authSessions.id, id)).run();
    return null;
  }
  const next = expiry(created, now);
  const refreshed = left < REFRESH_BELOW && next > Date.parse(row.expiresAt);
  if (refreshed || now - Date.parse(row.lastSeenAt) > 60_000)
    db.update(authSessions)
      .set({
        lastSeenAt: new Date(now).toISOString(),
        ...(refreshed ? { expiresAt: new Date(next).toISOString() } : {}),
      })
      .where(eq(authSessions.id, id))
      .run();
  return { userId: row.userId, id, token, refreshed, createdAt: row.createdAt };
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
