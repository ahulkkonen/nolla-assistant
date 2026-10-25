import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chats, openDb } from '@pa/db';
import { PseudoClient } from '@pa/pi-ext-pseudo';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { loadModel } from './embeddings.ts';
import { indexChat, related, search, split } from './search.ts';
import { boot, connect, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const t0 = performance.now();
const modelOk = await loadModel().then(
  () => true,
  (err: unknown) => {
    console.warn(
      `search.test: SKIPPED, embedding model not available (download needs network once): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  },
);
const loadMs = performance.now() - t0;

/** [title, summary, user message, assistant message]; all masked text (surrogate names). */
const CORPUS: [string, string, string, string][] = [
  [
    'Veroilmoituksen korjaus',
    'Käyttäjä korjasi esitäytetyn veroilmoituksen OmaVerossa. Kotitalousvähennys puuttui, ja työhuonevähennys lisättiin. Korjausten määräaika on toukokuussa.',
    'Miten korjaan veroilmoitukseni OmaVerossa? Kotitalousvähennys puuttui kokonaan.',
    'Kirjaudu OmaVeroon ja avaa esitäytetty veroilmoitus. Lisää kotitalousvähennys kohtaan vähennykset ja tallenna korjaukset ennen määräaikaa.',
  ],
  [
    'Maratonin harjoitusohjelma',
    'Käyttäjä valmistautuu ensimmäiseen maratoniinsa. Laadittiin 16 viikon harjoitusohjelma pitkine lenkkeineen. Tavoiteaika on alle neljä tuntia.',
    'Teetkö minulle harjoitusohjelman ensimmäiseen maratoniin? Tavoite alle neljä tuntia.',
    'Kuusitoista viikkoa riittää. Pidennä pitkää lenkkiä viikoittain ja pidä yksi lepoviikko joka neljäs viikko.',
  ],
  [
    'Juoksukenkien valinta',
    'Käyttäjä etsi uusia juoksukenkiä maratonharjoitteluun. Keskusteltiin pronaatiosta, vaimennuksesta ja kenkien kulumisesta. Suositeltiin juoksuanalyysiä urheiluliikkeessä.',
    'Millaiset juoksukengät sopivat pitkille lenkeille, kun jalka pronatoi?',
    'Tuettu juoksukenkä ja hyvä vaimennus auttavat pitkillä lenkeillä. Vaihda kengät noin 800 kilometrin välein.',
  ],
  [
    'Maratonin tankkaus ja nesteytys',
    'Käyttäjä kysyi energiasta ja nesteytyksestä maratonin aikana. Käytiin läpi energiageelit, juomapisteet ja hiilihydraattitankkaus ennen kilpailua. Geelejä kokeillaan pitkillä harjoituslenkeillä.',
    'Montako energiageeliä tarvitsen maratonilla, ja pitääkö tankata hiilihydraateilla ennen kisaa?',
    'Ota geeli noin 40 minuutin välein ja juo jokaisella juomapisteellä. Lisää hiilihydraatteja kaksi päivää ennen maratonia ja testaa geelit pitkillä lenkeillä.',
  ],
  [
    'Hapanjuuren ylläpito',
    'Käyttäjä aloitti ruisleivän leipomisen hapanjuurella. Hapanjuuren ruokinta, säilytys jääkaapissa ja taikinan nostatus käytiin läpi. Ensimmäinen leipä onnistui.',
    'Kuinka usein hapanjuurta pitää ruokkia, jos säilytän sitä jääkaapissa?',
    'Jääkaapissa hapanjuuri riittää ruokkia kerran viikossa. Ota se huoneenlämpöön päivää ennen leipomista.',
  ],
  [
    'Asyncio-silmukan virhe',
    'Käyttäjän Python-ohjelma kaatui virheeseen event loop is closed. Syy oli asyncio.run-kutsu toisen silmukan sisällä. Korjauksena käytettiin yhtä pääsilmukkaa.',
    'Saan Pythonissa virheen RuntimeError: Event loop is closed. Mistä se johtuu?',
    'Kutsut asyncio.run-funktiota useasti. Käynnistä yksi pääkorutiini ja odota muita sen sisällä.',
  ],
  [
    'Talvirenkaiden vaihto',
    'Käyttäjä mietti talvirenkaiden vaihdon ajankohtaa. Nastarenkaiden käyttöaika ja urasyvyyden mittaus käytiin läpi. Vaihto sovittiin lokakuun lopulle.',
    'Milloin talvirenkaiden vaihto kannattaa tehdä, ja paljonko urasyvyyttä pitää olla?',
    'Nastarenkaita saa käyttää marraskuusta maaliskuuhun tai kelin vaatiessa. Urasyvyyttä suositellaan vähintään viisi millimetriä.',
  ],
  [
    'Kylpyhuoneremontin aikataulu',
    'Käyttäjä suunnittelee kylpyhuoneremonttia. Urakoitsijana on Pekka Lehtinen. Vedeneristys, laatoitus ja kuivumisajat aikataulutettiin. Remontti kestää noin neljä viikkoa.',
    'Pekka Lehtinen aloittaa kylpyhuoneremontin maanantaina. Paljonko aikaa pitää varata?',
    'Purku, vedeneristys ja laatoitus vievät noin neljä viikkoa kuivumisaikoineen. Pekka Lehtinen voi tarkastaa vedeneristyksen ennen laatoitusta.',
  ],
  [
    'Päiväkotipaikan haku',
    'Käyttäjä haki lapselleen päiväkotipaikkaa kunnasta. Hakemus on jätettävä neljä kuukautta ennen hoidon alkua. Keskusteltiin myös asiakasmaksuista.',
    'Milloin päiväkotipaikkaa pitää hakea, jos hoito alkaa elokuussa?',
    'Hae päiväkotipaikkaa viimeistään neljä kuukautta ennen, eli huhtikuussa. Asiakasmaksu määräytyy perheen tulojen mukaan.',
  ],
  [
    'Lapin matka maaliskuussa',
    'Käyttäjä suunnitteli hiihtolomamatkaa Lappiin maaliskuussa. Vertailtiin Leviä ja Ylläsä sekä yöjunaa ja lentoa. Mökki varattiin Ylläkseltä.',
    'Kumpi on parempi hiihtolomalle maaliskuussa, Levi vai Ylläs?',
    'Ylläs on rauhallisempi ja latuja on enemmän, Levillä on vilkkaampi keskusta. Yöjuna on mukava tapa matkustaa.',
  ],
  [
    'Sähkösopimuksen kilpailutus',
    'Käyttäjä kilpailutti sähkösopimuksensa. Vertailtiin pörssisähköä ja kiinteähintaista sopimusta. Valittiin kiinteä hinta vuodeksi.',
    'Kannattaako ottaa pörssisähkö vai kiinteä sähkösopimus omakotitaloon?',
    'Kiinteä hinta suojaa talven hintapiikeiltä. Pörssisähkö sopii, jos voit siirtää kulutusta halvoille tunneille.',
  ],
  [
    'Työhaastatteluun valmistautuminen',
    'Käyttäjällä on työhaastattelu ohjelmistokehittäjän tehtävään. Harjoiteltiin vastauksia vahvuuksista ja aiemmista projekteista. Palkkatoiveesta keskusteltiin.',
    'Minulla on huomenna työhaastattelu. Miten vastaan kysymykseen heikkouksistani?',
    'Valitse todellinen heikkous ja kerro, miten olet kehittynyt. Valmistele myös kaksi esimerkkiprojektia.',
  ],
  [
    'Kiukaan kivien vaihto',
    'Käyttäjä vaihtoi saunan kiukaan kivet. Kivet pestiin ja ladottiin väljästi. Kiukaan kivien vaihtoväli on noin vuosi kovassa käytössä.',
    'Kuinka usein kiukaan kivet pitää vaihtaa ja miten ne ladotaan?',
    'Kiukaan kivien vaihto kerran vuodessa riittää tiheässä käytössä. Lado isot kivet alas ja jätä ilmarakoja.',
  ],
  [
    'Indeksirahastot ja osakesäästötili',
    'Käyttäjä aloitti säästämisen indeksirahastoihin. Verrattiin osakesäästötiliä ja rahastotiliä sekä kuluja. Kuukausisäästö asetettiin sadaksi euroksi.',
    'Kannattaako indeksirahastot ostaa osakesäästötilille vai suoraan rahastoina?',
    'Osakesäästötilillä voit vaihtaa sijoituksia ilman veroseuraamuksia. Indeksirahastojen kulut ovat pienet.',
  ],
  [
    'Syntymäpäiväjuhlat',
    'Käyttäjä järjestää Liisa Niemiselle syntymäpäiväjuhlat. Suunniteltiin tarjoilut, kakku ja kutsut kahdellekymmenelle vieraalle. Juhlat pidetään lauantaina.',
    'Järjestän Liisa Niemiselle yllätysjuhlat lauantaina. Mitä tarjoaisin kahdellekymmenelle?',
    'Voileipäkakku, salaatti ja täytekakku riittävät. Lähetä kutsut viikkoa ennen ja pyydä vieraita pitämään yllätys salassa.',
  ],
  [
    'Univaikeudet ja melatoniini',
    'Käyttäjällä on ollut univaikeuksia. Käytiin läpi unihygienia, ruutuaika ja melatoniini. Suositeltiin säännöllistä nukkumaanmenoaikaa.',
    'Auttaako melatoniini, kun herään joka yö kolmelta?',
    'Melatoniini auttaa lähinnä rytmin siirtämisessä. Vähennä ruutuaikaa illalla ja pidä makuuhuone viileänä.',
  ],
  [
    'Kissan rokotukset',
    'Käyttäjän kissanpentu tarvitsee rokotukset. Käytiin läpi rokotusohjelma ja tehosteet. Aika varattiin eläinlääkärille.',
    'Mitä rokotuksia kissanpentu tarvitsee ja milloin?',
    'Kissanpentu rokotetaan kissaruttoa ja kissaflunssaa vastaan noin 12 ja 16 viikon iässä. Tehoste annetaan vuoden kuluttua.',
  ],
  [
    'SQL-kyselyn hidastelu',
    'Käyttäjän SQL-kysely oli hidas suurella taululla. EXPLAIN näytti täyden taulukierroksen. Yhdistelmäindeksi nopeutti kyselyä huomattavasti.',
    'Kyselyni kestää kymmenen sekuntia, vaikka taulussa on vain miljoona riviä. Mitä teen?',
    'Aja EXPLAIN ja tarkista, käyttääkö kysely indeksiä. Lisää yhdistelmäindeksi WHERE-ehtojen sarakkeille.',
  ],
  [
    'Tomaattien kasvatus kasvihuoneessa',
    'Käyttäjä kasvattaa tomaatteja kasvihuoneessa. Käytiin läpi kastelu, lannoitus ja sivuversojen poisto. Lehtihomeen torjuntaan suositeltiin tuuletusta.',
    'Tomaattien lehdet kellastuvat kasvihuoneessa. Mikä neuvoksi?',
    'Kellastuminen voi johtua liiasta kastelusta tai typen puutteesta. Tuuleta kasvihuonetta ja poista sivuversot.',
  ],
  [
    'Ruotsin kielen opiskelu',
    'Käyttäjä opiskelee ruotsia työtä varten. Kerrattiin kielioppi, erityisesti verbien taivutus ja sanajärjestys. Suositeltiin päivittäistä harjoittelua.',
    'Ruotsin kielioppi tuntuu vaikealta, varsinkin sanajärjestys. Miten harjoittelen?',
    'Opettele käänteinen sanajärjestys esimerkkilauseista. Kuuntele ruotsinkielisiä podcasteja päivittäin.',
  ],
  [
    'Taloyhtiön yhtiökokous',
    'Käyttäjä valmistautui taloyhtiön yhtiökokoukseen. Esityslistalla olivat putkiremontti ja vastikkeen korotus. Valtakirja laadittiin naapurille.',
    'Taloyhtiön yhtiökokous on ensi viikolla. Voinko valtuuttaa naapurin äänestämään puolestani?',
    'Voit antaa naapurille kirjallisen valtakirjan. Tutustu esityslistaan ja putkiremontin kustannusarvioon etukäteen.',
  ],
  [
    'Polkupyörän vaihteiden säätö',
    'Käyttäjän polkupyörän vaihteet hyppivät. Takavaihtajan vaijerin kireys ja rajoitinruuvit säädettiin. Ketju vaihdettiin kuluneena.',
    'Polkupyörän vaihteet hyppivät ylämäessä. Miten säädän ne?',
    'Kiristä takavaihtajan vaijeria säätöruuvista neljännes kerrallaan. Tarkista ketjun kuluminen mittatyökalulla.',
  ],
  [
    'Hääpuhe ystävälle',
    'Käyttäjä kirjoitti hääpuheen ystävänsä Matti Virtasen häihin. Puheeseen tuli muisto yhteiseltä vaellukselta ja malja hääparille. Puheen pituus on kolme minuuttia.',
    'Kirjoitan bestmanina puheen Matti Virtasen häihin. Miten aloitan?',
    'Aloita lyhyellä muistolla, joka kertoo Matti Virtasesta jotain lämmintä. Päätä malja hääparille.',
  ],
  [
    'Asuntolainan korko',
    'Käyttäjä vertasi asuntolainan korkovaihtoehtoja. Euriboriin sidottu korko ja korkokatto käytiin läpi. Marginaalista neuvoteltiin pankin kanssa.',
    'Kannattaako asuntolainaan ottaa korkokatto, kun euribor nousee?',
    'Korkokatto suojaa nousulta, mutta maksaa. Neuvottele ensin asuntolainan marginaali alas.',
  ],
  [
    'Kameran valotusasetukset',
    'Käyttäjä opetteli kameran manuaalisia valotusasetuksia. Aukko, suljinaika ja ISO käytiin läpi. Harjoiteltiin hämärässä kuvaamista.',
    'Miten aukko ja suljinaika vaikuttavat kuvaan hämärässä?',
    'Suuri aukko päästää enemmän valoa ja pehmentää taustan. Pidempi suljinaika vaatii jalustan.',
  ],
];

const id = (i: number) => `c${String(i + 1).padStart(2, '0')}`;
const USER = 'aleksi';

/** [query, expected chat]. */
const QUERIES: [string, string][] = [
  ['kotitalousvähennys puuttui', 'c01'], // exact phrase
  ['veroilmoitus', 'c01'], // shorter form of an inflected word
  ['hapanjuuri', 'c05'], // inflected in the text
  ['talvirenkaat', 'c07'],
  ['melatoniini', 'c16'], // rare word
  ['indeksirahsto', 'c14'], // misspelling: one letter missing
  ['polkupyörän vaihteet', 'c22'],
  ['kiukaan kivien vaihto', 'c13'],
  ['Pekka Lehtinen', 'c08'], // surrogate name
  ['yhtiökokouksen', 'c21'], // longer inflected form than the text
  ['asuntolainan korko', 'c24'],
  ['aukko ja suljinaika', 'c25'],
  ['tomaatit kasvihuoneessa', 'c19'],
  ['ruotsin kielioppi', 'c20'],
  ['sähkösopimus', 'c11'],
  ['kuinka valmistaudun 42 kilometrin juoksukisaan', 'c02'], // paraphrases: vector path
  ['nukun huonosti ja heräilen öisin', 'c16'],
  ['lemmikin piikit eläinlääkärillä', 'c17'],
  ['tietokannan haku on hidas', 'c18'],
  ['puhe ystävän häissä', 'c23'],
];

const dir = mkdtempSync(join(tmpdir(), 'pa-search-'));
const { db, sqlite } = openDb(join(dir, 'app.db'));
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  if (!modelOk) return;
  const now = new Date().toISOString();
  db.insert(chats)
    .values(
      CORPUS.map(([title, summary], i) => ({
        id: id(i),
        userId: USER,
        title,
        titleMasked: title,
        summary,
        sessionPath: `sessions/${USER}/`,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run();
  const t = performance.now();
  for (const [i, [, , u, a]] of CORPUS.entries())
    await indexChat(db, USER, id(i), [
      { id: `${id(i)}-u`, text: u },
      { id: `${id(i)}-a`, text: a },
    ]);
  console.log(
    `search.test: model load ${loadMs.toFixed(0)} ms, index 25 chats ${(performance.now() - t).toFixed(0)} ms, rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB`,
  );
}, 120_000);

test('split packs paragraphs into chunks of at most 1600 chars', () => {
  const para = 'a'.repeat(1000);
  expect(split(`${para}\n\n${para}`)).toEqual([para, para]);
  expect(split('x\n\ny')).toEqual(['x\n\ny']);
  expect(split('b'.repeat(3300)).map((c) => c.length)).toEqual([1600, 1600, 100]);
});

test.skipIf(!modelOk)('20 scripted queries find the right chat', async () => {
  let first = 0;
  let ms = 0;
  const misses: string[] = [];
  const top3: string[] = [];
  for (const [q, want] of QUERIES) {
    const t = performance.now();
    const results = await search(db, USER, q, 20);
    ms += performance.now() - t;
    const rank = results.findIndex((r) => r.chatId === want);
    if (rank === 0) first++;
    else misses.push(`${q} → rank ${rank + 1}: ${results[0]?.chatId}`);
    if (rank < 0 || rank > 2) top3.push(q);
  }
  console.log(
    `search.test: rank 1 for ${first}/20, mean query ${(ms / 20).toFixed(1)} ms${misses.length ? `; misses: ${misses.join('; ')}` : ''}`,
  );
  expect(top3).toEqual([]);
  expect(first).toBeGreaterThanOrEqual(18);

  const [hit] = await search(db, USER, 'kotitalousvähennys', 5);
  expect(hit).toMatchObject({ chatId: 'c01', title: 'Veroilmoituksen korjaus' });
  expect(hit?.snippet).toContain('**Kotitalousvähennys**');
  expect(hit?.snippet.length).toBeLessThanOrEqual(200);
});

test.skipIf(!modelOk)(
  'reindexing adds only new messages and replaces a changed summary',
  async () => {
    const count = () =>
      sqlite.prepare("SELECT count(*) AS n FROM chunks WHERE chatId = 'c06'").get() as {
        n: number;
      };
    const before = count().n;
    await indexChat(db, USER, 'c06', [
      { id: 'c06-u', text: CORPUS[5]?.[2] ?? '' },
      { id: 'c06-a', text: CORPUS[5]?.[3] ?? '' },
      { id: 'c06-u2', text: 'Kiitos, toimii nyt.' },
    ]);
    expect(count().n).toBe(before + 1);
    const fts = sqlite.prepare("SELECT count(*) AS n FROM chat_fts WHERE chat_id = 'c06'");
    const vec = sqlite.prepare(
      "SELECT count(*) AS n FROM chunk_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE chatId = 'c06')",
    );
    expect(fts.get()).toEqual({ n: before + 1 });
    expect(vec.get()).toEqual({ n: before + 1 });

    db.update(chats).set({ summary: 'Uusi tiivistelmä.' }).where(eq(chats.id, 'c06')).run();
    await indexChat(db, USER, 'c06');
    expect(count().n).toBe(before + 1);
    expect(
      sqlite.prepare("SELECT text FROM chunks WHERE chatId = 'c06' AND kind = 'summary'").all(),
    ).toEqual([{ text: 'Uusi tiivistelmä.' }]);
    expect(fts.get()).toEqual({ n: before + 1 });
  },
);

test.skipIf(!modelOk)('related lists the two running chats, not an unrelated one', () => {
  const rel = related(db, USER, 'c02');
  console.log(
    `search.test: related(c02) ${JSON.stringify(rel.map((r) => [r.chatId, +r.score.toFixed(3)]))}`,
  );
  const ids = rel.map((r) => r.chatId);
  expect(ids).toContain('c03');
  expect(ids).toContain('c04');
  expect(ids).not.toContain('c01');
  expect(ids).not.toContain('c02');
  expect(rel.length).toBeLessThanOrEqual(3);
  for (const r of rel) expect(r.score).toBeGreaterThanOrEqual(0.6);
  expect(related(db, USER, 'nope')).toEqual([]);
});

test.skipIf(!modelOk)('the query is masked and the snippet restored', async () => {
  const sc = await startFakeSidecar({ 'Jussi Mäkelä': 'Pekka Lehtinen' });
  try {
    const [hit] = await search(db, USER, 'Jussi Mäkelä', 5, new PseudoClient(sc.url, USER));
    expect(sc.requests.find((r) => r.path === '/mask')?.body.text).toBe('Jussi Mäkelä');
    expect(hit?.chatId).toBe('c08');
    expect(hit?.snippet).toContain('**Jussi** Mäkelä');
    expect(hit?.snippet).not.toContain('Pekka');
  } finally {
    await sc.close();
  }
});

test.skipIf(!modelOk)('search.query and chat.related over the socket', async () => {
  const b = await boot([]);
  await b.run();
  const c = await connect(b.config.port);
  c.send({ type: 'search.query', q: 'ei osumia' });
  expect(await c.next('search.results')).toEqual({
    type: 'search.results',
    q: 'ei osumia',
    results: [],
  });
  c.send({ type: 'chat.create' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'chat.related', chatId: chat.id });
  expect(await c.next('chat.related')).toEqual({
    type: 'chat.related',
    chatId: chat.id,
    related: [],
  });
});
