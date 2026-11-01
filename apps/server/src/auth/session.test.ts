import { join } from 'node:path';
import { authSessions, openDb } from '@pa/db';
import { afterEach, expect, test, vi } from 'vitest';
import { runCleanups, tempDir } from '../test-utils.ts';
import { createSession, getUser, MAX_AGE, revokeAll } from './session.ts';

afterEach(async () => {
  vi.useRealTimers();
  await runCleanups();
});

const DAY = 86_400_000;

test('a session used every day still ends 90 days after the login (phase 35)', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2026-01-01T00:00:00Z');
  vi.setSystemTime(start);
  const { db, sqlite } = openDb(join(tempDir('pa-session-'), 'app.db'));
  const token = createSession(db, 'u1');
  const req = { cookies: { pa_session: token } } as never;
  let current = getUser(db, req, false);
  for (let day = 1; day < 90; day++) {
    vi.setSystemTime(start + day * DAY);
    current = getUser(db, req, false);
    expect(current?.userId).toBe('u1');
  }
  // Revoke-all gives a new token but keeps the login time.
  const { token: next, id } = revokeAll(db, 'u1', current?.id ?? '');
  const nextReq = { cookies: { pa_session: next } } as never;
  const row = db.select().from(authSessions).all()[0];
  expect(row?.id).toBe(id);
  expect(Date.parse(row?.expiresAt ?? '')).toBe(start + MAX_AGE);
  vi.setSystemTime(start + MAX_AGE - 1);
  expect(getUser(db, nextReq, false)?.userId).toBe('u1');
  vi.setSystemTime(start + MAX_AGE);
  expect(getUser(db, nextReq, false)).toBeNull();
  expect(db.select().from(authSessions).all()).toHaveLength(0);
  sqlite.close();
});

test('a row from before the cap with a later expiry ends at the cap', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2026-01-01T00:00:00Z');
  vi.setSystemTime(start);
  const { db, sqlite } = openDb(join(tempDir('pa-session-'), 'app.db'));
  const token = createSession(db, 'u1');
  db.update(authSessions)
    .set({ expiresAt: new Date(start + MAX_AGE + 20 * DAY).toISOString() })
    .run();
  vi.setSystemTime(start + MAX_AGE + DAY);
  expect(getUser(db, { cookies: { pa_session: token } } as never, false)).toBeNull();
  sqlite.close();
});

test('an unparsable createdAt fails closed; revoke-all does not throw on it', () => {
  const { db, sqlite } = openDb(join(tempDir('pa-session-'), 'app.db'));
  const bad = { createdAt: 'ei päivämäärä' };
  const token = createSession(db, 'u1');
  db.update(authSessions).set(bad).run();
  expect(getUser(db, { cookies: { pa_session: token } } as never, false)).toBeNull();
  expect(db.select().from(authSessions).all()).toHaveLength(0);
  createSession(db, 'u1');
  db.update(authSessions).set(bad).run();
  const id = db.select().from(authSessions).all()[0]?.id ?? '';
  expect(() => revokeAll(db, 'u1', id)).not.toThrow();
  const row = db.select().from(authSessions).all()[0];
  expect(Date.parse(row?.expiresAt ?? '')).toBeLessThanOrEqual(Date.now());
  sqlite.close();
});
