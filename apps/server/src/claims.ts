import { chats, claimEntities, claims, type Db, evidence } from '@pa/db';
import { ATTACHMENT_MARKER } from '@pa/pi-ext-memory';
import type { Json, JsonPath, PseudoClient } from '@pa/pi-ext-pseudo';
import { ClaimDay, ClaimKind } from '@pa/protocol';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import cron from 'node-cron';
import { z } from 'zod';
import { embed } from './embeddings.ts';
import { RELATED_MIN, rrf, terms } from './search.ts';
import type { taskSmall } from './topics.ts';

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

export type ChatMsg = { id: string; role: 'user' | 'assistant'; text: string };

/** Phase-17 decision 11: a chat with no new turn for this long is at its end. */
export const IDLE_MS = 20 * 60_000;
const SWEEP_MAX = 10;
const NEW_CHARS = 24_000;
const CONTEXT_CHARS = 4000;
const SIMILAR = 40;
/** `claims_vec` cosine distance under which a new claim is the same as an open one. */
const SAME_DISTANCE = 0.05;
const AUTO_KINDS = new Set<ClaimKind>(['preference', 'rhythm']);
/** Decision 26: per-turn top k, the block's line budget (~300 tokens), candidates per list. */
const TOP_K = 6;
export const BLOCK_CHARS = 1000;
const LIST = 20;
export const KIND_FI: Record<ClaimKind, string> = {
  preference: 'mieltymys',
  rhythm: 'rytmi',
  goal: 'tavoite',
  fact: 'fakta',
  relationship: 'ihmissuhde',
  decision_pattern: 'päätöstapa',
  quirk: 'tapa',
};
type ClaimRow = typeof claims.$inferSelect;
/** Half weight after a year without confirmation, never below 0.5. */
export const recency = (c: Pick<ClaimRow, 'lastConfirmedAt' | 'recordedAt'>, now = Date.now()) =>
  Math.max(
    0.5,
    0.5 ** ((now - Date.parse(c.lastConfirmedAt ?? c.recordedAt)) / (365 * 86_400_000)),
  );
const month = (c: Pick<ClaimRow, 'validFrom' | 'recordedAt'>) =>
  (c.validFrom ?? c.recordedAt).slice(0, 7);
/** One block line: `- (mieltymys, 0.9, 2026-09) text`. */
export const claimLine = (c: ClaimRow) =>
  `- (${KIND_FI[c.kind]}, ${Math.round(c.confidence * 10) / 10}, ${month(c)}) ${c.text}`;

export const EXTRACT_PROMPT = `Olet muistin poimija. Saat listan käyttäjästä jo tallennetuista havainnoista (id) ja keskustelun, jonka viestit on numeroitu (m1, m2, …). Nimet ja tunnisteet ovat peitenimiä: käytä niitä täsmälleen sellaisinaan. [sinä] tarkoittaa käyttäjää.

Poimi keskustelusta pysyviä havaintoja käyttäjästä. Vastaa pelkällä JSON-objektilla, ilman muuta tekstiä:
{"claims": [{"kind": string, "text": string, "confidence": number, "valid_from": string | null, "evidence": [{"message": string, "quote": string}]}], "confirms": [{"claim_id": number, "evidence": {"message": string, "quote": string}}], "supersedes": [{"claim_id": number, "reason": string, "valid_to": string | null, "new_claim": number, "evidence": {"message": string, "quote": string}}]}

Säännöt:
- Poimi vain se, minkä käyttäjä itse sanoo tai selvästi osoittaa Käyttäjä-viesteissä. Avustajan viestit ovat vain taustaa. Älä poimi mitään avustajan vastauksista, liitteistä tai hakutuloksista.
- claims: enintään 8 uutta havaintoa. Yksi väite yhdellä virkkeellä, enintään 200 merkkiä, muodossa "Käyttäjä …" tai "<nimi> on käyttäjän …".
- kind: preference (miten käyttäjä haluaa asioiden tapahtuvan), rhythm (milloin ja kuinka usein), goal (tavoite), fact (pysyvä tosiasia), relationship (ihminen ja suhde käyttäjään), decision_pattern (miten käyttäjä tekee päätöksiä), quirk (tapa tai erityispiirre).
- confidence: 0.9–1, kun käyttäjä sanoi asian suoraan. 0.6–0.8, kun käyttäjä osoitti sen selvästi. Älä poimi arvauksia.
- valid_from: VVVV-KK-PP tai VVVV-KK, jos keskustelusta näkyy, milloin asia alkoi. Muuten null.
- evidence: 1–3 sitaattia. Jokainen on sanatarkka ote yhdestä Käyttäjä-viestistä, enintään 300 merkkiä, ja sen viestin tunnus (esim. "m3").
- Älä toista listan havaintoa. Jos keskustelu tukee listan havaintoa, lisää se confirms-listaan.
- supersedes: jos listan havainto ei enää pidä paikkaansa, anna sen id, lyhyt syy, valid_to (VVVV-KK-PP tai null) ja new_claim: sen claims-listan havainnon indeksi (0 = ensimmäinen), joka kertoo nykytilan. Älä ehdota poistoa.
- Älä tallenna salasanoja, tunnuslukuja, tilinumeroita tai henkilötunnuksia.
- Jos poimittavaa ei ole: {"claims": [], "confirms": [], "supersedes": []}.`;

