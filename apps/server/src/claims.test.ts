import { join } from 'node:path';
import { chats, claimEntities, claims, evidence, openDb } from '@pa/db';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { PseudoClient } from '@pa/pi-ext-pseudo';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { type ChatMsg, claimStore } from './claims.ts';
import { loadModel } from './embeddings.ts';
import { bootPseudo, cleanups, runCleanups, tempDir } from './test-utils.ts';
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

// --- S3: retrieval -----------------------------------------------------------------------------

test.skipIf(!modelOk)(
  'retrieval: an inflected name finds its claim through the entity; profile and injected claims are skipped; recall shows the quote',
  {
    timeout: 60_000,
  },
  async () => {
    // The real vault maps every inflected form to one entity (plan §6); the fake has one id per
    // form, so the claim links to the id of "Virtaselle" (2).
    const x = await extraction([], {});
    const sc = await startFakeSidecar({
      'Mikko Virtanen': 'Kalle Laaksonen',
      Virtaselle: 'Laaksoselle',
    });
    cleanups.push(sc.close);
    const s = claimStore({
      db: x.db,
      userId: 'aleksi',
      warn: () => {},
      pseudo: new PseudoClient(sc.url, 'aleksi'),
    });
    const active = (text: string, entityIds: number[] = [], quote?: string) => ({
      claim: { kind: 'relationship' as const, text, confidence: 0.9, status: 'active' as const },
      evidence: quote
        ? [{ chatId: 'c7', messageId: 'm7', quote, stance: 'supports' as const }]
        : [],
      entityIds,
    });
    const [boss, inProfile, other] = await s.add([
      active('Mikko Virtanen on käyttäjän esihenkilö.', [2], 'Mikko Virtanen on pomoni.'),
      active('Mikko Virtanen pitää kahvista.', [2]),
      active('Käyttäjän koira on labradori.'),
    ]);
    x.db
      .update(claims)
      .set({ inProfile: true })
      .where(eq(claims.id, inProfile as number))
      .run();

    const r = await s.relevant('Soitin eilen Laaksoselle.', []);
    expect(r.ids).toEqual([boss]);
    expect(r.lines).toEqual([
      `- (ihmissuhde, 0.9, ${new Date().toISOString().slice(0, 7)}) Mikko Virtanen on käyttäjän esihenkilö.`,
    ]);
    expect((await s.relevant('Soitin eilen Laaksoselle.', [boss as number])).ids).toEqual([]);
    expect((await s.relevant('Mikä rotu koiramme on?', [])).ids).toEqual([other]);

    const lines = await s.recallLines('esihenkilö');
    expect(lines[0]).toContain(
      'Mikko Virtanen on käyttäjän esihenkilö. Lainaus: "Mikko Virtanen on pomoni." (c7)',
    );
  },
);

test.skipIf(!modelOk)(
  'server: a turn gets the masked claims block as its last message',
  {
    timeout: 60_000,
  },
  async () => {
    const { llm, srv, c, chat } = await bootPseudo(DICT, [{ text: 'Selvä.' }]);
    const s = claimStore({ db: srv.db, userId: 'aleksi', warn: () => {} });
    await s.add([
      {
        claim: {
          kind: 'relationship',
          text: 'Mikko Virtanen on käyttäjän esihenkilö.',
          confidence: 0.9,
          status: 'active',
        },
        evidence: [],
        entityIds: [1],
      },
    ]);
    c.send({ type: 'user.message', chatId: chat.id, text: 'Mitä Mikko Virtanen halusi?' });
    await c.idle();
    const last = JSON.stringify(llm.requests[0]?.body.messages.at(-1));
    expect(last).toContain('Muistista tähän viestiin');
    expect(last).toContain('Kalle Laaksonen on käyttäjän esihenkilö.');
    expect(JSON.stringify(llm.requests[0]?.body)).not.toContain('Mikko Virtanen');
  },
);

// --- S4: regeneration and review ---------------------------------------------------------------

test('profile: same claims give the same bytes, capped, sections in order', {
  timeout: 60_000,
}, async () => {
  const { db, store: s } = store();
  const item = (kind: 'preference' | 'fact', text: string, confidence = 0.9) => ({
    claim: { kind, text, confidence, status: 'active' as const },
    evidence: [],
  });
  await s.add([
    item('fact', 'Käyttäjä asuu Tampereella.'),
    item('preference', 'Käyttäjä haluaa lyhyet vastaukset.'),
    ...Array.from({ length: 40 }, (_, i) =>
      item('fact', `Pitkä fakta ${i} ${'x'.repeat(80)}`, 0.5),
    ),
  ]);
  const a = s.profile(2500);
  expect(a.text.length).toBeLessThanOrEqual(2500);
  expect(
    a.text.startsWith(
      '## Mieltymykset\n- Käyttäjä haluaa lyhyet vastaukset.\n## Faktat\n- Käyttäjä asuu Tampereella.',
    ),
  ).toBe(true);
  expect(s.profile(2500)).toEqual(a);
  expect(
    db
      .select()
      .from(claims)
      .all()
      .filter((c) => c.inProfile),
  ).toHaveLength(a.count);
});

