import { randomUUID } from 'node:crypto';
import { chats, chunks, type Db } from '@pa/db';
import type { PseudoClient } from '@pa/pi-ext-pseudo';
import { and, desc, eq } from 'drizzle-orm';
import { embed } from './embeddings.ts';

/**
 * Search and recall index (plan §7/§8, phase-4 decisions 2–4). Every indexed text is masked; a
 * chunk row has a `chat_fts` row and a `chunk_vec` row with the same id (the `chunks_ad` trigger
 * deletes both with the chunk, so chat deletes cascade).
 */

/** ~400 tokens at ~4 chars per token. */
const CHUNK_CHARS = 1600;
const RRF_K = 60;
// ponytail: e5-small summary cosines cluster in 0.80–0.88; 0.86 keeps real neighbours. Re-check in phase 8.
export const RELATED_MIN = 0.86;
const SNIPPET_CHARS = 196;

export type IndexMessage = { id: string; text: string };
type Kind = 'title' | 'summary' | 'transcript';
type NewChunk = { kind: Kind; messageId: string | null; text: string };

const vec = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Paragraph-packed pieces of at most CHUNK_CHARS; a longer paragraph is cut hard. */
export function split(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/)) {
    for (let p = para.trim(); p; p = p.slice(CHUNK_CHARS)) {
      const piece = p.slice(0, CHUNK_CHARS);
      if (cur && cur.length + 2 + piece.length > CHUNK_CHARS) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ponytail: one chain per process, so concurrent title and settle runs never double-index a chat.
let chain: Promise<unknown> = Promise.resolve();
/** Resolves when queued index work is done (await before closing the database). */
export const indexIdle = () => chain.then(() => undefined);

/**
 * Indexes the chat's masked title and summary (replaced when changed) and, with `messages` (the
 * branch in order), the transcript messages after the last indexed one. A branch that no longer
 * holds the last indexed message is reindexed whole.
 */
export function indexChat(db: Db, userId: string, chatId: string, messages?: IndexMessage[]) {
  const run = chain.then(() => indexNow(db, userId, chatId, messages));
  chain = run.catch(() => undefined);
  return run;
}

async function indexNow(db: Db, userId: string, chatId: string, messages?: IndexMessage[]) {
  const chat = db
    .select({ titleMasked: chats.titleMasked, summary: chats.summary })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .get();
  if (!chat) return;
  const current = (kind: Kind) =>
    db
      .select({ text: chunks.text })
      .from(chunks)
      .where(and(eq(chunks.chatId, chatId), eq(chunks.kind, kind)))
      .get()?.text;
  const replace: Kind[] = [];
  const add: NewChunk[] = [];
  for (const [kind, text] of [
    ['title', chat.titleMasked],
    ['summary', chat.summary],
  ] as const)
    if (text && text !== current(kind)) {
      replace.push(kind);
      add.push({ kind, messageId: null, text });
    }

  let seq = 0;
  if (messages) {
    const last = db
      .select({ messageId: chunks.messageId, seq: chunks.seq })
      .from(chunks)
      .where(and(eq(chunks.chatId, chatId), eq(chunks.kind, 'transcript')))
      .orderBy(desc(chunks.seq))
      .get();
    const at = last ? messages.findIndex((m) => m.id === last.messageId) : -1;
    if (last && at < 0) replace.push('transcript');
    else seq = (last?.seq ?? -1) + 1;
    for (const m of messages.slice(at + 1))
      for (const text of split(m.text)) add.push({ kind: 'transcript', messageId: m.id, text });
  }
  if (!add.length && !replace.length) return;

  const vectors = await embed(add.map((c) => c.text));
  const sqlite = db.$client;
  const fts = sqlite.prepare(
    'INSERT INTO chat_fts (chat_id, message_id, user_id, kind, text, chunk_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const knn = sqlite.prepare(
    'INSERT INTO chunk_vec (chunk_id, user_id, kind, embedding) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const kind of replace)
      tx.delete(chunks)
        .where(and(eq(chunks.chatId, chatId), eq(chunks.kind, kind)))
        .run();
    add.forEach((c, i) => {
      const id = randomUUID();
      tx.insert(chunks)
        .values({
          id,
          userId,
          chatId,
          ...c,
          seq: c.kind === 'transcript' ? seq++ : 0,
          createdAt: now,
        })
        .run();
      fts.run(chatId, c.messageId, userId, c.kind, c.text, id);
      knn.run(id, userId, c.kind, vec(vectors[i] as Float32Array));
    });
  });
}

/** Reciprocal rank fusion (k = 60) of ranked lists; one entry per `key`, best score first. */
export function rrf<T>(lists: T[][], key: (x: T) => string | number) {
  const fused = new Map<string | number, { hit: T; score: number }>();
  for (const list of lists)
    list.forEach((hit, rank) => {
      const f = fused.get(key(hit)) ?? { hit, score: 0 };
      f.score += 1 / (RRF_K + rank + 1);
      fused.set(key(hit), f);
    });
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export type SearchResult = {
  chatId: string;
  messageId: string | null;
  title: string;
  snippet: string;
  score: number;
};

/** Lowercased words of 3+ chars (trigram minimum), each followed by a stem that drops a Finnish case ending. */
export function terms(q: string) {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3);
  // ponytail: crude stem (cut up to 4 trailing chars, keep ≥ 4); swap for Voikko lemmas if recall suffers.
  const stems = words.map((w) => w.slice(0, Math.max(4, w.length - 4)));
  return [...new Set([...words, ...stems])];
}

type Hit = { id: string; chatId: string; messageId: string | null; text: string };

/** ≤ 200 chars around the first term hit, the hit (to the end of its word) in `**…**`. */
function snippet(text: string, words: string[]) {
  const lower = text.toLowerCase();
  for (const w of words) {
    const at = lower.indexOf(w);
    if (at < 0) continue;
    let end = at + w.length;
    while (end < text.length && /[\p{L}\p{N}]/u.test(text[end] as string)) end++;
    const start = Math.max(0, Math.min(at - 60, end - SNIPPET_CHARS));
    const stop = Math.min(text.length, start + SNIPPET_CHARS);
    return `${text.slice(start, at)}**${text.slice(at, Math.min(end, stop))}**${text.slice(Math.min(end, stop), stop)}`;
  }
  return text.slice(0, SNIPPET_CHARS);
}

/** Best (first) hit per chat, in list order. */
const byChat = (hits: Hit[]) => {
  const m = new Map<string, Hit>();
  for (const h of hits) if (!m.has(h.chatId)) m.set(h.chatId, h);
  return [...m.values()];
};

/**
 * FTS5 trigram BM25 over masked text, topped up with vector kNN when FTS finds fewer than `limit`
 * chats; the two lists fuse with reciprocal rank fusion (k = 60). The query is masked first; the
 * snippet is restored for display only.
 */
export async function search(
  db: Db,
  userId: string,
  q: string,
  limit: number,
  pseudo?: PseudoClient,
  /** `since` (ISO datetime) on the chat's `createdAt`, `topic` on its `topicId`. */
  filter: { since?: string | undefined; topic?: string | undefined } = {},
): Promise<SearchResult[]> {
  const masked = pseudo ? (await pseudo.mask(`search:${userId}`, q)).masked : q;
  const sqlite = db.$client;
  const conds = [
    ...(filter.since ? ['h.createdAt >= ?'] : []),
    ...(filter.topic ? ['h.topicId = ?'] : []),
  ];
  // ponytail: post-filter, so kNN `k` counts filtered-out chunks too; widen k if recall misses.
  const where = (col: string) =>
    conds.length
      ? ` AND ${col} IN (SELECT c.id FROM chunks c JOIN chats h ON h.id = c.chatId WHERE ${conds.join(' AND ')})`
      : '';
  const params = [filter.since, filter.topic].filter((v) => v !== undefined);
  const maskedTerms = terms(masked);
  const fts = maskedTerms.length
    ? byChat(
        sqlite
          .prepare(
            `SELECT chunk_id AS id, chat_id AS chatId, message_id AS messageId, text FROM chat_fts
             WHERE chat_fts MATCH ? AND user_id = ?${where('chunk_id')} ORDER BY bm25(chat_fts) LIMIT ?`,
          )
          .all(
            maskedTerms.map((t) => `"${t}"`).join(' OR '),
            userId,
            ...params,
            limit * 5,
          ) as Hit[],
      )
    : [];
  const vector =
    fts.length < limit
      ? byChat(
          sqlite
            .prepare(
              `WITH knn AS (SELECT chunk_id, distance FROM chunk_vec
                 WHERE embedding MATCH ? AND k = ? AND user_id = ?)
               SELECT k.id, k.chatId, k.messageId, k.text FROM knn JOIN chunks k ON k.id = knn.chunk_id
               WHERE 1${where('k.id')} ORDER BY knn.distance`,
            )
            .all(
              vec((await embed([masked], 'query'))[0] as Float32Array),
              limit * 5,
              userId,
              ...params,
            ) as Hit[],
        )
      : [];

  const top = rrf([fts, vector], (h) => h.chatId).slice(0, limit);

  const words = terms(q);
  const out: SearchResult[] = [];
  for (const { hit, score } of top) {
    const text = pseudo ? (await pseudo.unmask(hit.text)).restored : hit.text;
    const title = db
      .select({ title: chats.title })
      .from(chats)
      .where(eq(chats.id, hit.chatId))
      .get();
    out.push({
      chatId: hit.chatId,
      messageId: hit.messageId,
      title: title?.title ?? '',
      snippet: snippet(text, words),
      score,
    });
  }
  return out;
}

export type Related = { chatId: string; title: string; score: number };

/** Top 3 unarchived chats whose summary is within cosine RELATED_MIN of this chat's summary. */
export function related(db: Db, userId: string, chatId: string): Related[] {
  const sqlite = db.$client;
  const own = sqlite
    .prepare(
      `SELECT v.embedding FROM chunks c JOIN chunk_vec v ON v.chunk_id = c.id
       WHERE c.chatId = ? AND c.userId = ? AND c.kind = 'summary'`,
    )
    .get(chatId, userId) as { embedding: Buffer } | undefined;
  if (!own) return [];
  const rows = sqlite
    .prepare(
      `WITH knn AS (SELECT chunk_id, distance FROM chunk_vec
         WHERE embedding MATCH ? AND k = 10 AND user_id = ? AND kind = 'summary')
       SELECT h.id AS chatId, coalesce(h.title, '') AS title, 1 - knn.distance AS score
       FROM knn JOIN chunks c ON c.id = knn.chunk_id JOIN chats h ON h.id = c.chatId
       WHERE h.id != ? AND h.archived = 0 ORDER BY knn.distance`,
    )
    .all(own.embedding, userId, chatId) as Related[];
  return rows.filter((r) => r.score >= RELATED_MIN).slice(0, 3);
}