const Quote = z.object({
  message: z.string().regex(/^m\d+$/),
  quote: z.string().trim().min(1).max(300),
});
export const Extraction = z.object({
  claims: z
    .array(
      z.object({
        kind: ClaimKind,
        text: z.string().trim().min(3).max(240),
        confidence: z.number().min(0).max(1),
        valid_from: ClaimDay.nullable(),
        evidence: z.array(Quote).min(1).max(3),
      }),
    )
    .max(8),
  confirms: z.array(z.object({ claim_id: z.int(), evidence: Quote })).max(10),
  supersedes: z
    .array(
      z.object({
        claim_id: z.int(),
        reason: z.string().trim().max(200),
        valid_to: ClaimDay.nullable(),
        new_claim: z.int().min(0),
        evidence: Quote,
      }),
    )
    .max(5),
});
type Extraction = z.infer<typeof Extraction>;

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();
const norm = (t: string) => squash(t).toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
/** A user message without the inlined attachments (untrusted text). */
const own = (m: ChatMsg) =>
  m.role === 'user' && m.text.includes(ATTACHMENT_MARKER)
    ? m.text.slice(0, m.text.indexOf(ATTACHMENT_MARKER))
    : m.text;
const line = (label: string, m: ChatMsg) =>
  `[${label}] ${m.role === 'user' ? 'Käyttäjä' : 'Avustaja'}: ${own(m)}`;
const pathIs = (p: JsonPath | undefined, ...head: (string | number)[]) =>
  !!p && head.every((h, i) => p[i] === h);

export const vecOf = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Passage vectors, or nulls when the model cannot load (the claim then has no vector row). */
async function vectors(texts: string[], warn: Warn, mode: 'query' | 'passage' = 'passage') {
  try {
    return await embed(texts, mode);
  } catch (err) {
    warn('claim embedding failed', { error: err instanceof Error ? err.name : 'unknown' });
    return texts.map(() => null);
  }
}

export type ClaimStore = ReturnType<typeof claimStore>;

