import { chats, claimEntities, claims, type Db, evidence } from '@pa/db';
import { ATTACHMENT_MARKER, NOT_FOUND } from '@pa/pi-ext-memory';
import type { Json, JsonPath, PseudoClient } from '@pa/pi-ext-pseudo';
import { type Claim, ClaimDay, ClaimKind, type ServerMessage } from '@pa/protocol';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
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
export type Result = 'ok' | 'not_found' | 'invalid';

export type ChatMsg = { id: string; role: 'user' | 'assistant'; text: string };

/** Phase-17 decision 11: a chat with no new turn for this long is at its end. */
export const IDLE_MS = 20 * 60_000;
const SWEEP_MAX = 10;
/** A failed chat waits this long before the sweep tries it again. */
const RETRY_MS = 30 * 60_000;
const NEW_CHARS = 24_000;
/** Windows of NEW_CHARS per chat per run; older ones are skipped (logged). */
const MAX_WINDOWS = 10;
const QUERY_CHARS = 2000;
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
/** MEMORY.md sections in output order (decision 28). */
const SECTIONS: [ClaimKind, string][] = [
  ['preference', 'Mieltymykset'],
  ['rhythm', 'Rytmi'],
  ['goal', 'Tavoitteet'],
  ['fact', 'Faktat'],
  ['relationship', 'Ihmiset'],
  ['decision_pattern', 'Päätöstavat'],
  ['quirk', 'Tavat'],
];
const STALE_DAYS = 90;
const CHECK_DAYS = 30;
const CHIP_DAYS = 7;
const DAY_MS = 86_400_000;
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
const NewItem = z.object({
  kind: ClaimKind,
  text: z.string().trim().min(3).max(240),
  confidence: z.number().min(0).max(1),
  valid_from: ClaimDay.nullable(),
  evidence: z.array(Quote).min(1).max(3),
});
const ConfirmItem = z.object({ claim_id: z.int(), evidence: Quote });
const SupersedeItem = z.object({
  claim_id: z.int(),
  reason: z.string().trim().max(200),
  valid_to: ClaimDay.nullable(),
  new_claim: z.int().min(0),
  evidence: Quote,
});
/**
 * The reply envelope: only a reply that is not a JSON object of arrays fails here (and gets the
 * repair retry). Items are checked one by one in `items`, so one bad item drops only itself.
 */
export const Extraction = z.object({
  claims: z.array(z.unknown()).default([]),
  confirms: z.array(z.unknown()).default([]),
  supersedes: z.array(z.unknown()).default([]),
});
type Parsed = {
  claims: z.infer<typeof NewItem>[];
  confirms: z.infer<typeof ConfirmItem>[];
  supersedes: z.infer<typeof SupersedeItem>[];
};
const items = <T>(schema: z.ZodType<T>, xs: unknown[], max: number) =>
  xs
    .flatMap((x) => {
      const r = schema.safeParse(x);
      return r.success ? [r.data] : [];
    })
    .slice(0, max);

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();
const norm = (t: string) => squash(t).toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
/** Text without the inlined attachments (untrusted text). */
const cut = (t: string) =>
  t.includes(ATTACHMENT_MARKER) ? t.slice(0, t.indexOf(ATTACHMENT_MARKER)) : t;
const own = (m: ChatMsg) => (m.role === 'user' ? cut(m.text) : m.text);
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Item = { claim: NewClaim; evidence: NewEvidence[]; entityIds?: number[] };
/** A supersede proposal row: `claimId` is closed when `supersededBy` is accepted. */
type Supersede = { claimId: number; reason: string; validTo: string | null; quote: NewEvidence };
type Activated = { id: number; kind: ClaimKind; text: string };

export type ClaimStore = ReturnType<typeof claimStore>;

