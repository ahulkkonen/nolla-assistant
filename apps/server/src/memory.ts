import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chats, type Db, memoryConsolidations, memoryPending } from '@pa/db';
import {
  applyOp,
  CAPS,
  FILES,
  FULL,
  type MemoryWrite,
  type Snippet,
  type Target,
} from '@pa/pi-ext-memory';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import type { ServerMessage } from '@pa/protocol';
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import cron from 'node-cron';
import { z } from 'zod';
import { search } from './search.ts';
import { taskSmall } from './topics.ts';

/** A write that cannot apply; `message` is `FULL` for an over-cap write. */
export class MemoryError extends Error {}

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
}) {
  const { db, userId, pseudo, warn } = deps;
  const dir = resolve(deps.dataDir, 'memory', userId);
  mkdirSync(dir, { recursive: true });
  const path = (t: Target) => join(dir, FILES[t]);
  for (const t of ['user', 'memory'] as const) if (!existsSync(path(t))) writeFileSync(path(t), '');
  const read = (t: Target) => readFileSync(path(t), 'utf8');

  let git = true;
  const commit = (note: string) => {
    if (!git) return;
    const run = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=pa', '-c', 'user.email=pa@local', ...args], {
        cwd: dir,
        stdio: 'ignore',
      });
    try {
      if (!existsSync(join(dir, '.git'))) run('init', '-q');
      run('add', '-A');
      run('commit', '-qm', note);
    } catch (err) {
      // Exit status 1 is "nothing to commit"; ENOENT means no git binary.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      git = false;
      warn('git not on PATH: memory files are not versioned');
    }
  };
  const put = (t: Target, text: string, note: string) => {
    if (text.length > CAPS[t]) throw new MemoryError(FULL);
    writeFileSync(path(t), text);
    commit(note);
  };

  const applyWrite = (w: MemoryWrite, chatId: string) => {
    const r = applyOp(read(w.target), w);
    if ('error' in r) throw new MemoryError(r.error);
    put(w.target, r.text, `memory ${w.action} ${w.target} (chat ${chatId})`);
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
        chatId: memoryPending.chatId,
      })
      .from(memoryPending)
      .where(pendingWhere())
      .all(),
    consolidation:
      db
        .select({ id: memoryConsolidations.id, diff: memoryConsolidations.diff })
        .from(memoryConsolidations)
        .where(consolidationWhere())
        .orderBy(desc(memoryConsolidations.id))
        .get() ?? null,
  });

  const ask = taskSmall(deps.litellmUrl, deps.litellmMasterKey);
  const consolidate = async () => {
    const user = read('user');
    const memory = read('memory');
    const mask = async (t: string) =>
      pseudo && t ? (await pseudo.mask(`memory:${userId}`, t)).masked : t;
    const unmask = async (t: string) => (pseudo && t ? (await pseudo.unmask(t)).restored : t);
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
    edit: (t: Target, text: string) => put(t, text, `edit ${t}`),
    park: (chatId: string, w: MemoryWrite) =>
      db
        .insert(memoryPending)
        .values({
          userId,
          chatId,
          action: w.action,
          target: w.target,
          text: w.text,
          replace: w.replace ?? null,
          createdAt: new Date().toISOString(),
        })
        .returning({ id: memoryPending.id })
        .get().id,
    /** Applies or rejects a pending write; false when it is not pending. */
    approve(id: number, ok: boolean): boolean {
      const p = db.select().from(memoryPending).where(pendingWhere(id)).get();
      if (!p) return false;
      if (ok) applyWrite({ ...p, replace: p.replace ?? undefined }, p.chatId);
      db.update(memoryPending)
        .set({ status: ok ? 'applied' : 'rejected' })
        .where(eq(memoryPending.id, id))
        .run();
      return true;
    },
    /** Accepts (with optional edited texts) or rejects a proposal; false when it is not pending. */
    resolveConsolidation(id: number, accept: boolean, edited: { user?: string; memory?: string }) {
      const c = db.select().from(memoryConsolidations).where(consolidationWhere(id)).get();
      if (!c) return false;
      if (accept) {
        const user = edited.user ?? c.proposedUser;
        const memory = edited.memory ?? c.proposedMemory;
        if (user.length > CAPS.user || memory.length > CAPS.memory) throw new MemoryError(FULL);
        writeFileSync(path('user'), user);
        writeFileSync(path('memory'), memory);
        commit(`consolidation ${id}`);
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
    close: () => task.stop(),
  };
}
