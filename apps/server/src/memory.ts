import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chats, type Db, memoryPending } from '@pa/db';
import {
  applyOp,
  CAPS,
  FILES,
  FULL,
  type MemoryWrite,
  NOT_FOUND,
  type Snippet,
  type Target,
} from '@pa/pi-ext-memory';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import cron from 'node-cron';
import type { ClaimStore } from './claims.ts';
import { gitCommitter, writeAtomic } from './git.ts';
import { search } from './search.ts';

/**
 * A memory operation that cannot run. `message` is `FULL` (over cap), `CONFLICT` (files or text
 * changed) or `GENERATED` (MEMORY.md is generated from claims, phase 17).
 */
export class MemoryError extends Error {}
export const CONFLICT = 'conflict';
export const GENERATED = 'generated';
const MAX_PENDING = 5;
const TOO_MANY = 'liikaa odottavia kirjoituksia';

export type MemoryStore = ReturnType<typeof memoryStore>;

/**
 * Memory files, pending queue and consolidation (plan §7, phase-8 decisions 1–4). Files hold real
 * values under `DATA_DIR/memory/<userId>/`, one git commit per write.
 */
export function memoryStore(deps: {
  db: Db;
  dataDir: string;
  userId: string;
  pseudo?: PseudoClient | undefined;
  /** Called only after startup (on writes and jobs). */
  warn: (msg: string, data?: object) => void;
  /** Receives `memory.state` after the weekly consolidation. */
  sendAll: (msg: ServerMessage) => void;
  /** Phase 17: claims; MEMORY.md is generated from them and target `memory` writes them. */
  claims?: ClaimStore | undefined;
}) {
  const { db, userId, pseudo, warn } = deps;
  const dir = resolve(deps.dataDir, 'memory', userId);
  mkdirSync(dir, { recursive: true });
  const path = (t: Target) => join(dir, FILES[t]);
  for (const t of ['user', 'memory'] as const) if (!existsSync(path(t))) writeFileSync(path(t), '');
  const read = (t: Target) => readFileSync(path(t), 'utf8');

  const commit = gitCommitter(dir, warn, 'memory files');

  /**
   * The only file writer: cap check (a text over the cap fails only when it grows), then temp file
   * + rename per file, then one commit.
   */
  const put = (texts: Partial<Record<Target, string>>, note: string) => {
    for (const [t, text] of Object.entries(texts) as [Target, string][])
      if (text.length > CAPS[t] && text.length > read(t).length) throw new MemoryError(FULL);
    for (const [t, text] of Object.entries(texts) as [Target, string][]) writeAtomic(path(t), text);
    commit(note);
  };

  const applyWrite = async (w: MemoryWrite, chatId: string) => {
    if (w.target === 'memory' && deps.claims) {
      try {
        await deps.claims.toolWrite(w, chatId, false);
      } catch {
        throw new MemoryError(NOT_FOUND);
      }
      return;
    }
    const r = applyOp(read(w.target), w);
    if ('error' in r) throw new MemoryError(r.error === NOT_FOUND ? CONFLICT : r.error);
    put({ [w.target]: r.text }, `memory ${w.action} ${w.target} (chat ${chatId})`);
  };

  const pendingWhere = (id?: number) =>
    and(
      eq(memoryPending.userId, userId),
      eq(memoryPending.status, 'pending'),
      ...(id === undefined ? [] : [eq(memoryPending.id, id)]),
    );
  const state = (): ServerMessage => ({
    type: 'memory.state',
    user: read('user'),
    memory: read('memory'),
    pending: db
      .select({
        id: memoryPending.id,
        action: memoryPending.action,
        target: memoryPending.target,
        text: memoryPending.text,
        replace: memoryPending.replace,
        chatId: memoryPending.chatId,
      })
      .from(memoryPending)
      .where(pendingWhere())
      .all()
      .map(({ replace, ...p }) => {
        const old = p.action === 'remove' ? p.text : replace;
        return old == null ? p : { ...p, replace: old };
      }),
  });

  /**
   * Phase-17 decision 28: MEMORY.md from the active claims, no model call. Writes and commits only
   * when the bytes change.
   */
  const consolidate = async () => {
    if (!deps.claims) return;
    const { text, ids } = deps.claims.profile(CAPS.memory);
    if (text !== read('memory')) put({ memory: text }, `memory regenerate (${ids.length} claims)`);
    // Only after the write: a failed write leaves the old marks with the old file.
    deps.claims.markProfile(ids);
  };

  const task = cron.schedule(
    '0 4 * * 1',
    () =>
      consolidate().then(
        () => deps.sendAll(state()),
        (err: unknown) =>
          warn('consolidation failed', { error: err instanceof Error ? err.message : 'unknown' }),
      ),
    { timezone: 'Europe/Helsinki', noOverlap: true },
  );

  return {
    claims: deps.claims,
    dir,
    read,
    state,
    applyWrite,
    consolidate,
    /** Writes the user's own text (cap-checked). MEMORY.md is generated when claims are on. */
    edit: (t: Target, text: string) => {
      if (t === 'memory' && deps.claims) throw new MemoryError(GENERATED);
      put({ [t]: text }, `edit ${t}`);
    },
    /** Queues a write unvalidated; an identical pending write returns its id. Throws past MAX_PENDING per chat. */
    /**
     * Phase 17: a tainted `add` or `replace` on target `memory` becomes a proposed claim (its id);
     * a tainted `remove` waits here, so no claim ever holds the fact to forget.
     */
    async park(chatId: string, w: MemoryWrite): Promise<number> {
      if (w.target === 'memory' && w.action !== 'remove' && deps.claims)
        return deps.claims.toolWrite(w, chatId, true);
      const queued = db
        .select()
        .from(memoryPending)
        .where(and(pendingWhere(), eq(memoryPending.chatId, chatId)))
        .all();
      const replace = w.replace ?? null;
      const same = queued.find(
        (p) =>
          p.target === w.target &&
          p.action === w.action &&
          p.text === w.text &&
          p.replace === replace,
      );
      if (same) return same.id;
      if (queued.length >= MAX_PENDING) throw new Error(TOO_MANY);
      return db
        .insert(memoryPending)
        .values({
          userId,
          chatId,
          action: w.action,
          target: w.target,
          text: w.text,
          replace,
          createdAt: new Date().toISOString(),
        })
        .returning({ id: memoryPending.id })
        .get().id;
    },
    /**
     * Applies or rejects a pending write. A write that no longer applies is marked `failed` (and
     * leaves `memory.state`). Undefined when the id is not pending.
     */
    async approve(id: number, ok: boolean): Promise<'applied' | 'rejected' | 'failed' | undefined> {
      const p = db.select().from(memoryPending).where(pendingWhere(id)).get();
      if (!p) return;
      let status: 'applied' | 'rejected' | 'failed' = ok ? 'applied' : 'rejected';
      if (ok)
        try {
          await applyWrite({ ...p, replace: p.replace ?? undefined }, p.chatId);
        } catch (err) {
          if (!(err instanceof MemoryError)) throw err;
          status = 'failed';
        }
      db.update(memoryPending).set({ status }).where(eq(memoryPending.id, id)).run();
      return status;
    },
    /** Restored titles of the last three other chats; the injection masks them again. */
    recentTitles: (exceptChatId: string) =>
      db
        .select({ title: chats.title })
        .from(chats)
        .where(and(eq(chats.userId, userId), ne(chats.id, exceptChatId), isNotNull(chats.title)))
        .orderBy(desc(chats.updatedAt))
        .limit(3)
        .all()
        .map((r) => r.title ?? ''),
    async recall(q: string, filter: { since?: string; topic?: string }): Promise<Snippet[]> {
      const hits = await search(db, userId, q, 5, pseudo, { ...filter, mark: false });
      if (!hits.length) return [];
      const dates = new Map(
        db
          .select({ id: chats.id, createdAt: chats.createdAt })
          .from(chats)
          .where(
            inArray(
              chats.id,
              hits.map((h) => h.chatId),
            ),
          )
          .all()
          .map((r) => [r.id, r.createdAt]),
      );
      return hits.map((h) => ({
        chatId: h.chatId,
        title: h.title,
        snippet: h.snippet,
        date: dates.get(h.chatId) ?? '',
      }));
    },
    close: () => task.stop(),
  };
}