export function claimStore(deps: {
  db: Db;
  userId: string;
  warn: Warn;
  pseudo?: PseudoClient | undefined;
  /** `taskSmall(...)`: the extraction call. */
  ask?: ReturnType<typeof taskSmall> | undefined;
  /** Decision 28 amended: MEMORY.md is regenerated after every review change. */
  onProfileChange?: (() => void | Promise<void>) | undefined;
}) {
  const { db, userId, warn, pseudo } = deps;
  const sqlite = db.$client;
  const now = () => new Date().toISOString();
  const changed = () =>
    Promise.resolve(deps.onProfileChange?.()).catch((err: unknown) =>
      warn('memory regenerate failed', { error: err instanceof Error ? err.message : 'unknown' }),
    );
  /** Open = active or proposed, validity not closed. */
  const open = () =>
    and(
      eq(claims.userId, userId),
      inArray(claims.status, ['active', 'proposed']),
      or(isNull(claims.validTo), sql`${claims.validTo} > ${today()}`),
    );
  const row = (id: number) =>
    db
      .select()
      .from(claims)
      .where(and(eq(claims.id, id), eq(claims.userId, userId)))
      .get();

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

  /** Inserts claims inside `tx` with precomputed vectors; returns the new ids in order. */
  const insert = (tx: Tx, list: Item[], vs: (Float32Array | null)[]) => {
    const at = now();
    return list.map(({ claim, evidence: ev, entityIds = [] }, i) => {
      const id = tx
        .insert(claims)
        .values({ userId, recordedAt: at, ...claim })
        .returning({ id: claims.id })
        .get().id;
      for (const e of ev)
        tx.insert(evidence)
          .values({ userId, claimId: id, createdAt: at, ...e, quote: e.quote.slice(0, 300) })
          .run();
      for (const entityId of new Set(entityIds))
        tx.insert(claimEntities).values({ claimId: id, entityId, userId }).run();
      reindex(id, claim.text, vs[i] ?? null);
      return id;
    });
  };

  /** Inserts claims with their evidence and entity links; returns the new ids in order. */
  const add = async (list: Item[]): Promise<number[]> => {
    if (!list.length) return [];
    const vs = await vectors(
      list.map((i) => i.claim.text),
      warn,
    );
    return db.transaction((tx) => insert(tx, list, vs));
  };

  /**
   * Nearest claims by cosine distance, every status. Over-fetches the whole user's index (one
   * user: a few thousand rows at most), so closed claims never crowd open ones out of `k`.
   */
  // ponytail: brute-force kNN over all of the user's claims; add a status metadata column to
  // claims_vec if the table grows past ~50k rows.
  const nearest = (v: Float32Array, statuses?: ClaimRow['status'][], k = LIST * 3) => {
    const all = sqlite
      .prepare(
        `SELECT v.claim_id AS id, v.distance AS distance, c.status AS status FROM claims_vec v
         JOIN claims c ON c.id = v.claim_id
         WHERE v.embedding MATCH ? AND v.k = ? AND v.user_id = ? ORDER BY v.distance`,
      )
      .all(vecOf(v), indexSize(), userId) as {
      id: number;
      distance: number;
      status: ClaimRow['status'];
    }[];
    return (statuses ? all.filter((r) => statuses.includes(r.status)) : all).slice(0, k);
  };
  const indexSize = () =>
    Math.min(
      4096,
      Math.max(
        1,
        (
          sqlite.prepare('SELECT count(*) AS n FROM claims_vec WHERE user_id = ?').get(userId) as {
            n: number;
          }
        ).n,
      ),
    );

  /**
   * Decision 19, amended: the claim this text repeats, over every status (normalised text, then a
   * vector within SAME_DISTANCE). An open match is confirmed; a rejected or superseded match
   * means the text is skipped.
   */
  const duplicateOf = (text: string, v: Float32Array | null) => {
    const exact = db
      .select({ id: claims.id, status: claims.status, validTo: claims.validTo, text: claims.text })
      .from(claims)
      .where(eq(claims.userId, userId))
      .all()
      .find((c) => norm(c.text) === norm(text));
    const hit =
      exact ??
      (() => {
        const n = v ? nearest(v, undefined, 1)[0] : undefined;
        return n && n.distance <= SAME_DISTANCE ? row(n.id) : undefined;
      })();
    if (!hit) return undefined;
    const isOpen =
      (hit.status === 'active' || hit.status === 'proposed') &&
      (!hit.validTo || hit.validTo > today());
    return { id: hit.id, open: isOpen };
  };

  /** New text for a claim inside `tx`: row, FTS and vector. */
  const setTextTx = (tx: Tx, id: number, text: string, v: Float32Array | null) => {
    tx.update(claims).set({ text }).where(eq(claims.id, id)).run();
    reindex(id, text, v);
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
    if (lines.length) await changed();
    return lines.length;
  };

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
    if (v) ids.push(...nearest(v, ['active', 'proposed'], SIMILAR * 2).map((r) => r.id));
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
   * One extraction call over `fresh` (with `context` before it). Returns the claims to write,
   * the confirms and the supersede proposals; writes nothing.
   */
  const window = async (chatId: string, fresh: ChatMsg[], context: string, date: string) => {
    if (!pseudo || !deps.ask) return undefined;
    const label = new Map(fresh.map((m, i) => [`m${i + 1}`, m]));
    const transcript = fresh.map((m, i) => line(`m${i + 1}`, m)).join('\n\n');
    // Entities and a real-text query for the similar claims; the real text stays here.
    const seen = await pseudo.unmask(transcript);
    const list = await similar(
      [...new Set(seen.spans.map((s) => s.entity_id))],
      seen.restored.slice(0, QUERY_CHARS),
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
          content: `Havainnot:\n${JSON.stringify(maskedList)}\n\nPäivämäärä: ${date}\n\n${
            context ? `Aiempaa (vain taustaksi):\n${context}` : ''
          }Keskustelu:\n${transcript}`,
        },
      ],
      chatId,
    );
    if (!reply) {
      warn('claims extraction reply invalid', { chatId });
      return undefined;
    }

    // Decision 16: evidence must quote a user message of the sent part, verbatim.
    const known = new Set(list.map((c) => c.id));
    const quoteOk = (q: { message: string; quote: string }) => {
      const m = label.get(q.message);
      return !!m && m.role === 'user' && squash(own(m)).includes(squash(q.quote));
    };
    const kept: Parsed = {
      claims: items(NewItem, reply.claims, 8).map((c) => ({
        ...c,
        evidence: c.evidence.filter(quoteOk),
      })),
      confirms: items(ConfirmItem, reply.confirms, 10).filter(
        (c) => known.has(c.claim_id) && quoteOk(c.evidence),
      ),
      supersedes: items(SupersedeItem, reply.supersedes, 5).filter(
        (s) => known.has(s.claim_id) && quoteOk(s.evidence),
      ),
    };
    // Decision 17: one /unmask over the whole reply; `path` places spans and unresolved forms.
    const un = await pseudo.unmask(kept as unknown as Json);
    // An unresolved form we cannot place: nothing of this reply is trusted.
    if (un.unresolved.some((u) => !u.path)) {
      warn('claims reply dropped: unresolved surrogate without path', { chatId });
      return { items: [], confirms: [], supersedes: new Map<number, Supersede[]>() };
    }
    const real = un.restored as unknown as Parsed;
    const bad = (head: (string | number)[]) => un.unresolved.some((u) => pathIs(u.path, ...head));
    const okClaim = kept.claims.map(
      (c, i) => c.confidence >= 0.6 && c.evidence.length > 0 && !bad(['claims', i]),
    );
    const evidenceOf = (
      q: { message: string; quote: string },
      stance: 'supports' | 'contradicts',
    ): NewEvidence => ({
      chatId,
      messageId: label.get(q.message)?.id ?? null,
      quote: q.quote,
      stance,
    });

    const newIdx = real.claims.flatMap((_, i) => (okClaim[i] ? [i] : []));
    const vs = await vectors(
      newIdx.map((i) => real.claims[i]?.text ?? ''),
      warn,
    );
    const confirms: { id: number; q: NewEvidence | undefined }[] = real.confirms
      .filter((_, k) => !bad(['confirms', k]))
      .map((c) => ({ id: c.claim_id, q: evidenceOf(c.evidence, 'supports') }));
    const fresh2: number[] = [];
    newIdx.forEach((i, k) => {
      const c = real.claims[i];
      if (!c) return;
      const dup = duplicateOf(c.text, vs[k] ?? null);
      if (!dup) fresh2.push(i);
      else if (dup.open)
        confirms.push({ id: dup.id, q: c.evidence[0] && evidenceOf(c.evidence[0], 'supports') });
      // A rejected or superseded match: the user already said no; nothing is written.
    });
    // Decision 7 (review): several supersedes per new claim, each with its reason and valid_to.
    const supersedes = new Map<number, Supersede[]>();
    real.supersedes.forEach((s, k) => {
      if (bad(['supersedes', k]) || !fresh2.includes(s.new_claim)) return;
      const list = supersedes.get(s.new_claim) ?? [];
      if (!list.some((x) => x.claimId === s.claim_id))
        list.push({
          claimId: s.claim_id,
          reason: s.reason,
          validTo: s.valid_to,
          quote: evidenceOf(s.evidence, 'contradicts'),
        });
      supersedes.set(s.new_claim, list);
    });
    const out = fresh2.map((i) => {
      const c = real.claims[i] as Parsed['claims'][number];
      const ids = un.spans
        .filter((s) => pathIs(s.path, 'claims', i, 'text'))
        .map((s) => s.entity_id);
      return {
        index: i,
        v: vs[newIdx.indexOf(i)] ?? null,
        item: {
          claim: {
            kind: c.kind,
            text: c.text,
            confidence: c.confidence,
            validFrom: c.valid_from,
            sourceChatId: chatId,
            subjectEntityId: /^käyttäjä/i.test(c.text) ? null : (ids[0] ?? null),
          },
          evidence: c.evidence.map((q) => evidenceOf(q, 'supports')),
          entityIds: ids,
        },
      };
    });
    return { items: out, confirms, supersedes };
  };

  /**
   * Phase-17 decisions 10 to 21: masked `zdr/task-small` calls over the messages after `through`
   * (the branch in order, masked), in windows of NEW_CHARS from the tail back to `through`. Each
   * window writes its claims, confirms, supersede proposals and the read marker in one
   * transaction. Returns the claims activated at once (the chip).
   */
  const extract = async (
    chatId: string,
    messages: ChatMsg[],
    opts: { through: string | null; tainted: boolean; date: string; seenAt?: string },
  ): Promise<{ activated: Activated[]; written: number }> => {
    const done: { activated: Activated[]; written: number } = { activated: [], written: 0 };
    if (!pseudo || !deps.ask) return done;
    const seenAt = opts.seenAt ?? now();
    const markRead = (tx: Tx | Db, through: string | null) =>
      tx
        .update(chats)
        .set({ claimsThrough: through, claimsAt: seenAt, claimsRetryAt: null })
        .where(eq(chats.id, chatId))
        .run();
    const last = messages.at(-1)?.id ?? null;
    let at = opts.through ? messages.findIndex((m) => m.id === opts.through) : -1;
    if (opts.through && at < 0) {
      // The branch changed (an edit or a retry): the old marker is gone, so read up to the end.
      warn('claims marker not on branch: marked read', { chatId });
      markRead(db, last);
      return done;
    }
    // Windows of NEW_CHARS from the tail back to the marker; the oldest ones past MAX_WINDOWS go.
    const windows: ChatMsg[][] = [];
    let cur: ChatMsg[] = [];
    let size = 0;
    for (const m of messages.slice(at + 1).reverse()) {
      if (size + own(m).length > NEW_CHARS && cur.length) {
        windows.unshift(cur);
        cur = [];
        size = 0;
      }
      cur.unshift(m);
      size += own(m).length;
    }
    if (cur.length) windows.unshift(cur);
    if (windows.length > MAX_WINDOWS)
      warn('claims windows skipped', { chatId, skipped: windows.length - MAX_WINDOWS });
    const todo = windows.slice(-MAX_WINDOWS);
    if (!todo.some((w) => w.some((m) => m.role === 'user'))) {
      markRead(db, last);
      return done;
    }
    at = messages.indexOf(todo[0]?.[0] as ChatMsg) - 1;
    for (const fresh of todo) {
      let context = '';
      for (const m of messages.slice(0, at + 1).reverse()) {
        const l = `${line('-', m)}\n\n`;
        if (context.length + l.length > CONTEXT_CHARS) break;
        context = l + context;
      }
      at += fresh.length;
      const through = fresh.at(-1)?.id ?? last;
      const r = fresh.some((m) => m.role === 'user')
        ? await window(chatId, fresh, context, opts.date)
        : { items: [], confirms: [], supersedes: new Map<number, Supersede[]>() };
      if (!r) throw new Error('extraction reply invalid');
      const list = r.items.map(({ index, item }) => {
        const sup = r.supersedes.get(index) ?? [];
        const auto =
          !sup.length &&
          !opts.tainted &&
          AUTO_KINDS.has(item.claim.kind) &&
          item.claim.confidence >= 0.8;
        return {
          ...item,
          claim: {
            ...item.claim,
            status: auto ? ('active' as const) : ('proposed' as const),
            activatedBy: auto ? ('auto' as const) : null,
            supersedesId: sup[0]?.claimId ?? null,
          },
        };
      });
      const at2 = now();
      const added = db.transaction((tx) => {
        const ids = insert(
          tx,
          list,
          r.items.map((x) => x.v),
        );
        for (const { id, q } of r.confirms) {
          tx.update(claims)
            .set({ timesSeen: sql`${claims.timesSeen} + 1`, lastConfirmedAt: at2 })
            .where(eq(claims.id, id))
            .run();
          if (q)
            tx.insert(evidence)
              .values({ userId, claimId: id, createdAt: at2, ...q })
              .run();
        }
        r.items.forEach(({ index }, k) => {
          for (const s of r.supersedes.get(index) ?? [])
            tx.insert(evidence)
              .values({
                userId,
                claimId: s.claimId,
                createdAt: at2,
                ...s.quote,
                supersededBy: ids[k],
                reason: s.reason,
                validTo: s.validTo,
              })
              .run();
        });
        markRead(tx, through);
        return ids;
      });
      done.written += added.length;
      added.forEach((id, k) => {
        const c = list[k]?.claim;
        if (c?.status === 'active') done.activated.push({ id, kind: c.kind, text: c.text });
      });
    }
    return done;
  };

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
   * cosine ≥ RELATED_MIN. `q` is real text. Every list filters by status before its cut.
   */
  const rank = async (
    q: string,
    entityIds: number[],
    statuses: ClaimRow['status'][],
    at = Date.now(),
  ): Promise<ClaimRow[]> => {
    const words = terms(q);
    const marks = statuses.map(() => '?').join(',');
    const fts = words.length
      ? (
          sqlite
            .prepare(
              `SELECT f.claim_id AS id FROM claims_fts f JOIN claims c ON c.id = f.claim_id
               WHERE claims_fts MATCH ? AND f.user_id = ? AND c.status IN (${marks})
               ORDER BY bm25(claims_fts) LIMIT ?`,
            )
            .all(words.map((t) => `"${t}"`).join(' OR '), userId, ...statuses, LIST) as {
            id: number;
          }[]
        ).map((r) => r.id)
      : [];
    const [v] = q.trim() ? await vectors([q], warn, 'query') : [null];
    const near = v ? nearest(v, statuses, LIST) : [];
    const ent = entityIds.length
      ? db
          .selectDistinct({ id: claimEntities.claimId })
          .from(claimEntities)
          .innerJoin(claims, eq(claims.id, claimEntities.claimId))
          .where(
            and(
              eq(claimEntities.userId, userId),
              inArray(claimEntities.entityId, entityIds),
              inArray(claims.status, statuses),
            ),
          )
          .orderBy(desc(claimEntities.claimId))
          .limit(LIST)
          .all()
          .map((r) => r.id)
      : [];
    const all = [...new Set([...fts, ...near.map((r) => r.id), ...ent])];
    if (!all.length) return [];
    const day = new Date(at).toISOString().slice(0, 10);
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
        return { c, score: score * (0.6 + 0.4 * c.confidence) * recency(c, at) };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.c);
  };

  /**
   * Decision 26: the per-turn block. Unmasks the prompt (without attachments, at most
   * QUERY_CHARS), ranks open active claims that are not in MEMORY.md and not in `exclude`, keeps
   * TOP_K lines within BLOCK_CHARS. Lines are real text.
   */
  const relevant = async (maskedPrompt: string, exclude: Iterable<number>) => {
    if (!pseudo) return { ids: [], lines: [] };
    const skip = new Set(exclude);
    const un = await pseudo.unmask(cut(maskedPrompt).slice(0, QUERY_CHARS));
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

  /** Decision 27: the claims `recall` shows for a real query: top 3 active or superseded. */
  const recallRanked = async (q: string) => {
    const entityIds = pseudo
      ? (await pseudo.mask(`search:${userId}`, q)).spans.map((s) => s.entity_id)
      : [];
    return (await rank(q, [...new Set(entityIds)], ['active', 'superseded'])).slice(0, 3);
  };
  /** `recall` lines: the newest supporting quote first, a contradicting one labelled. */
  const recallLines = async (q: string): Promise<string[]> =>
    (await recallRanked(q)).map((c) => {
      const ev = db
        .select()
        .from(evidence)
        .where(eq(evidence.claimId, c.id))
        .orderBy(desc(evidence.id))
        .all();
      const pro = ev.find((e) => e.stance === 'supports');
      const con = ev.find((e) => e.stance === 'contradicts');
      const span = `${month(c)} → ${c.validTo?.slice(0, 7) ?? ''}${c.status === 'superseded' ? ', korvattu' : ''}`;
      return `- [${span}] ${c.text}${pro ? ` Lainaus: "${pro.quote}" (${pro.chatId ?? '-'})` : ''}${
        con ? ` Vastaan: "${con.quote}" (${con.chatId ?? '-'})` : ''
      }`;
    });

  /**
   * Decision 11: extracts the chats idle for IDLE_MS with turns after the last extraction, oldest
   * first, at most SWEEP_MAX per run, one at a time. `messagesOf` gives the branch, or undefined
   * when the chat is busy. A failed chat waits RETRY_MS.
   */
  const sweep = async (
    messagesOf: (chatId: string) => Promise<ChatMsg[] | undefined>,
    onActivated: (chatId: string, activated: Activated[]) => void,
    at = Date.now(),
  ) => {
    if (!pseudo || !deps.ask) return;
    const nowIso = new Date(at).toISOString();
    const due = db
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.userId, userId),
          eq(chats.fromAutomation, false),
          lt(chats.updatedAt, new Date(at - IDLE_MS).toISOString()),
          or(isNull(chats.claimsAt), lt(chats.claimsAt, chats.updatedAt)),
          or(isNull(chats.claimsRetryAt), lt(chats.claimsRetryAt, nowIso)),
        ),
      )
      .orderBy(asc(chats.updatedAt))
      .limit(SWEEP_MAX)
      .all();
    for (const chat of due) {
      try {
        const messages = await messagesOf(chat.id);
        if (!messages) continue;
        // The chat's `updatedAt` now: a message sent during the call makes it due again.
        const r = await extract(chat.id, messages, {
          through: chat.claimsThrough,
          tainted: chat.tainted,
          date: chat.updatedAt.slice(0, 10),
          seenAt: chat.updatedAt,
        });
        if (r.activated.length) onActivated(chat.id, r.activated);
      } catch (err) {
        warn('claims extraction failed', {
          chatId: chat.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
        db.update(chats)
          .set({ claimsRetryAt: new Date(at + RETRY_MS).toISOString() })
          .where(eq(chats.id, chat.id))
          .run();
      }
    }
  };

  /**
   * Decision 28: MEMORY.md from the active open claims. Score order fills the cap; sections and
   * ids order the output, so the same claims give the same bytes. `markProfile` sets `inProfile`
   * after the file write succeeded.
   */
  const profile = (cap: number) => {
    const rows = db
      .select()
      .from(claims)
      .where(and(open(), eq(claims.status, 'active')))
      .all();
    const patterns = twoChats(rows.filter((c) => c.kind === 'decision_pattern').map((c) => c.id));
    const ranked = rows
      .filter((c) => c.kind !== 'decision_pattern' || (c.confidence >= 0.6 && patterns.has(c.id)))
      .map((c) => ({ c, score: c.confidence * (1 + Math.log(c.timesSeen)) * recency(c) }))
      .sort((a, b) => b.score - a.score || a.c.id - b.c.id);
    const chosen: ClaimRow[] = [];
    const render = (cs: ClaimRow[]) =>
      SECTIONS.flatMap(([kind, title]) => {
        const lines = cs
          .filter((c) => c.kind === kind)
          .sort((a, b) => a.id - b.id)
          .map((c) => `- ${c.text}`);
        return lines.length ? [`## ${title}`, ...lines] : [];
      }).join('\n');
    for (const { c } of ranked) if (render([...chosen, c]).length <= cap) chosen.push(c);
    return { text: render(chosen), ids: chosen.map((c) => c.id) };
  };
  const markProfile = (ids: number[]) =>
    db.transaction((tx) => {
      tx.update(claims).set({ inProfile: false }).where(eq(claims.userId, userId)).run();
      if (ids.length)
        tx.update(claims).set({ inProfile: true }).where(inArray(claims.id, ids)).run();
    });

  /** Never a delete: the validity closes. */
  const close = (tx: Tx | Db, id: number, validTo: string) =>
    tx
      .update(claims)
      .set({ status: 'superseded', validTo })
      .where(and(eq(claims.id, id), inArray(claims.status, ['active', 'proposed'])))
      .run();

  /**
   * Decision 30: the `memory` tool on target `memory` writes claims (real text: `tool_call`
   * restored the arguments). `add` dedupes like extraction; `replace` closes and adds in one
   * transaction; an untainted `remove` closes. A tainted `remove` never comes here (the host parks
   * it). Throws NOT_FOUND.
   */
  const toolWrite = async (
    w: { action: 'add' | 'replace' | 'remove'; text: string; replace?: string | undefined },
    chatId: string,
    tainted: boolean,
  ): Promise<number> => {
    const text = w.text.slice(0, 240);
    const [v] = w.action === 'remove' ? [null] : await vectors([text], warn);
    const entityIds =
      pseudo && w.action !== 'remove'
        ? [...new Set((await pseudo.mask(`memory:${userId}`, text)).spans.map((s) => s.entity_id))]
        : [];
    const fresh = (supersedesId: number | null = null): Item => ({
      claim: {
        kind: 'fact',
        text,
        confidence: 0.9,
        status: tainted ? 'proposed' : 'active',
        activatedBy: tainted ? null : 'user',
        sourceChatId: chatId,
        supersedesId,
      },
      evidence: [],
      entityIds,
    });
    if (w.action === 'add') {
      const dup = duplicateOf(text, v ?? null);
      if (dup) return dup.id;
      const [id] = db.transaction((tx) => insert(tx, [fresh()], [v ?? null]));
      if (!tainted) await changed();
      return id as number;
    }
    const needle = w.action === 'replace' ? w.replace : w.text;
    const hits = needle
      ? db
          .select({ id: claims.id, text: claims.text })
          .from(claims)
          .where(and(open(), eq(claims.status, 'active')))
          .all()
          .filter((c) => c.text.includes(needle))
      : [];
    const old = hits.length === 1 ? hits[0] : undefined;
    if (!old) throw new Error(NOT_FOUND);
    if (w.action === 'remove') {
      close(db, old.id, today());
      await changed();
      return old.id;
    }
    const [id] = db.transaction((tx) => {
      if (!tainted) close(tx, old.id, today());
      const ids = insert(tx, [fresh(old.id)], [v ?? null]);
      if (tainted)
        tx.insert(evidence)
          .values({
            userId,
            claimId: old.id,
            chatId,
            messageId: null,
            quote: text,
            stance: 'contradicts',
            supersededBy: ids[0],
            createdAt: now(),
          })
          .run();
      return ids;
    });
    if (!tainted) await changed();
    return id as number;
  };

  /** Closes every claim that `newId` supersedes (its proposal rows), inside `tx`. */
  const closeSuperseded = (tx: Tx, c: ClaimRow) => {
    const props = tx.select().from(evidence).where(eq(evidence.supersededBy, c.id)).all();
    const old = new Map(props.map((p) => [p.claimId, p.validTo]));
    if (c.supersedesId && !old.has(c.supersedesId)) old.set(c.supersedesId, null);
    for (const [id, validTo] of old) close(tx, id, validTo ?? c.validFrom ?? today());
  };

  /**
   * `claims.review`: accept (with an edit or expiry) or reject. `not_found` when the claim is not
   * proposed (or, for reject, active: the user may change their mind); `invalid` for an expiry in
   * the past.
   */
  const review = async (
    id: number,
    action: 'accept' | 'reject',
    edit: { text?: string | undefined; validTo?: string | undefined } = {},
  ): Promise<Result> => {
    const c = row(id);
    const undo = c?.status === 'active' && action === 'reject';
    if (!c || (c.status !== 'proposed' && !undo)) return 'not_found';
    if (action === 'reject') {
      db.update(claims)
        .set({ status: 'rejected', reviewedAt: now() })
        .where(eq(claims.id, id))
        .run();
      if (undo) await changed();
      return 'ok';
    }
    if (edit.validTo && edit.validTo <= today()) return 'invalid';
    const text = edit.text && edit.text !== c.text ? edit.text : undefined;
    const [v] = text ? await vectors([text], warn) : [null];
    db.transaction((tx) => {
      if (text) setTextTx(tx, id, text, v ?? null);
      tx.update(claims)
        .set({
          status: 'active',
          activatedBy: 'user',
          reviewedAt: now(),
          ...(edit.validTo ? { validTo: edit.validTo } : {}),
        })
        .where(eq(claims.id, id))
        .run();
      closeSuperseded(tx, c);
    });
    await changed();
    return 'ok';
  };

  /** `claims.update` on an active claim: text and expiry (a past expiry is `invalid`). */
  const update = async (
    id: number,
    edit: { text?: string | undefined; validTo?: string | null | undefined },
  ): Promise<Result> => {
    const c = row(id);
    if (c?.status !== 'active') return 'not_found';
    if (edit.validTo && edit.validTo <= today()) return 'invalid';
    const text = edit.text && edit.text !== c.text ? edit.text : undefined;
    const [v] = text ? await vectors([text], warn) : [null];
    db.transaction((tx) => {
      if (text) setTextTx(tx, id, text, v ?? null);
      if (edit.validTo !== undefined)
        tx.update(claims).set({ validTo: edit.validTo }).where(eq(claims.id, id)).run();
    });
    await changed();
    return 'ok';
  };

  const staleWhere = () => {
    const t = Date.now();
    return and(
      open(),
      eq(claims.status, 'active'),
      lt(
        sql`coalesce(${claims.lastConfirmedAt}, ${claims.recordedAt})`,
        new Date(t - STALE_DAYS * DAY_MS).toISOString(),
      ),
      or(
        isNull(claims.checkedAt),
        lt(claims.checkedAt, new Date(t - CHECK_DAYS * DAY_MS).toISOString()),
      ),
    );
  };
  /** `claims.stale`: keep confirms now; lower takes 0.2 off (never below 0.1). */
  const stale = (id: number, action: 'keep' | 'lower'): Result => {
    const c = row(id);
    if (c?.status !== 'active') return 'not_found';
    const at = now();
    db.update(claims)
      .set(
        action === 'keep'
          ? { lastConfirmedAt: at, checkedAt: at }
          : {
              confidence: Math.max(0.1, Math.round((c.confidence - 0.2) * 10) / 10),
              checkedAt: at,
            },
      )
      .where(eq(claims.id, id))
      .run();
    return 'ok';
  };

  /** Rows to protocol claims with up to 3 newest quotes and the superseded claim's text. */
  const toClaims = (rows: ClaimRow[]): Claim[] => {
    const ids = rows.map((c) => c.id);
    const ev = ids.length
      ? db
          .select()
          .from(evidence)
          .where(inArray(evidence.claimId, ids))
          .orderBy(desc(evidence.id))
          .all()
      : [];
    const sup = rows.flatMap((c) => (c.supersedesId ? [c.supersedesId] : []));
    const old = new Map(
      sup.length
        ? db
            .select({ id: claims.id, text: claims.text })
            .from(claims)
            .where(inArray(claims.id, sup))
            .all()
            .map((r) => [r.id, r])
        : [],
    );
    return rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      confidence: c.confidence,
      status: c.status,
      activatedBy: c.activatedBy,
      validFrom: c.validFrom,
      validTo: c.validTo,
      recordedAt: c.recordedAt,
      lastConfirmedAt: c.lastConfirmedAt,
      timesSeen: c.timesSeen,
      sourceChatId: c.sourceChatId,
      supersedes: (c.supersedesId && old.get(c.supersedesId)) || null,
      evidence: ev
        .filter((e) => e.claimId === c.id)
        .slice(0, 3)
        .map((e) => ({
          chatId: e.chatId,
          messageId: e.messageId,
          quote: e.quote,
          stance: e.stance,
        })),
    }));
  };

  /** `claims.state` (phase-17 "Protocol"). */
  const state = (): ServerMessage => {
    const of = (status: ClaimRow['status']) =>
      db
        .select()
        .from(claims)
        .where(and(eq(claims.userId, userId), eq(claims.status, status)))
        .orderBy(desc(claims.id));
    const proposed = of('proposed').all();
    const count = (status: ClaimRow['status']) =>
      db
        .select({ n: sql<number>`count(*)` })
        .from(claims)
        .where(
          and(
            eq(claims.userId, userId),
            eq(claims.status, status),
            isNotNull(claims.reviewedAt),
            isNotNull(claims.sourceChatId),
          ),
        )
        .get()?.n ?? 0;
    return {
      type: 'claims.state',
      proposed: toClaims([
        ...proposed.filter((c) => c.supersedesId),
        ...proposed.filter((c) => !c.supersedesId),
      ]),
      active: toClaims(of('active').all()),
      superseded: toClaims(of('superseded').limit(50).all()),
      stale: toClaims(db.select().from(claims).where(staleWhere()).orderBy(claims.id).all()),
      precision: {
        accepted: count('active') + count('superseded'),
        rejected: count('rejected'),
      },
    };
  };

  /** The chip of `chat.state`: claims this chat activated at once in the last 7 days. */
  const chips = (chatId: string) =>
    db
      .select({ id: claims.id, kind: claims.kind, text: claims.text })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.sourceChatId, chatId),
          eq(claims.status, 'active'),
          eq(claims.activatedBy, 'auto'),
          gt(claims.recordedAt, new Date(Date.now() - CHIP_DAYS * DAY_MS).toISOString()),
        ),
      )
      .all();

  /** Decision 23: after a vault merge, links and subjects follow the surviving entity. */
  const repoint = (fromIds: number[], intoId: number) =>
    db.transaction((tx) => {
      const moved = tx
        .select()
        .from(claimEntities)
        .where(and(eq(claimEntities.userId, userId), inArray(claimEntities.entityId, fromIds)))
        .all();
      tx.delete(claimEntities)
        .where(and(eq(claimEntities.userId, userId), inArray(claimEntities.entityId, fromIds)))
        .run();
      for (const m of moved)
        tx.insert(claimEntities)
          .values({ ...m, entityId: intoId })
          .onConflictDoNothing()
          .run();
      tx.update(claims)
        .set({ subjectEntityId: intoId })
        .where(and(eq(claims.userId, userId), inArray(claims.subjectEntityId, fromIds)))
        .run();
    });

  /** Decision 43: every claim with its evidence and entity ids, for the open export. */
  const exportAll = () => {
    const rows = db.select().from(claims).where(eq(claims.userId, userId)).orderBy(claims.id).all();
    const ev = db.select().from(evidence).where(eq(evidence.userId, userId)).all();
    const ents = db.select().from(claimEntities).where(eq(claimEntities.userId, userId)).all();
    return rows.map((c) => ({
      ...c,
      evidence: ev.filter((e) => e.claimId === c.id).map(({ userId: _, claimId: __, ...e }) => e),
      entityIds: ents.filter((e) => e.claimId === c.id).map((e) => e.entityId),
    }));
  };

  /** Every 5 minutes (decision 11). */
  const schedule = (run: () => Promise<void>) =>
    cron.schedule('*/5 * * * *', run, { timezone: 'Europe/Helsinki', noOverlap: true });

  return {
    add,
    importMemory,
    extract,
    sweep,
    schedule,
    open,
    rank,
    relevant,
    recallRanked,
    recallLines,
    profile,
    markProfile,
    toolWrite,
    review,
    update,
    stale,
    state,
    chips,
    repoint,
    exportAll,
  };
}
