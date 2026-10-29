/**
 * Memory eval (docs/decisions/phase-17-memory.md, decisions 33 to 37). Synthetic chats only.
 *
 *   PSEUDO_URL=… LITELLM_URL=… LITELLM_MASTER_KEY=… node src/run.ts [--no-claims | --claims-from gold] [--out file]
 *
 * Without a working LiteLLM the QA metrics are null and the reason is recorded.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClaimKind, chats, claims, evidence, openDb } from '@pa/db';
import { CLAIMS_HEADER } from '@pa/pi-ext-memory';
import { PseudoClient } from '@pa/pi-ext-pseudo';
import { claimStore } from '@pa/server/src/claims.ts';
import { memoryStore } from '@pa/server/src/memory.ts';
import { indexChat, indexIdle, search } from '@pa/server/src/search.ts';
import { taskSmall } from '@pa/server/src/topics.ts';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

type Chat = {
  id: string;
  daysAgo: number;
  messages: { role: 'user' | 'assistant'; text: string }[];
};
type Question = {
  id: string;
  category: string;
  question: string;
  answer: string;
  evidence: string[];
  abstain: boolean;
  /** The day the question is asked, in days before now: it sees only the chats up to then. */
  askedDaysAgo: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const USER = 'eval';
const DAY = 86_400_000;
const args = process.argv.slice(2);
const noClaims = args.includes('--no-claims');
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const litellmUrl = env('LITELLM_URL');
const litellmKey = env('LITELLM_MASTER_KEY');
const pseudo = new PseudoClient(env('PSEUDO_URL'), USER);

