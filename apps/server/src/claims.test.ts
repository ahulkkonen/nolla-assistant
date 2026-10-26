import { join } from 'node:path';
import { chats, claimEntities, claims, evidence, openDb } from '@pa/db';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { PseudoClient } from '@pa/pi-ext-pseudo';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { type ChatMsg, claimStore } from './claims.ts';
import { loadModel } from './embeddings.ts';
import { cleanups, runCleanups, tempDir } from './test-utils.ts';
import { taskSmall } from './topics.ts';

afterEach(runCleanups);

const store = () => {
  const { db, sqlite } = openDb(join(tempDir('pa-claims-'), 'app.db'));
  return { db, sqlite, store: claimStore({ db, userId: 'aleksi', warn: () => {} }) };
};

test('import turns MEMORY.md lines into active claims, once', { timeout: 60_000 }, async () => {
  const { db, sqlite, store: s } = store();
  const md =
    '## Muisti\n- Käyttäjä juoksee aamuisin.\n- Mikko Virtanen on työkaveri.\n\nKahvi mustana.';
  expect(await s.importMemory(md)).toBe(3);
  expect(await s.importMemory(md)).toBe(0);
  const rows = db.select().from(claims).all();
  expect(rows.map((r) => [r.text, r.status, r.kind, r.activatedBy])).toEqual([
    ['Käyttäjä juoksee aamuisin.', 'active', 'fact', 'user'],
    ['Mikko Virtanen on työkaveri.', 'active', 'fact', 'user'],
    ['Kahvi mustana.', 'active', 'fact', 'user'],
  ]);
  expect(sqlite.prepare('SELECT count(*) AS n FROM claims_fts').get()).toEqual({ n: 3 });
  expect(sqlite.prepare('SELECT count(*) AS n FROM claims_vec').get()).toEqual({ n: 3 });
  sqlite.close();
});

// --- S2: extraction --------------------------------------------------------------------------

const modelOk = await loadModel().then(
  () => true,
  () => false,
);
const MIN = 60_000;
const DICT = { 'Mikko Virtanen': 'Kalle Laaksonen' };
type Turn = FakeTurn;
const reply = (o: object): Turn => ({ text: JSON.stringify(o), match: 'Keskustelu:' });
const q = (message: string, quote: string) => ({ message, quote });

async function extraction(turns: Turn[], opts: Parameters<typeof startFakeSidecar>[1] = {}) {
  const llm = await startFakeLlm(turns);
  cleanups.push(llm.close);
  const sc = await startFakeSidecar(DICT, opts);
  cleanups.push(sc.close);
  const { db, sqlite } = openDb(join(tempDir('pa-claims-'), 'app.db'));
  cleanups.push(() => {
    sqlite.close();
  });
  const s = claimStore({
    db,
    userId: 'aleksi',
    warn: () => {},
    pseudo: new PseudoClient(sc.url, 'aleksi'),
    ask: taskSmall(llm.url, 'k'),
  });
  const chat = (
    id: string,
    o: { idleMin?: number; tainted?: boolean; fromAutomation?: boolean } = {},
  ) => {
    const at = new Date(Date.now() - (o.idleMin ?? 25) * MIN).toISOString();
    db.insert(chats)
      .values({
        id,
        userId: 'aleksi',
        sessionPath: `sessions/${id}.jsonl`,
        tainted: o.tainted ?? false,
        fromAutomation: o.fromAutomation ?? false,
        createdAt: at,
        updatedAt: at,
      })
      .run();
  };
  const activated: { chatId: string; ids: number[] }[] = [];
  const asked: string[] = [];
  const sweep = (msgs: ChatMsg[], now = Date.now()) =>
    s.sweep(
      async (chatId) => {
        asked.push(chatId);
        return msgs;
      },
      (chatId, a) => activated.push({ chatId, ids: a.map((c) => c.id) }),
      now,
    );
  const all = () => db.select().from(claims).orderBy(claims.id).all();
  return { llm, sc, db, s, chat, sweep, all, activated, asked };
}

const PREF = {
  kind: 'preference',
  text: 'Käyttäjä haluaa lyhyet vastaukset.',
  confidence: 0.85,
  valid_from: null,
  evidence: [q('m1', 'Vastaa aina lyhyesti.')],
};
const MSGS: ChatMsg[] = [
  { id: 'e1', role: 'user', text: 'Vastaa aina lyhyesti. Kalle Laaksonen on esihenkilöni.' },
  { id: 'e2', role: 'assistant', text: 'Selvä.' },
];

