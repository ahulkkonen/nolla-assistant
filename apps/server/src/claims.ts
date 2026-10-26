import { claimEntities, claims, type Db, evidence } from '@pa/db';
import type { ClaimKind } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import { embed } from './embeddings.ts';

/**
 * Claims about the user (docs/decisions/phase-17-memory.md). Texts and quotes are real values:
 * never log them. Claims are never deleted.
 */

export type Warn = (msg: string, data?: object) => void;
export type NewClaim = {
  kind: ClaimKind;
  text: string;
  confidence: number;
  status: 'proposed' | 'active';
  activatedBy?: 'auto' | 'user' | null;
  validFrom?: string | null;
  supersedesId?: number | null;
  sourceChatId?: string | null;
  subjectEntityId?: number | null;
};
export type NewEvidence = {
  chatId: string | null;
  messageId: string | null;
  quote: string;
  stance: 'supports' | 'contradicts';
};

export const vecOf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Passage vectors, or nulls when the model cannot load (the claim then has no vector row). */
async function vectors(texts: string[], warn: Warn) {
  try {
    return await embed(texts);
  } catch (err) {
    warn('claim embedding failed', { error: err instanceof Error ? err.name : 'unknown' });
    return texts.map(() => null);
  }
}

export type ClaimStore = ReturnType<typeof claimStore>;

export function claimStore(deps: { db: Db; userId: string; warn: Warn }) {
  const { db, userId, warn } = deps;
  const sqlite = db.$client;

  /** Replaces the FTS and vector rows of a claim (call inside the write transaction). */
  const reindex = (id: number, text: string, v: Float32Array | null) => {
    sqlite.prepare('DELETE FROM claims_fts WHERE claim_id = ?').run(id);
    sqlite.prepare('DELETE FROM claims_vec WHERE claim_id = ?').run(BigInt(id));
    sqlite
      .prepare('INSERT INTO claims_fts (claim_id, user_id, text) VALUES (?, ?, ?)')
      .run(id, userId, text);
    if (v)
      sqlite
        .prepare('INSERT INTO claims_vec (claim_id, user_id, embedding) VALUES (?, ?, ?)')
        .run(BigInt(id), userId, vecOf(v));
  };

  /** Inserts claims with their evidence and entity links; returns the new ids in order. */
  const add = async (
    items: { claim: NewClaim; evidence: NewEvidence[]; entityIds?: number[] }[],
  ): Promise<number[]> => {
    if (!items.length) return [];
    const vs = await vectors(
      items.map((i) => i.claim.text),
      warn,
    );
    const now = new Date().toISOString();
    return db.transaction((tx) =>
      items.map(({ claim, evidence: ev, entityIds = [] }, i) => {
        const id = tx
          .insert(claims)
          .values({ userId, recordedAt: now, ...claim })
          .returning({ id: claims.id })
          .get().id;
        for (const e of ev)
          tx.insert(evidence)
            .values({ userId, claimId: id, createdAt: now, ...e, quote: e.quote.slice(0, 300) })
            .run();
        for (const entityId of new Set(entityIds))
          tx.insert(claimEntities).values({ claimId: id, entityId, userId }).run();
        reindex(id, claim.text, vs[i] ?? null);
        return id;
      }),
    );
  };

  /** New text for a claim: row, FTS and vector in one step. */
  const setText = async (id: number, text: string) => {
    const [v] = await vectors([text], warn);
    db.transaction((tx) => {
      tx.update(claims).set({ text }).where(eq(claims.id, id)).run();
      reindex(id, text, v ?? null);
    });
  };

  /**
   * Phase-17 decision 31: once, when there are no claims yet, every non-empty MEMORY.md line
   * becomes an active `fact` claim. Returns the number imported.
   */
  const importMemory = async (memory: string) => {
    if (db.select({ id: claims.id }).from(claims).where(eq(claims.userId, userId)).get()) return 0;
    const lines = memory
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter((l) => l.length >= 3);
    await add(
      lines.map((text) => ({
        claim: {
          kind: 'fact',
          text: text.slice(0, 240),
          confidence: 0.9,
          status: 'active',
          activatedBy: 'user',
        },
        evidence: [],
      })),
    );
    return lines.length;
  };

  return { add, setText, importMemory };
}
