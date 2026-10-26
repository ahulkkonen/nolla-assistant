import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chats, type Db, memoryConsolidations, memoryPending } from '@pa/db';
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
import { z } from 'zod';
import { gitCommitter, writeAtomic } from './git.ts';
import { search } from './search.ts';
import { taskSmall } from './topics.ts';
import type { RecordUsage } from './usage.ts';

/**
 * A memory operation that cannot run. `message` is `FULL` (over cap), `CONFLICT` (files or text
 * changed) or `PSEUDO_REQUIRED` (no sidecar: masked-only consolidation is impossible).
 */
export class MemoryError extends Error {}
export const CONFLICT = 'conflict';
export const PSEUDO_REQUIRED = 'pseudo_required';
const MAX_PENDING = 5;
const TOO_MANY = 'liikaa odottavia kirjoituksia';

export const CONSOLIDATE_PROMPT = `Olet muistin tiivistäjä. Saat käyttäjän kaksi muistitiedostoa: USER.md (kuka käyttäjä on, mieltymykset, pysyvät ohjeet) ja MEMORY.md (pysyvät faktat). Tiivistä molemmat: yhdistä päällekkäiset kohdat, poista vanhentuneet ja ristiriitaiset tiedot, säilytä kaikki edelleen paikkansapitävä. Älä keksi uutta tietoa. Säilytä nimet ja muut tunnisteet täsmälleen sellaisinaan.

Vastaa pelkällä JSON-objektilla, ilman muuta tekstiä:
{"user": string, "memory": string}

Säännöt:
- user: uusi USER.md, enintään ${CAPS.user} merkkiä.
- memory: uusi MEMORY.md, enintään ${CAPS.memory} merkkiä.
- Lyhyet rivit, yksi asia riviä kohden, tiedostojen kielellä (yleensä suomi).`;

const Proposal = z.object({
  user: z.string().max(CAPS.user),
  memory: z.string().max(CAPS.memory),
});