export function claimStore(deps: {
  db: Db;
  userId: string;
  warn: Warn;
  pseudo?: PseudoClient | undefined;
  /** `taskSmall(...)`: the extraction call. */
  ask?: ReturnType<typeof taskSmall> | undefined;
}) {
  const { db, userId, warn, pseudo } = deps;
  const sqlite = db.$client;
  /** Open = active or proposed, validity not closed. */
  const open = () =>
    and(
      eq(claims.userId, userId),
      inArray(claims.status, ['active', 'proposed']),
      or(isNull(claims.validTo), sql`${claims.validTo} > ${today()}`),
    );

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

  /** Open claims nearest to `v` by cosine distance (kNN over `claims_vec`). */
  const nearest = (v: Float32Array, k: number) =>
    sqlite
      .prepare(
        'SELECT claim_id AS id, distance FROM claims_vec WHERE embedding MATCH ? AND k = ? AND user_id = ? ORDER BY distance',
      )
      .all(vecOf(v), k, userId) as { id: number; distance: number }[];

  /** Up to SIMILAR open claims: those that name `entityIds`, then the nearest to `query`. */
  const similar = async (entityIds: number[], query: string) => {
    const ids = entityIds.length
      ? db
          .selectDistinct({ id: claimEntities.claimId })
          .from(claimEntities)
          .where(and(eq(claimEntities.userId, userId), inArray(claimEntities.entityId, entityIds)))
          .all()
          .map((r) => r.id)
      : [];
    const [v] = query ? await vectors([query], warn) : [null];
    if (v) ids.push(...nearest(v, SIMILAR * 2).map((r) => r.id));
    const rows = ids.length
      ? db
          .select({
            id: claims.id,
            kind: claims.kind,
            text: claims.text,
            valid_from: claims.validFrom,
          })
          .from(claims)
          .where(and(open(), inArray(claims.id, [...new Set(ids)])))
          .all()
      : [];
    const order = new Map([...new Set(ids)].map((id, i) => [id, i]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, SIMILAR);
  };

  /**
   * Phase-17 decisions 10 to 21: one masked `zdr/task-small` call over the messages after
   * `through` (the branch in order, masked). Writes claims, confirms and supersede proposals;
   * returns the ids of the claims activated at once (the chip).
   */
  const extract = async (
    chatId: string,
    messages: ChatMsg[],
    opts: { through: string | null; tainted: boolean; date: string },
  ): Promise<{ activated: { id: number; kind: ClaimKind; text: string }[]; written: number }> => {
    const done = { activated: [], written: 0 };
    if (!pseudo || !deps.ask) return done;
    const at = opts.through ? messages.findIndex((m) => m.id === opts.through) : -1;
    const fresh: ChatMsg[] = [];
    let size = 0;
    for (const m of messages.slice(at + 1).reverse()) {
      size += own(m).length;
      if (size > NEW_CHARS && fresh.length) break;
      fresh.unshift(m);
    }
    const last = messages.at(-1)?.id ?? null;
    const markRead = () =>
      db
        .update(chats)
        .set({ claimsThrough: last, claimsAt: new Date().toISOString() })
        .where(eq(chats.id, chatId))
        .run();
    if (!fresh.some((m) => m.role === 'user')) {
      markRead();
      return done;
    }
    const label = new Map(fresh.map((m, i) => [`m${i + 1}`, m]));
    let context = '';
    for (const m of messages.slice(0, at + 1).reverse()) {
      const l = `${line('-', m)}\n\n`;
      if (context.length + l.length > CONTEXT_CHARS) break;
      context = l + context;
    }
    const transcript = fresh.map((m, i) => line(`m${i + 1}`, m)).join('\n\n');
    // Entities and a real-text query for the similar claims; the real text stays here.
    const seen = await pseudo.unmask(transcript);
    const list = await similar(
      [...new Set(seen.spans.map((s) => s.entity_id))],
      seen.restored.slice(0, 2000),
    );
    const maskedList = list.length
      ? (await pseudo.mask(chatId, list as unknown as Json)).masked
      : [];
    const reply = await deps.ask(
      Extraction,
      [
        { role: 'system', content: EXTRACT_PROMPT },
        {
          role: 'user',
          content: `Havainnot:\n${JSON.stringify(maskedList)}\n\nPäivämäärä: ${opts.date}\n\n${
            context ? `Aiempaa (vain taustaksi):\n${context}` : ''
          }Keskustelu:\n${transcript}`,
        },
      ],
      chatId,
    );
    if (!reply) {
      warn('claims extraction reply invalid', { chatId });
      markRead();
      return done;
    }

    // Decision 16: evidence must quote a user message of the sent part, verbatim.
    const known = new Set(list.map((c) => c.id));
    const quoteOk = (q: { message: string; quote: string }) => {
      const m = label.get(q.message);
      return !!m && m.role === 'user' && squash(own(m)).includes(squash(q.quote));
    };
    const kept: Extraction = {
      claims: reply.claims.map((c) => ({ ...c, evidence: c.evidence.filter(quoteOk) })),
      confirms: reply.confirms.filter((c) => known.has(c.claim_id) && quoteOk(c.evidence)),
      supersedes: reply.supersedes.filter((s) => known.has(s.claim_id) && quoteOk(s.evidence)),
    };
    // Decision 17: one /unmask over the whole reply; `path` places spans and unresolved forms.
    const un = await pseudo.unmask(kept as unknown as Json);
    const real = un.restored as unknown as Extraction;
    const bad = (head: (string | number)[]) => un.unresolved.some((u) => pathIs(u.path, ...head));
    const okClaim = kept.claims.map(
      (c, i) => c.confidence >= 0.6 && c.evidence.length > 0 && !bad(['claims', i]),
    );
    const dropped = okClaim.filter((ok) => !ok).length;
    const evidenceOf = (
      q: { message: string; quote: string },
      stance: 'supports' | 'contradicts',
    ) => ({
      chatId,
      messageId: label.get(q.message)?.id ?? null,
      quote: q.quote,
      stance,
    });

    // Decision 19: a claim equal to an open one is a confirm of it.
    const newIdx = real.claims.flatMap((_, i) => (okClaim[i] ? [i] : []));
    const vs = await vectors(
      newIdx.map((i) => real.claims[i]?.text ?? ''),
      warn,
    );
    const openTexts = new Map(
      db
        .select({ id: claims.id, text: claims.text })
        .from(claims)
        .where(open())
        .all()
        .map((r) => [norm(r.text), r.id]),
    );
    const sameAs = new Map<number, number>();
    newIdx.forEach((i, k) => {
      const c = real.claims[i];
      if (!c) return;
      const v = vs[k];
      const near = v ? nearest(v, 1)[0] : undefined;
      const same =
        openTexts.get(norm(c.text)) ??
        (near && near.distance <= SAME_DISTANCE && openRowIds().has(near.id) ? near.id : undefined);
      if (same !== undefined) sameAs.set(i, same);
    });
    const supersedeOf = new Map(
      real.supersedes
        .map((s, k) => ({ s, k }))
        .filter(
          ({ s, k }) => !bad(['supersedes', k]) && okClaim[s.new_claim] && !sameAs.has(s.new_claim),
        )
        .map(({ s }) => [s.new_claim, s]),
    );
    const items = newIdx
      .filter((i) => !sameAs.has(i))
      .map((i) => {
        const c = real.claims[i] as Extraction['claims'][number];
        const sup = supersedeOf.get(i);
        const auto = !sup && !opts.tainted && AUTO_KINDS.has(c.kind) && c.confidence >= 0.8;
        const ids = un.spans
          .filter((s) => pathIs(s.path, 'claims', i, 'text'))
          .map((s) => s.entity_id);
        return {
          claim: {
            kind: c.kind,
            text: c.text,
            confidence: c.confidence,
            status: auto ? ('active' as const) : ('proposed' as const),
            activatedBy: auto ? ('auto' as const) : null,
            validFrom: c.valid_from,
            supersedesId: sup?.claim_id ?? null,
            sourceChatId: chatId,
            subjectEntityId: /^käyttäjä/i.test(c.text) ? null : (ids[0] ?? null),
          },
          evidence: c.evidence.map((q) => evidenceOf(q, 'supports')),
          entityIds: ids,
        };
      });
    const added = await add(items);
    const now = new Date().toISOString();
    const confirms = [
      ...real.confirms
        .filter((_, k) => !bad(['confirms', k]))
        .map((c) => ({ id: c.claim_id, q: c.evidence })),
      ...[...sameAs].map(([i, id]) => ({ id, q: real.claims[i]?.evidence[0] })),
    ];
    db.transaction((tx) => {
      for (const { id, q } of confirms) {
        tx.update(claims)
          .set({ timesSeen: sql`${claims.timesSeen} + 1`, lastConfirmedAt: now })
          .where(eq(claims.id, id))
          .run();
        if (q)
          tx.insert(evidence)
            .values({ userId, claimId: id, createdAt: now, ...evidenceOf(q, 'supports') })
            .run();
      }
      for (const s of supersedeOf.values())
        tx.insert(evidence)
          .values({
            userId,
            claimId: s.claim_id,
            createdAt: now,
            ...evidenceOf(s.evidence, 'contradicts'),
          })
          .run();
    });
    markRead();
    return {
      written: added.length,
      activated: added.flatMap((id, k) => {
        const c = items[k]?.claim;
        return c?.status === 'active' ? [{ id, kind: c.kind, text: c.text }] : [];
      }),
    };
  };
  const openRowIds = () =>
    new Set(
      db
        .select({ id: claims.id })
        .from(claims)
        .where(open())
        .all()
        .map((r) => r.id),
    );

  /** Claim ids with evidence from at least two chats. */
  const twoChats = (ids: number[]) =>
    new Set(
      ids.length
        ? (
            sqlite
              .prepare(
                `SELECT claimId FROM evidence WHERE claimId IN (${ids.map(() => '?').join(',')})
                 GROUP BY claimId HAVING count(DISTINCT chatId) >= 2`,
              )
              .all(...ids) as { claimId: number }[]
          ).map((r) => r.claimId)
        : [],
    );

  /**
   * Decision 26: FTS (trigram + crude stem), vector and entity lists over `statuses`, fused with
   * RRF and weighted by confidence and recency. A claim needs an FTS or entity hit, or a vector
   * cosine ≥ RELATED_MIN. `q` is real text.
   */
  const rank = async (
    q: string,
    entityIds: number[],
    statuses: ClaimRow['status'][],
    now = Date.now(),
  ): Promise<ClaimRow[]> => {
    const words = terms(q);
    const fts = words.length
      ? (
          sqlite
            .prepare(
              'SELECT claim_id AS id FROM claims_fts WHERE claims_fts MATCH ? AND user_id = ? ORDER BY bm25(claims_fts) LIMIT ?',
            )
            .all(words.map((t) => `"${t}"`).join(' OR '), userId, LIST * 3) as { id: number }[]
        ).map((r) => r.id)
      : [];
    const [v] = q.trim() ? await vectors([q], warn, 'query') : [null];
    const near = v ? nearest(v, LIST * 3) : [];
    const ent = entityIds.length
      ? db
          .selectDistinct({ id: claimEntities.claimId })
          .from(claimEntities)
          .where(and(eq(claimEntities.userId, userId), inArray(claimEntities.entityId, entityIds)))
          .all()
          .map((r) => r.id)
      : [];
    const all = [...new Set([...fts, ...near.map((r) => r.id), ...ent])];
    if (!all.length) return [];
    const day = new Date(now).toISOString().slice(0, 10);
    const rows = new Map(
      db
        .select()
        .from(claims)
        .where(
          and(eq(claims.userId, userId), inArray(claims.status, statuses), inArray(claims.id, all)),
        )
        .all()
        // Superseded claims keep their closed validity (recall shows them); others must be open.
        .filter((c) => c.status === 'superseded' || !c.validTo || c.validTo > day)
        .map((c) => [c.id, c]),
    );
    const patterns = twoChats(
      [...rows.values()].filter((c) => c.kind === 'decision_pattern').map((c) => c.id),
    );
    const ftsSet = new Set(fts);
    const entSet = new Set(ent);
    const cos = new Map(near.map((r) => [r.id, 1 - r.distance]));
    const ok = (id: number) => {
      const c = rows.get(id);
      if (!c) return false;
      if (c.kind === 'decision_pattern' && (c.confidence < 0.6 || !patterns.has(id))) return false;
      return ftsSet.has(id) || entSet.has(id) || (cos.get(id) ?? 0) >= RELATED_MIN;
    };
    return rrf([fts.filter(ok), near.map((r) => r.id).filter(ok), ent.filter(ok)], (id) => id)
      .map(({ hit, score }) => {
        const c = rows.get(hit) as ClaimRow;
        return { c, score: score * (0.6 + 0.4 * c.confidence) * recency(c, now) };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  };

  /**
   * Decision 26: the per-turn block. Unmasks the prompt, ranks open active claims that are not in
   * MEMORY.md and not in `exclude`, keeps TOP_K lines within BLOCK_CHARS. Lines are real text.
   */
  const relevant = async (maskedPrompt: string, exclude: Iterable<number>) => {
    if (!pseudo) return { ids: [], lines: [] };
    const skip = new Set(exclude);
    const un = await pseudo.unmask(maskedPrompt);
    const ranked = (
      await rank(un.restored, [...new Set(un.spans.map((s) => s.entity_id))], ['active'])
    )
      .filter((c) => !c.inProfile && !skip.has(c.id))
      .slice(0, TOP_K);
    const ids: number[] = [];
    const lines: string[] = [];
    let size = 0;
    for (const c of ranked) {
      const l = claimLine(c);
      if (size + l.length > BLOCK_CHARS) break;
      size += l.length + 1;
      ids.push(c.id);
      lines.push(l);
    }
    return { ids, lines };
  };

  /** Decision 27: `recall` lines for active and superseded claims, each with its newest quote. */
  const recallLines = async (q: string): Promise<string[]> => {
    const entityIds = pseudo
      ? (await pseudo.mask(`search:${userId}`, q)).spans.map((s) => s.entity_id)
      : [];
    const top = (await rank(q, [...new Set(entityIds)], ['active', 'superseded'])).slice(0, 3);
    return top.map((c) => {
      const e = db
        .select()
        .from(evidence)
        .where(eq(evidence.claimId, c.id))
        .orderBy(sql`${evidence.id} DESC`)
        .get();
      const span = `${month(c)} → ${c.validTo?.slice(0, 7) ?? ''}${c.status === 'superseded' ? ', korvattu' : ''}`;
      return `- [${span}] ${c.text}${e ? ` Lainaus: "${e.quote}" (${e.chatId ?? '-'})` : ''}`;
    });
  };

  /**
   * Decision 11: extracts the chats idle for IDLE_MS with turns after the last extraction, at
   * most SWEEP_MAX per run, one at a time. `messagesOf` gives the branch, or undefined when the
   * chat is busy.
   */
  const sweep = async (
    messagesOf: (chatId: string) => Promise<ChatMsg[] | undefined>,
    onActivated: (
      chatId: string,
      activated: { id: number; kind: ClaimKind; text: string }[],
    ) => void,
    now = Date.now(),
  ) => {
    const due = db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.userId, userId),
          eq(chats.fromAutomation, false),
          lt(chats.updatedAt, new Date(now - IDLE_MS).toISOString()),
          or(isNull(chats.claimsAt), lt(chats.claimsAt, chats.updatedAt)),
        ),
      )
      .limit(SWEEP_MAX)
      .all();
    for (const chat of due) {
      const messages = await messagesOf(chat.id);
      if (!messages) continue;
      const r = await extract(chat.id, messages, {
        through: chat.claimsThrough,
        tainted: chat.tainted,
        date: chat.updatedAt.slice(0, 10),
      });
      if (r.activated.length) onActivated(chat.id, r.activated);
    }
  };

  /** Every 5 minutes (decision 11). */
  const schedule = (run: () => Promise<void>) =>
    cron.schedule('*/5 * * * *', run, { timezone: 'Europe/Helsinki', noOverlap: true });

  return {
    add,
    setText,
    importMemory,
    extract,
    sweep,
    schedule,
    open,
    rank,
    relevant,
    recallLines,
  };
}