test('review: a supersede accept closes the old claim; edit, expiry, reject, chip undo; stale and precision', {
  timeout: 60_000,
}, async () => {
  const { db, store: s } = store();
  const [old, auto, plain, staleId] = await s.add([
    {
      claim: { kind: 'rhythm', text: 'Käyttäjä juoksee.', confidence: 0.9, status: 'active' },
      evidence: [],
    },
    {
      claim: {
        kind: 'preference',
        text: 'Käyttäjä haluaa lyhyesti.',
        confidence: 0.9,
        status: 'active',
        activatedBy: 'auto',
        sourceChatId: 'c1',
      },
      evidence: [],
    },
    {
      claim: {
        kind: 'fact',
        text: 'Käyttäjä asuu Espoossa.',
        confidence: 0.9,
        status: 'proposed',
        sourceChatId: 'c1',
      },
      evidence: [],
    },
    {
      claim: { kind: 'fact', text: 'Käyttäjä soittaa kitaraa.', confidence: 0.9, status: 'active' },
      evidence: [],
    },
  ]);
  const [sup] = await s.add([
    {
      claim: {
        kind: 'rhythm',
        text: 'Käyttäjä ui.',
        confidence: 0.9,
        status: 'proposed',
        supersedesId: old as number,
        validFrom: '2026-10-01',
        sourceChatId: 'c1',
      },
      evidence: [{ chatId: 'c1', messageId: 'm1', quote: 'uin nyt', stance: 'supports' }],
    },
  ]);
  const ago = new Date(Date.now() - 100 * 86_400_000).toISOString();
  db.update(claims)
    .set({ recordedAt: ago })
    .where(eq(claims.id, staleId as number))
    .run();

  let st = s.state();
  if (st.type !== 'claims.state') throw new Error('claims.state expected');
  expect(st.proposed.map((c) => c.id)).toEqual([sup, plain]);
  expect(st.proposed[0]?.supersedes).toEqual({ id: old, text: 'Käyttäjä juoksee.' });
  expect(st.proposed[0]?.evidence).toEqual([
    { chatId: 'c1', messageId: 'm1', quote: 'uin nyt', stance: 'supports' },
  ]);
  expect(st.stale.map((c) => c.id)).toEqual([staleId]);
  expect(s.chips('c1')).toEqual([
    { id: auto, kind: 'preference', text: 'Käyttäjä haluaa lyhyesti.' },
  ]);

  expect(await s.review(sup as number, 'accept')).toBe(true);
  const rows = () =>
    new Map(
      db
        .select()
        .from(claims)
        .all()
        .map((c) => [c.id, c]),
    );
  expect(rows().get(old as number)).toMatchObject({ status: 'superseded', validTo: '2026-10-01' });
  expect(rows().get(sup as number)).toMatchObject({ status: 'active', activatedBy: 'user' });
  expect(await s.review(sup as number, 'accept')).toBe(false);

  expect(
    await s.review(plain as number, 'accept', {
      text: 'Käyttäjä asuu Tampereella.',
      validTo: '2027-01-01',
    }),
  ).toBe(true);
  expect(rows().get(plain as number)).toMatchObject({
    text: 'Käyttäjä asuu Tampereella.',
    validTo: '2027-01-01',
  });
  expect((await s.relevant('', [])).ids).toEqual([]);
  expect(await s.update(plain as number, { validTo: null })).toBe(true);
  expect(rows().get(plain as number)?.validTo).toBeNull();

  expect(await s.review(auto as number, 'reject')).toBe(true);
  expect(rows().get(auto as number)?.status).toBe('rejected');
  expect(await s.review(old as number, 'reject')).toBe(false);

  expect(s.stale(staleId as number, 'lower')).toBe(true);
  expect(rows().get(staleId as number)?.confidence).toBe(0.7);
  st = s.state();
  if (st.type !== 'claims.state') throw new Error('claims.state expected');
  expect(st.stale).toEqual([]);
  expect(st.precision).toEqual({ accepted: 2, rejected: 1 });
  expect(db.select().from(claims).all()).toHaveLength(5);
});

test('repoint: a vault merge moves links and subjects', async () => {
  const { db, store: s } = store();
  const [id] = await s.add([
    {
      claim: {
        kind: 'relationship',
        text: 'X on käyttäjän ystävä.',
        confidence: 0.9,
        status: 'active',
        subjectEntityId: 3,
      },
      evidence: [],
      entityIds: [3, 5],
    },
  ]);
  s.repoint([3], 5);
  expect(db.select().from(claimEntities).all()).toEqual([
    { claimId: id, entityId: 5, userId: 'aleksi' },
  ]);
  expect(db.select().from(claims).get()?.subjectEntityId).toBe(5);
});
