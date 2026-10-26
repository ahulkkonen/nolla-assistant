/**
 * Memory eval (docs/decisions/phase-17-memory.md, decisions 33 to 37). Synthetic chats only.
 *
 *   PSEUDO_URL=… LITELLM_URL=… LITELLM_MASTER_KEY=… node src/run.ts [--no-claims] [--out file]
 *
 * Without a working LiteLLM the QA metrics are null and the reason is recorded.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chats, openDb } from '@pa/db';
import { PseudoClient } from '@pa/pi-ext-pseudo';
import { memoryStore } from '@pa/server/src/memory.ts';
import { indexChat, indexIdle, search } from '@pa/server/src/search.ts';
import { taskSmall } from '@pa/server/src/topics.ts';
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

// 1. Vault and chats: masked transcripts indexed as the server does.
await pseudo.vaultSeed(seed);
const masked = new Map<string, { id: string; role: 'user' | 'assistant'; text: string }[]>();
for (const c of chatList) {
  const at = new Date(Date.now() - c.daysAgo * DAY).toISOString();
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
  masked.set(c.id, msgs);
  await indexChat(db, USER, c.id, msgs);
}
await indexIdle();

const usage = { calls: 0, costUsd: 0 };
const onUsage = Object.assign((_at: unknown, u: { costUsd?: number } | undefined) => {
  usage.calls++;
  usage.costUsd += u?.costUsd ?? 0;
}, {});
const memory = memoryStore({
  db,
  dataDir,
  userId: USER,
  pseudo,
  litellmUrl,
  litellmMasterKey: litellmKey,
  warn: () => {},
  sendAll: () => {},
});

// 2. Claims (phase 17). The block and the claim evidence come from `claimsFor`.
type ClaimHits = { block: string; evidence: string[] };
let claimsFor: (q: string) => Promise<ClaimHits> = async () => ({ block: '', evidence: [] });
if (!noClaims) throw new Error('claims mode needs phase-17 task S2 to S4');

// 3. LiteLLM probe: QA metrics need a working model.
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

const ANSWER = `Olet käyttäjän avustaja. Vastaa käyttäjän kysymykseen vain alla olevan muistin perusteella. Jos muisti ei kerro vastausta, sano "En tiedä". Vastaa pelkällä JSON-objektilla: {"answer": string}`;
const JUDGE = `Arvioi, vastaako vastaus oikeaa vastausta sisällöltään. "En tiedä" on oikein vain, jos oikea vastaus on "Ei tiedossa". Vastaa pelkällä JSON-objektilla: {"correct": boolean}`;

type Row = {
  id: string;
  category: string;
  recallHit: boolean | null;
  correct: boolean | null;
  blockChars: number;
};
const rows: Row[] = [];
const profile = `## Käyttäjä\n${memory.read('user')}\n\n## Muisti\n${memory.read('memory')}`;
for (const q of questions) {
  const hits = await search(db, USER, q.question, 5, pseudo);
  const snippets = await memory.recall(q.question, {});
  const claims = await claimsFor(q.question);
  const found = new Set([...hits.map((h) => h.messageId ?? ''), ...claims.evidence]);
  const recallHit = q.evidence.length ? q.evidence.some((e) => found.has(e)) : null;
  let correct: boolean | null = null;
  if (!llmError) {
    const context = await mask(
      `eval:${q.id}`,
      `${profile}\n\n${claims.block}\n\nHaku:\n${snippets.map((s) => `- ${s.snippet}`).join('\n')}`,
    );
    const a = await answerAsk(z.object({ answer: z.string() }), [
      { role: 'system', content: ANSWER },
      { role: 'user', content: `${context}\n\nKysymys: ${await mask(`eval:${q.id}`, q.question)}` },
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
  }
  rows.push({
    id: q.id,
    category: q.category,
    recallHit,
    correct,
    blockChars: claims.block.length,
  });
}
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
  claimPrecision: null as number | null,
  extraction: { calls: 0, costUsd: 0 },
  rows,
};
const out =
  args[args.indexOf('--out') + 1] && args.includes('--out')
    ? (args[args.indexOf('--out') + 1] as string)
    : join(root, 'results', `${result.date}${noClaims ? '-no-claims' : ''}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
const { rows: _, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
sqlite.close();
rmSync(dataDir, { recursive: true, force: true });