/** Whole-file unified diff from an LCS line table; '' when the texts are equal. */
export function lineDiff(name: string, a: string, b: string): string {
  if (a === b) return '';
  const x = a ? a.split('\n') : [];
  const y = b ? b.split('\n') : [];
  const w = y.length + 1;
  const L = new Uint32Array((x.length + 1) * w);
  const at = (i: number, j: number) => L[i * w + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      L[i * w + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out = [`--- a/${name}`, `+++ b/${name}`, `@@ -1,${x.length} +1,${y.length} @@`];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(` ${x[i++]}`);
      j++;
    } else if (i < x.length && (j >= y.length || at(i + 1, j) >= at(i, j + 1)))
      out.push(`-${x[i++]}`);
    else out.push(`+${y[j++]}`);
  }
  return out.join('\n');
}

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
  litellmUrl: string;
  litellmMasterKey: string;
  /** Called only after startup (on writes and jobs). */
  warn: (msg: string, data?: object) => void;
  /** Receives `memory.state` after the weekly consolidation. */
  sendAll: (msg: ServerMessage) => void;
  /** The consolidation call as a `task` row (phase-13 decision 14). */
  onUsage?: RecordUsage | undefined;
}) {
  const { db, userId, pseudo, warn } = deps;
  const dir = resolve(deps.dataDir, 'memory', userId);
  mkdirSync(dir, { recursive: true });
  const path = (t: Target) => join(dir, FILES[t]);
  for (const t of ['user', 'memory'] as const) if (!existsSync(path(t))) writeFileSync(path(t), '');
  const read = (t: Target) => readFileSync(path(t), 'utf8');
  const baseHash = () =>
    createHash('sha256')
      .update(`${read('user')}\0${read('memory')}`)
      .digest('hex');

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

  const applyWrite = (w: MemoryWrite, chatId: string) => {
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
  const consolidationWhere = (id?: number) =>
    and(
      eq(memoryConsolidations.userId, userId),
      eq(memoryConsolidations.status, 'pending'),
      ...(id === undefined ? [] : [eq(memoryConsolidations.id, id)]),
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
    consolidation:
      db
        .select({ id: memoryConsolidations.id, diff: memoryConsolidations.diff })
        .from(memoryConsolidations)
        .where(consolidationWhere())
        .orderBy(desc(memoryConsolidations.id))
        .get() ?? null,
  });

  const ask = taskSmall(deps.litellmUrl, deps.litellmMasterKey, deps.onUsage);
  const consolidate = async () => {
    const user = read('user');
    const memory = read('memory');
    // Invariant 1: never send the real files.
    if (!pseudo) throw new MemoryError(PSEUDO_REQUIRED);
    const base = baseHash();
    const mask = async (t: string) => (t ? (await pseudo.mask(`memory:${userId}`, t)).masked : t);
    const unmask = async (t: string) => (t ? (await pseudo.unmask(t)).restored : t);
    const reply = await ask(Proposal, [
      { role: 'system', content: CONSOLIDATE_PROMPT },
      {
        role: 'user',
        content: `USER.md:\n${await mask(user)}\n\nMEMORY.md:\n${await mask(memory)}`,
      },
    ]);
    if (!reply) return warn('consolidation reply invalid');
    const proposedUser = await unmask(reply.user);
    const proposedMemory = await unmask(reply.memory);
    // Surrogates can be shorter than the real values.
    if (proposedUser.length > CAPS.user || proposedMemory.length > CAPS.memory)
      return warn('consolidation over cap after restore: discarded');
    const diff = [
      lineDiff('USER.md', user, proposedUser),
      lineDiff('MEMORY.md', memory, proposedMemory),
    ]
      .filter(Boolean)
      .join('\n');
    if (!diff) return;
    db.transaction((tx) => {
      tx.update(memoryConsolidations)
        .set({ status: 'superseded' })
        .where(consolidationWhere())
        .run();
      tx.insert(memoryConsolidations)
        .values({
          userId,
          diff,
          proposedUser,
          proposedMemory,
          baseHash: base,
          createdAt: new Date().toISOString(),
        })
        .run();
    });
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
    dir,
    read,
    state,
    applyWrite,
    consolidate,
    /** Writes the user's own text (cap-checked). */
    edit: (t: Target, text: string) => put({ [t]: text }, `edit ${t}`),
    /** Queues a write unvalidated; an identical pending write returns its id. Throws past MAX_PENDING per chat. */
    park(chatId: string, w: MemoryWrite): number {
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
    approve(id: number, ok: boolean): 'applied' | 'rejected' | 'failed' | undefined {
      const p = db.select().from(memoryPending).where(pendingWhere(id)).get();
      if (!p) return;
      let status: 'applied' | 'rejected' | 'failed' = ok ? 'applied' : 'rejected';
      if (ok)
        try {
          applyWrite({ ...p, replace: p.replace ?? undefined }, p.chatId);
        } catch (err) {
          if (!(err instanceof MemoryError)) throw err;
          status = 'failed';
        }
      db.update(memoryPending).set({ status }).where(eq(memoryPending.id, id)).run();
      return status;
    },
    /** Accepts (with optional edited texts) or rejects a proposal; false when it is not pending. */
    resolveConsolidation(id: number, accept: boolean, edited: { user?: string; memory?: string }) {
      const c = db.select().from(memoryConsolidations).where(consolidationWhere(id)).get();
      if (!c) return false;
      if (accept) {
        if (baseHash() !== c.baseHash) throw new MemoryError(CONFLICT);
        put(
          { user: edited.user ?? c.proposedUser, memory: edited.memory ?? c.proposedMemory },
          `consolidation ${id}`,
        );
      }
      db.update(memoryConsolidations)
        .set({ status: accept ? 'accepted' : 'rejected' })
        .where(eq(memoryConsolidations.id, id))
        .run();
      return true;
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
      const hits = await search(db, userId, q, 5, pseudo, filter);
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
    /** Phase 17: a turn of the chat had untrusted input; its claims never activate at once. */
    markTainted: (chatId: string) =>
      void db.update(chats).set({ tainted: true }).where(eq(chats.id, chatId)).run(),
    close: () => task.stop(),
  };
}