const chatList = JSON.parse(readFileSync(join(root, 'fixtures/chats.json'), 'utf8')) as Chat[];
const questions = readFileSync(join(root, 'fixtures/questions.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Question);
const seed = JSON.parse(readFileSync(join(root, '../pii/vault-seed.json'), 'utf8')) as {
  canonical: string;
  kind: string;
}[];

const dataDir = mkdtempSync(join(tmpdir(), 'pa-memory-eval-'));
const { db, sqlite } = openDb(join(dataDir, 'app.db'));
const mask = async (session: string, t: string) => (t ? (await pseudo.mask(session, t)).masked : t);

const usage = { calls: 0, costUsd: 0 };
const onUsage = Object.assign((_at: unknown, u: { costUsd?: number } | undefined) => {
  usage.calls++;
  usage.costUsd += u?.costUsd ?? 0;
}, {});

// 1. LiteLLM probe: extraction and the QA metrics need a working model.
const answerAsk = taskSmall(litellmUrl, litellmKey, onUsage, 'zdr/fast');
const judgeAsk = taskSmall(litellmUrl, litellmKey, onUsage);
let llmError: string | null = null;
try {
  await answerAsk(z.object({ ok: z.boolean() }), [
    { role: 'user', content: 'Vastaa JSONilla {"ok": true}.' },
  ]);
} catch (err) {
  llmError = err instanceof Error ? err.message : 'unknown';
}

// 2. Claims (phase 17): extracted with the real `zdr/task-small`, or with `--claims-from gold`
// the gold claims (a retrieval upper bound: no extraction, no supersession).
const claimsFrom = args.includes('--claims-from')
  ? args[args.indexOf('--claims-from') + 1]
  : 'extract';
if (!noClaims && claimsFrom !== 'gold' && llmError)
  throw new Error(`extraction needs LiteLLM: ${llmError}`);
const extraction = { calls: 0, costUsd: 0 };
const store = noClaims
  ? undefined
  : claimStore({
      db,
      userId: USER,
      warn: () => {},
      pseudo,
      ask: taskSmall(litellmUrl, litellmKey, (_at, u) => {
        extraction.calls++;
        extraction.costUsd += u?.costUsd ?? 0;
      }),
    });
const memory = memoryStore({
  db,
  dataDir,
  userId: USER,
  pseudo,
  warn: () => {},
  sendAll: () => {},
  claims: store,
});
const gold = readFileSync(join(root, 'fixtures/gold-claims.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as { chat: string; kind: ClaimKind; text: string; message: number });

// 3. Timeline: each chat is indexed (and mined) on its day; a question sees only the chats from
// before its `askedDaysAgo`.
await pseudo.vaultSeed(seed);
const dayOf = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const ingest = async (c: Chat) => {
  const at = dayOf(c.daysAgo);
  db.insert(chats)
    .values({
      id: c.id,
      userId: USER,
      sessionPath: `sessions/${c.id}.jsonl`,
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const msgs = [];
  for (const [i, m] of c.messages.entries())
    msgs.push({ id: `${c.id}:${i}`, role: m.role, text: await mask(c.id, m.text) });
  await indexChat(db, USER, c.id, msgs);
  await indexIdle();
  if (!store) return;
  if (claimsFrom === 'gold') {
    for (const g of gold.filter((x) => x.chat === c.id)) {
      const { spans } = await pseudo.mask(c.id, g.text);
      await store.add([
        {
          claim: {
            kind: g.kind,
            text: g.text,
            confidence: 0.9,
            status: 'active',
            activatedBy: 'user',
            sourceChatId: c.id,
            validFrom: at.slice(0, 10),
          },
          evidence: [
            {
              chatId: c.id,
              messageId: `${c.id}:${g.message}`,
              quote: c.messages[g.message]?.text.slice(0, 300) ?? '',
              stance: 'supports',
            },
          ],
          entityIds: spans.map((x) => x.entity_id),
        },
      ]);
    }
    return;
  }
  await store.extract(c.id, msgs, { at: -1, tainted: false, date: at.slice(0, 10) });
  // Eval mode: every proposal is accepted (a supersede closes the old claims).
  const proposed = db.select().from(claims).where(eq(claims.status, 'proposed')).all();
  for (const p of proposed.sort((a, b) => a.id - b.id)) await store.review(p.id, 'accept');
};

type Item = { key: string; messages: string[] };
const evidenceOf = (ids: number[]): Item[] =>
  ids.map((id) => ({
    key: `claim:${id}`,
    messages: db
      .select()
      .from(evidence)
      .where(and(eq(evidence.claimId, id), eq(evidence.stance, 'supports')))
      .all()
      .map((e) => e.messageId ?? ''),
  }));
/** The per-turn block and its claims (the injection path, with entity ids from the prompt). */
const blockFor = async (q: string) => {
  if (!store) return { block: '', items: [] as Item[] };
  const r = await store.relevant(await mask('eval:q', q), []);
  return {
    block: r.lines.length ? `${CLAIMS_HEADER}\n${r.lines.join('\n')}` : '',
    items: evidenceOf(r.ids),
  };
};

/** Masked judge over numbered batches of ten (one call with 60 booleans came back misaligned). */
async function judgeEach(items: string[], task: string) {
  let hits = 0;
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const r = await judgeAsk(z.object({ matches: z.array(z.boolean()).length(batch.length) }), [
      {
        role: 'system',
        content: `${task} Vastaa pelkällä JSON-objektilla: {"matches": [boolean, ...]}, täsmälleen ${batch.length} arvoa numerojärjestyksessä.`,
      },
      {
        role: 'user',
        content: await mask('eval:judge', batch.map((t, j) => `${j + 1}. ${t}`).join('\n')),
      },
    ]);
    hits += r?.matches.filter(Boolean).length ?? 0;
  }
  return Math.round((1000 * hits) / items.length) / 1000;
}

/** Precision: the share of extracted claims that their own evidence quote supports. */
const precision = (rows: { text: string; quote: string }[]) =>
  llmError || !rows.length
    ? null
    : judgeEach(
        rows.map((r) => `Havainto: ${r.text}\n   Lainaus: ${r.quote}`),
        'Saat numeroituja havaintoja, kullakin lainaus keskustelusta. Kerro jokaisesta, tukeeko lainaus havaintoa (havainto seuraa lainauksesta, ei vain liity siihen).',
      );

/** Gold match: the share of extracted claims that repeat a gold claim (coverage of the gold set, not precision). */
async function goldMatch(texts: string[]) {
  if (llmError || !texts.length) return null;
  const gold = readFileSync(join(root, 'fixtures/gold-claims.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => (JSON.parse(l) as { text: string }).text)
    .join('\n');
  return judgeEach(
    texts,
    `Kultaiset havainnot:\n${gold}\n\nSaat numeroituja poimittuja havaintoja. Kerro jokaisesta, vastaako se sisällöltään jotakin kultaista havaintoa (sama asia, sanamuoto saa erota).`,
  );
}

const ANSWER = `Olet käyttäjän avustaja. Vastaa käyttäjän kysymykseen vain alla olevan muistin perusteella. Jos muisti ei kerro vastausta, sano "En tiedä". Vastaa pelkällä JSON-objektilla: {"answer": string}`;
const JUDGE = `Arvioi, vastaako vastaus oikeaa vastausta sisällöltään. "En tiedä" on oikein vain, jos oikea vastaus on "Ei tiedossa". Vastaa pelkällä JSON-objektilla: {"correct": boolean}`;

type Row = {
  id: string;
  category: string;
  askedDaysAgo: number;
  recallHit: boolean | null;
  /** A gold message is the evidence of a claim in MEMORY.md (always injected). */
  profileHit: boolean | null;
  correct: boolean | null;
  blockChars: number;
  /** The model's masked answer next to the gold answer (synthetic data), so a wrong row can be read. */
  answer?: string | undefined;
  expected?: string | undefined;
  /** The masked context of a wrong answer, to tell a retrieval miss from an answer-model miss. */
  context?: string | undefined;
};
const rows: Row[] = [];
const timeline = [...chatList].sort((a, b) => b.daysAgo - a.daysAgo);
let next = 0;
for (const q of [...questions].sort((a, b) => b.askedDaysAgo - a.askedDaysAgo)) {
  let fresh = false;
  while (next < timeline.length && (timeline[next] as Chat).daysAgo >= q.askedDaysAgo) {
    await ingest(timeline[next++] as Chat);
    fresh = true;
  }
  if (fresh && store) await memory.consolidate();
  const block = await blockFor(q.question);
  const hits = await search(db, USER, q.question, 5, pseudo, { mark: false });
  const snippets = await memory.recall(q.question, {});
  const recalled = store ? evidenceOf((await store.recallRanked(q.question)).map((c) => c.id)) : [];
  // Recall@5: the top 5 of the union, in the order the model reads it (block, then recall).
  const union: Item[] = [];
  for (const it of [
    ...block.items,
    ...hits.map((h) => ({ key: `chunk:${h.messageId}`, messages: [h.messageId ?? ''] })),
    ...recalled,
  ])
    if (!union.some((u) => u.key === it.key)) union.push(it);
  const found = new Set(union.slice(0, 5).flatMap((u) => u.messages));
  const recallHit = q.evidence.length ? q.evidence.some((e) => found.has(e)) : null;
  const inProfile = new Set(
    evidenceOf(
      db
        .select({ id: claims.id })
        .from(claims)
        .where(eq(claims.inProfile, true))
        .all()
        .map((c) => c.id),
    ).flatMap((i) => i.messages),
  );
  const profileHit = q.evidence.length
    ? recallHit || q.evidence.some((e) => inProfile.has(e))
    : null;
  let correct: boolean | null = null;
  let answer: string | undefined;
  let context: string | undefined;
  if (!llmError) {
    const profile = `## Käyttäjä\n${memory.read('user')}\n\n## Muisti\n${memory.read('memory')}`;
    context = await mask(
      `eval:${q.id}`,
      `${profile}\n\n${block.block}\n\nHaku:\n${snippets.map((s) => `- ${s.snippet}`).join('\n')}`,
    );
    const a = await answerAsk(z.object({ answer: z.string() }), [
      { role: 'system', content: ANSWER },
      {
        role: 'user',
        content: `Päivämäärä: ${dayOf(q.askedDaysAgo).slice(0, 10)}\n\n${context}\n\nKysymys: ${await mask(`eval:${q.id}`, q.question)}`,
      },
    ]);
    const j = await judgeAsk(z.object({ correct: z.boolean() }), [
      { role: 'system', content: JUDGE },
      {
        role: 'user',
        content: await mask(
          `eval:${q.id}`,
          `Kysymys: ${q.question}\nOikea vastaus: ${q.answer}\nVastaus: ${a?.answer ?? ''}`,
        ),
      },
    ]);
    correct = j?.correct ?? false;
    answer = a?.answer;
  }
  rows.push({
    id: q.id,
    category: q.category,
    askedDaysAgo: q.askedDaysAgo,
    recallHit,
    profileHit,
    correct,
    blockChars: block.block.length,
    answer,
    expected: q.answer,
    context: correct === false ? context : undefined,
  });
}
const extracted =
  store && claimsFrom !== 'gold'
    ? db
        .select({ id: claims.id, status: claims.status, kind: claims.kind, text: claims.text })
        .from(claims)
        .all()
        .map((c) => ({
          ...c,
          quote:
            db
              .select({ quote: evidence.quote })
              .from(evidence)
              .where(and(eq(evidence.claimId, c.id), eq(evidence.stance, 'supports')))
              .get()?.quote ?? '',
        }))
    : [];
const claimPrecision = await precision(extracted);
const claimGoldMatch = await goldMatch(extracted.map((c) => c.text));
memory.close();

// 4. Metrics.
const rate = (xs: (boolean | null)[]) => {
  const v = xs.filter((x): x is boolean => x !== null);
  return v.length ? Math.round((1000 * v.filter(Boolean).length) / v.length) / 1000 : null;
};
const categories = [...new Set(rows.map((r) => r.category))];
const chars = rows.map((r) => r.blockChars).sort((a, b) => a - b);
const result = {
  date: new Date().toISOString().slice(0, 10),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(),
  mode: noClaims ? 'no-claims' : 'claims',
  models: { answer: 'zdr/fast', judge: 'zdr/task-small', extract: 'zdr/task-small' },
  llmError,
  recallAt5: {
    total: rate(rows.map((r) => r.recallHit)),
    ...Object.fromEntries(
      categories.map((c) => [
        c,
        rate(rows.filter((r) => r.category === c).map((r) => r.recallHit)),
      ]),
    ),
  },
  /** Recall@5 or a hit in MEMORY.md. */
  recallOrProfile: {
    total: rate(rows.map((r) => r.profileHit)),
    ...Object.fromEntries(
      categories.map((c) => [
        c,
        rate(rows.filter((r) => r.category === c).map((r) => r.profileHit)),
      ]),
    ),
  },
  qaAccuracy: {
    total: rate(rows.map((r) => r.correct)),
    ...Object.fromEntries(
      categories.map((c) => [c, rate(rows.filter((r) => r.category === c).map((r) => r.correct))]),
    ),
  },
  // ponytail: tokens estimated at 3 chars per Finnish token; read usage.input deltas when the model is up.
  blockTokens: {
    mean: Math.round(chars.reduce((a, b) => a + b, 0) / chars.length / 3),
    p95: Math.round((chars[Math.floor(chars.length * 0.95)] ?? 0) / 3),
  },
  claimsFrom: noClaims ? null : claimsFrom,
  claimPrecision,
  claimGoldMatch,
  extraction,
  /** Masked claims with their evidence quote, so a human can check the judge. */
  extracted: extracted.map(({ status, kind, text, quote }) => ({ status, kind, text, quote })),
  rows,
};
const out =
  args[args.indexOf('--out') + 1] && args.includes('--out')
    ? (args[args.indexOf('--out') + 1] as string)
    : join(
        root,
        'results',
        `${result.date}${noClaims ? '-no-claims' : claimsFrom === 'gold' ? '-gold-claims' : ''}.json`,
      );
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const { rows: _, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
sqlite.close();
rmSync(dataDir, { recursive: true, force: true });