test('extraction: an idle chat is extracted once, masked; quotes are checked; a clean preference activates', {
  timeout: 60_000,
}, async () => {
  const x = await extraction([
    reply({
      claims: [
        PREF,
        {
          kind: 'relationship',
          text: 'Kalle Laaksonen on käyttäjän esihenkilö.',
          confidence: 0.9,
          valid_from: null,
          evidence: [q('m1', 'Kalle Laaksonen on esihenkilöni.')],
        },
        // Not in the message: dropped.
        {
          kind: 'fact',
          text: 'Käyttäjä asuu Oulussa.',
          confidence: 0.9,
          valid_from: null,
          evidence: [q('m1', 'asun Oulussa')],
        },
      ],
      confirms: [],
      supersedes: [],
    }),
  ]);
  x.chat('c1');
  x.chat('fresh', { idleMin: 5 });
  await x.sweep(MSGS);
  expect(x.asked).toEqual(['c1']);
  expect(x.llm.requests).toHaveLength(1);
  const sent = JSON.stringify(x.llm.requests[0]?.body);
  expect(sent).toContain('Kalle Laaksonen');
  expect(sent).not.toContain('Mikko Virtanen');
  expect(sent).toContain('[m1] Käyttäjä: Vastaa aina lyhyesti.');

  const rows = x.all();
  expect(rows.map((r) => [r.kind, r.status, r.activatedBy, r.text])).toEqual([
    ['preference', 'active', 'auto', 'Käyttäjä haluaa lyhyet vastaukset.'],
    ['relationship', 'proposed', null, 'Mikko Virtanen on käyttäjän esihenkilö.'],
  ]);
  expect(rows[1]?.subjectEntityId).toBe(1);
  expect(x.db.select().from(claimEntities).all()).toEqual([
    { claimId: rows[1]?.id, entityId: 1, userId: 'aleksi' },
  ]);
  const ev = x.db.select().from(evidence).orderBy(evidence.id).all();
  expect(ev.map((e) => [e.messageId, e.quote, e.stance])).toEqual([
    ['e1', 'Vastaa aina lyhyesti.', 'supports'],
    ['e1', 'Mikko Virtanen on esihenkilöni.', 'supports'],
  ]);
  expect(x.activated).toEqual([{ chatId: 'c1', ids: [rows[0]?.id] }]);
  // Read up to the last message: the next sweep has nothing to do.
  await x.sweep(MSGS);
  expect(x.llm.requests).toHaveLength(1);
});

test('extraction: a tainted chat proposes; an unresolved surrogate rejects the claim; automation chats are skipped', {
  timeout: 60_000,
}, async () => {
  const x = await extraction(
    [
      reply({
        claims: [
          PREF,
          {
            kind: 'relationship',
            text: 'Laaksoseni on käyttäjän ystävä.',
            confidence: 0.9,
            valid_from: null,
            evidence: [q('m1', 'Vastaa aina lyhyesti.')],
          },
        ],
        confirms: [],
        supersedes: [],
      }),
    ],
    { unresolved: ['Laaksoseni'] },
  );
  x.chat('auto', { fromAutomation: true });
  x.chat('t', { tainted: true });
  await x.sweep(MSGS);
  expect(x.asked).toEqual(['t']);
  expect(x.all().map((r) => [r.kind, r.status])).toEqual([['preference', 'proposed']]);
  expect(x.activated).toEqual([]);
});

test.skipIf(!modelOk)(
  'extraction: a supersede is proposed and leaves the old claim active',
  {
    timeout: 60_000,
  },
  async () => {
    const x = await extraction([]);
    const [old] = await x.s.add([
      {
        claim: {
          kind: 'rhythm',
          text: 'Käyttäjä juoksee kolmesti viikossa.',
          confidence: 0.9,
          status: 'active',
        },
        evidence: [],
      },
    ]);
    x.llm.push(
      reply({
        claims: [
          {
            kind: 'rhythm',
            text: 'Käyttäjä ui kahdesti viikossa.',
            confidence: 0.9,
            valid_from: '2026-10',
            evidence: [q('m1', 'uin nyt kahdesti viikossa')],
          },
        ],
        confirms: [],
        supersedes: [
          {
            claim_id: old,
            reason: 'Lopetti juoksun.',
            valid_to: null,
            new_claim: 0,
            evidence: q('m1', 'Lopetin juoksemisen'),
          },
        ],
      }),
    );
    x.chat('c2');
    await x.sweep([
      { id: 'u1', role: 'user', text: 'Lopetin juoksemisen, uin nyt kahdesti viikossa.' },
    ]);
    expect(JSON.stringify(x.llm.requests[0]?.body)).toContain(
      'Käyttäjä juoksee kolmesti viikossa.',
    );
    const rows = x.all();
    expect(rows.map((r) => [r.status, r.supersedesId, r.validTo])).toEqual([
      ['active', null, null],
      ['proposed', old, null],
    ]);
    const ev = x.db
      .select()
      .from(evidence)
      .where(eq(evidence.claimId, old as number))
      .all();
    expect(ev.map((e) => e.stance)).toEqual(['contradicts']);
  },
);
