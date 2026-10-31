import { createECDH } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { startFakeBroker } from '@pa/pi-ext-sandbox/fake-broker';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';
import { seedAgents } from '@pa/server/src/test-utils.ts';
import { type Browser, test as base, expect, type Page } from '@playwright/test';
import { WEB } from './global-setup.ts';

export const PASSWORD = 'salasana';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const VAPID = {
  publicKey: ecdh.getPublicKey('base64url'),
  privateKey: ecdh.getPrivateKey('base64url'),
};

/** Grants notifications and fakes `PushManager` in the page (no real push service in tests). */
export const mockPush = (page: Page) =>
  page.addInitScript(() => {
    const sub = {
      endpoint: 'https://push.example.test/sub/1',
      toJSON() {
        return {
          endpoint: this.endpoint,
          expirationTime: null,
          keys: {
            p256dh:
              'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        };
      },
      unsubscribe: async () => true,
    };
    let subscribed = false;
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.subscribe = async function () {
      subscribed = true;
      return sub as unknown as PushSubscription;
    };
    PushManager.prototype.getSubscription = async function () {
      return subscribed ? (sub as unknown as PushSubscription) : null;
    };
  });

/**
 * A tone from an oscillator as the microphone. Chromium's `--use-fake-device-for-media-stream`
 * never resolves `getUserMedia` in the macOS headless shell, so the page gets its own stream.
 */
export const mockMic = (page: Page) =>
  page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
  });

/** A solid RGB PNG (default 64 × 64 grey). */
export const png = (rgb: [number, number, number] = [128, 128, 128], w = 64, h = 64) => {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const x of body) c = (crcT[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Synthetic work-dir files for Tiedostot (`workFiles: true`): no real names or data. */
export const WORK_FILES: Record<string, string | Buffer> = {
  'Raportit/Raportti 2.md':
    '# Raportti 2\n\nKuukauden luvut kasvoivat hieman.\n\n- Myynti: 120\n- Kulut: 80\n',
  'Raportit/Raportti 10.md': '# Raportti 10\n\nVuoden yhteenveto.\n',
  'Raportit/luonnos.txt': 'Luonnos seuraavaa raporttia varten.\n',
  'Kuvat/kaavio.png': png([64, 120, 200], 320, 200),
  'muistiinpanot.md':
    '# Muistiinpanot\n\n## Tehtävät\n\n- Kokoa kuukauden luvut\n- Kirjoita yhteenveto\n\nLuvut ovat taulukossa `tulokset.csv`.\n',
  'tulokset.csv':
    'kuukausi,myynti,kulut\ntammikuu,120,80\nhelmikuu,135,82\nmaaliskuu,128,90\nhuhtikuu,141,88\n',
  'laskuri.py':
    'def summa(luvut):\n    """Laskee lukujen summan."""\n    return sum(luvut)\n\n\nprint(summa([1, 2, 3]))\n',
  'esittely.html':
    '<!doctype html><html lang="fi"><body><h1>Esittely</h1><p>Tämä sivu näkyy hiekkalaatikossa.</p></body></html>',
  'kansikuva.png': png([217, 119, 87], 480, 300),
  'arkisto.zip': Buffer.from([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]),
  // Five levels: the breadcrumb collapses its middle.
  'Projektit/2026/Syksy/Lokakuu/Viikko 43/muistio.txt': 'Viikon muistio.\n',
};
/** One fixed time for every seeded entry, so the screenshots keep their dates. */
const SEEDED_AT = new Date('2026-10-25T14:20:00Z');

function seedWork(dir: string) {
  for (const [path, body] of Object.entries(WORK_FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    utimesSync(join(dir, path), SEEDED_AT, SEEDED_AT);
  }
  // Folders last: writing a file changes its folder's time.
  for (const path of Object.keys(WORK_FILES))
    for (let d = dirname(path); d !== '.'; d = dirname(d))
      utimesSync(join(dir, d), SEEDED_AT, SEEDED_AT);
}

/** An assistant reply with one HTML block (an artifact). */
export const HTML_REPLY =
  'Tässä sivu:\n\n```html\n<h1>Hei artefakti</h1>\n<p>Tämä sivu toimii hiekkalaatikossa.</p>\n```';
const block = (lang: string, body: unknown) =>
  `\`\`\`${lang}\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}\n\`\`\``;
const MONTHS = 'tammi helmi maalis huhti touko kesä heinä elo syys loka marras joulu'.split(' ');
const KWH = [452, 401, 356, 270, 198, 142, 131, 150, 214, 298, 365, 393];
/** Phase 19: a bar chart with a lifted title, subtitle and caption (R1) and a colour role (R7). */
export const CHART_REPLY = `Tässä kulutus kuukausittain:\n\n${block('vega-lite', {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  title: {
    text: 'Sähkönkulutus kuukausittain 2025',
    subtitle: 'Talven kuukaudet kuluttivat **yli kolme kertaa** kesän verran.',
  },
  description: 'Pylväskaavio kotitalouden sähkönkulutuksesta kuukausittain vuonna 2025.',
  usermeta: { caption: 'Lähde: sähköyhtiön kulutusraportti, yhteensä 3 370 kWh.' },
  data: { values: MONTHS.map((kk, i) => ({ kk, kWh: KWH[i] })) },
  mark: 'bar',
  encoding: {
    x: { field: 'kk', type: 'ordinal', sort: null, title: null },
    y: { field: 'kWh', type: 'quantitative', title: 'Kulutus (kWh)' },
    color: { value: '@accent' },
  },
  config: { font: 'Comic Sans MS' },
})}\n\nTammikuu oli vuoden kulutetuin kuukausi.`;
const PRICES = [
  [5210, 3890],
  [5185, 3905],
  [5160, 3920],
  [5190, 3940],
  [5230, 3960],
  [5260, 3985],
];
/** Phase 19: two series with dates, colour roles and direct end labels (R3 padding right 44). */
export const LINE_REPLY = `Hinnat kehittyivät näin:\n\n${block('vega-lite', {
  title: { text: 'Asuntojen neliöhinnat 2026', subtitle: 'Vanhat kerrostaloasunnot, €/m²' },
  description: 'Viivakaavio kahden kaupungin asuntojen neliöhinnoista tammi–kesäkuussa 2026.',
  data: {
    values: PRICES.flatMap(([a, b], i) => [
      { kk: `2026-0${i + 1}-01`, kaupunki: 'Helsinki', hinta: a },
      { kk: `2026-0${i + 1}-01`, kaupunki: 'Tampere', hinta: b },
    ]),
  },
  encoding: {
    x: { field: 'kk', type: 'temporal', title: null, axis: { format: '%b', tickCount: 6 } },
    y: { field: 'hinta', type: 'quantitative', title: 'Hinta (€/m²)', scale: { zero: false } },
    color: {
      field: 'kaupunki',
      type: 'nominal',
      scale: { range: ['@accent', '@c2'] },
      legend: null,
    },
  },
  layer: [
    { mark: { type: 'line', color: '#ff0000' } },
    {
      transform: [{ filter: 'month(datum.kk) == 5' }],
      mark: { type: 'text', align: 'left', dx: 6 },
      encoding: { text: { field: 'kaupunki' } },
    },
  ],
})}\n\nHelsingin hinnat nousivat kesäkuuhun mennessä noin prosentin.`;
const SPOT = [
  [9.1, 6.2, 11.4],
  [8.4, 5.9, 10.8],
  [6.2, 5.1, 9.6],
  [4.8, 4.6, 8.9],
  [3.9, 4.2, 8.1],
  [3.1, 4.4, 7.7],
];
/** Phase 20: a multi-series line chart, one series in `@accent`, the context in `@faint`. */
export const SERIES_REPLY = `Hinnat kehittyivät näin:\n\n${block('vega-lite', {
  title: {
    text: 'Pörssisähkön hinta 2026',
    subtitle: 'Suomen hinta **laski** keväällä naapurimaita nopeammin.',
  },
  description: 'Viivakaavio pörssisähkön kuukausihinnasta Suomessa, Ruotsissa ja Virossa 2026.',
  usermeta: { caption: 'Lähde: kuukausikeskiarvot, snt/kWh.' },
  data: {
    values: SPOT.flatMap((row, i) =>
      ['Suomi', 'Ruotsi', 'Viro'].map((maa, j) => ({
        kk: `2026-0${i + 1}-01`,
        maa,
        hinta: row[j],
      })),
    ),
  },
  encoding: {
    x: { field: 'kk', type: 'temporal', title: null, axis: { format: '%b', tickCount: 6 } },
    y: { field: 'hinta', type: 'quantitative', title: 'snt/kWh' },
    color: {
      field: 'maa',
      type: 'nominal',
      scale: { domain: ['Suomi', 'Ruotsi', 'Viro'], range: ['@accent', '@faint', '@faint'] },
      legend: null,
    },
  },
  layer: [
    { mark: 'line' },
    {
      transform: [{ filter: 'month(datum.kk) == 5' }],
      mark: { type: 'text', align: 'left', dx: 6 },
      encoding: {
        text: { field: 'maa' },
        color: { condition: { test: "datum.maa === 'Suomi'", value: '@accent' }, value: '@muted' },
      },
    },
  ],
})}\n\nSuomen hinta oli kesäkuussa alin.`;
/** Phase 19: a refused spec (R6): a `url` in a transform; the fallback shows the inline rows. */
export const REFUSED_REPLY = `Kaavio:\n\n${block('vega-lite', {
  title: 'Haettu data',
  data: {
    values: [
      { tuote: 'Kahvi', kpl: 12 },
      { tuote: 'Tee', kpl: 7 },
    ],
  },
  transform: [
    { lookup: 'tuote', from: { data: { url: 'https://example.com/x.csv' }, key: 'tuote' } },
  ],
  mark: 'bar',
  encoding: { x: { field: 'tuote' }, y: { field: 'kpl', type: 'quantitative' } },
})}`;
/** Phase 19: a flowchart with accTitle, accDescr and a quoted "kesä" label. */
export const MERMAID_REPLY = `Suunnitelma:\n\n${block(
  'mermaid',
  `flowchart TD
  accTitle: Lomasuunnitelma
  accDescr: Kesäloman suunnittelun vaiheet ideasta varaukseen.
  A["Idea: kesä"] --> B["Budjetti"]
  B --> C{"Mökki vai matka?"}
  C -->|"Mökki"| D["Varaa mökki"]
  C -->|"Matka"| E["Varaa liput"]`,
)}`;
/**
 * Phase 20: a flowchart with the user's subgraph title, two edges into the subgraph from above,
 * and every colour class (no classDef): `ok` on the subgraph band, `muted` outside it. Phase 21:
 * an emoji first in a label, and an edge that skips a row (A to C).
 */
export const NWP_REPLY = `Ennuste syntyy näin:\n\n${block(
  'mermaid',
  `flowchart TD
  accTitle: Sääennusteen tuotanto
  A["🛰️ Havainnot"]:::cool --> B
  A --> C
  subgraph NWP["3. Numeerinen sääennustus (NWP)"]
    B["Data-assimilaatio"] --> C["Malliajo"]:::ok
  end
  C --> D{"Laatu kunnossa?"}
  D -->|"Kyllä"| E["Ennuste julki"]:::warm
  D -.->|"Ei"| F["Hälytys päivystäjälle"]:::alert
  E --> G["Arkisto"]:::muted`,
)}`;
/** Phase 19: an HTML artifact on the design kit: `.card`, `.stat`, `.callout` and a Plot chart. */
export const KIT_REPLY = `Tässä yhteenveto:\n\n${block(
  'html',
  `<h1>Vedenkulutus viikolla 43</h1>
<p>Viikon kulutus pysyi tavoitteessa. Suurin kulutus osui lauantaille.</p>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">
  <div class="card stat"><span class="value">812 l</span><span class="label">Viikon kulutus</span></div>
  <div class="card stat"><span class="value">116 l</span><span class="label">Keskimäärin päivässä</span></div>
</div>
<div class="callout info">Tavoite on alle 120 litraa päivässä.</div>
<figure id="kaavio"><figcaption>Päivittäinen kulutus litroina.</figcaption></figure>
<script>
const data = [['ma', 104], ['ti', 98], ['ke', 121], ['to', 110], ['pe', 117], ['la', 149], ['su', 113]]
  .map(([pv, l]) => ({ pv, l }));
document.getElementById('kaavio').prepend(Plot.plot({
  width: document.body.clientWidth - 32, height: 200, marginLeft: 40,
  x: { label: null, domain: data.map((d) => d.pv) }, y: { label: 'Litraa', grid: true },
  marks: [Plot.barY(data, { x: 'pv', y: 'l', fill: 'var(--chart-1)' }), Plot.ruleY([0])],
}));
</script>`,
)}`;
const KEY = 'sk-e2e-master';

const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
};

/** Real values and the surrogates the model sees, for `pseudo: true`. */
export const DICT = {
  'Matti Virtanen': 'Pekka Laaksonen',
  'Liisa Korhonen': 'Anna Mäkinen',
  '010190-123M': '010190-900B',
};

/**
 * A reply of a thinking model with its usage (phase 13): the reasoning streams first and lasts
 * `thinkMs`; the cost is OpenRouter's billed USD in the usage chunk (0,012 € at the fake's rate).
 */
export const THINKING_TURN = {
  text: 'Kevät on hyvä aika aloittaa, kun maa on sula.',
  reasoning:
    'Käyttäjä kysyy aloitusajasta. Mietin ensin säätä ja maata. Sitten vertailen kevättä ja syksyä.',
  thinkMs: 1500,
  // 2,542 of the 3,100 prompt tokens from the cache: "välimuisti 82 %" (phase 16).
  usage: {
    prompt_tokens: 3100,
    completion_tokens: 300,
    reasoning_tokens: 120,
    cached_tokens: 2542,
    cost: 0.0134,
  },
};

/**
 * Phase 14: a web search the model asks for, and its reply; `zdr/search` answers with the fake's
 * two weather citations. With the sidecar on, the last user message of a chat call is the memory
 * block, so these turns cannot match; the title job gets its own matched turn (`Aiheet:`).
 */
export const searchTurns = (app: App, query: string, reply: string) => {
  app.llm.push({ toolCalls: [{ name: 'web_search', args: { query } }] });
  app.llm.push({ text: reply });
  app.llm.push({ ...titleTurn('Sää', 'Käyttäjä kysyi säästä.'), match: 'Aiheet:' });
};

/** Phase 25: the assistant's prompt in the run's own copy of the agents. */
export const promptOf = (app: App) =>
  readFileSync(join(app.dataDir, 'agents/prompts/assistant.md'), 'utf8');

/**
 * Phase 25: a prompt change whose diff is one hunk of 18 lines, over the card's 13-line clamp: the
 * first line changes and a style list follows the language line.
 */
export const promptEdit = (before: string) =>
  before
    .replace('Autat arjen asioissa,', 'Autat arjen asioissa, opiskelussa,')
    .replace(
      'kirjoittaa.\n',
      'kirjoittaa.\n\n## Tyyli\n\n- Vastaa ensin lyhyesti, perustele sitten.\n- Käytä luetteloa, kun vaiheita on yli kolme.\n- Älä toista kysymystä vastauksen alussa.\n- Kerro epävarmuudesta yhdellä lauseella.\n',
    );

/** The surrogate of Matti Virtanen, typed as a real person's name: a collision (phase 12). */
export const COLLIDING = 'Pekka Laaksonen';

export type App = {
  url: string;
  dataDir: string;
  llm: Awaited<ReturnType<typeof startFakeLlm>>;
  login: (page: Page) => Promise<void>;
};

/** One automation for `automation: true` (never fires by itself: 1 January at 03:00). */
export const AUTOMATION = `id: aamu
cron: '0 3 1 1 *'
agentId: assistant
prompt: Anna lyhyt aamukatsaus.
deliver: chat
`;

export const test = base.extend<{
  app: App;
  pseudo: 'off' | 'full' | 'empty' | 'collision';
  automation: boolean;
  approvalTimeoutMs: number;
  memoryUser: string;
  workFiles: boolean;
  broker: boolean;
}>({
  // Starts the fake sidecar and sets PSEUDO_URL: `full` has DICT plus one pending item;
  // `collision` has DICT, and typing COLLIDING holds the message (phase 12).
  pseudo: ['off', { option: true }],
  // Writes AUTOMATION into the run's own AUTOMATIONS_DIR (always a temp dir, empty by default).
  automation: [false, { option: true }],
  // 0 keeps the server default (10 minutes).
  approvalTimeoutMs: [0, { option: true }],
  // Written to DATA_DIR/memory/aleksi/USER.md before start when non-empty.
  memoryUser: ['', { option: true }],
  // Seeds DATA_DIR/work/aleksi with WORK_FILES.
  workFiles: [false, { option: true }],
  // The fake sandbox broker (runs `bash` on the host, in the work dir): the `bash` tool exists.
  broker: [false, { option: true }],
  app: async ({ pseudo, automation, approvalTimeoutMs, memoryUser, workFiles, broker }, use) => {
    const llm = await startFakeLlm([]);
    const sidecar =
      pseudo === 'off'
        ? undefined
        : pseudo === 'empty'
          ? await startFakeSidecar({})
          : pseudo === 'collision'
            ? await startFakeSidecar(DICT, { collide: [COLLIDING] })
            : await startFakeSidecar(DICT, {
                pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.42 }],
              });
    const dataDir = mkdtempSync(join(tmpdir(), 'pa-e2e-'));
    mkdirSync(join(dataDir, 'work/aleksi'), { recursive: true });
    if (workFiles) seedWork(join(dataDir, 'work/aleksi'));
    const fakeBroker = broker
      ? await startFakeBroker({ token: 'broker-e2e', root: join(dataDir, 'work/aleksi') })
      : undefined;
    mkdirSync(join(dataDir, 'automations'));
    // The repository's agents plus a second profile for the picker and editor tests.
    seedAgents(join(dataDir, 'agents'));
    if (automation) writeFileSync(join(dataDir, 'automations/aamu.yaml'), AUTOMATION);
    if (memoryUser) {
      mkdirSync(join(dataDir, 'memory/aleksi'), { recursive: true });
      writeFileSync(join(dataDir, 'memory/aleksi/USER.md'), memoryUser);
    }
    const port = await freePort();
    process.env.LITELLM_MASTER_KEY = KEY;
    const srv = await start(
      loadConfig({
        DATA_DIR: dataDir,
        MODELS_DIR: process.env.MODELS_DIR,
        LITELLM_URL: llm.url,
        LITELLM_MASTER_KEY: KEY,
        // Model catalog from the fake (phase-10): Auto is a catalog model.
        OPENROUTER_CATALOG: llm.url,
        ECB_RATES: llm.url,
        AUTH_ORIGIN: `http://127.0.0.1:${port}`,
        COOKIE_SECRET: 'e'.repeat(40),
        AUTH_PASSWORD_HASH: await hashPassword(PASSWORD),
        WEB_DIST: join(WEB, 'dist'),
        HOST: '127.0.0.1',
        PORT: String(port),
        USER_ID: 'aleksi',
        LOG_LEVEL: 'warn',
        AUTOMATIONS_DIR: join(dataDir, 'automations'),
        // The editor tests write to this copy.
        AGENTS_DIR: join(dataDir, 'agents'),
        // Push on, any endpoint host: the browser side is mocked (see `mockPush`).
        VAPID_PUBLIC: VAPID.publicKey,
        VAPID_PRIVATE: VAPID.privateKey,
        VAPID_SUBJECT: 'mailto:e2e@example.com',
        PUSH_ALLOW_ANY_HOST: '1',
        ...(approvalTimeoutMs ? { APPROVAL_TIMEOUT_MS: String(approvalTimeoutMs) } : {}),
        ...(sidecar ? { PSEUDO_URL: sidecar.url } : {}),
        ...(fakeBroker ? { BROKER_URL: fakeBroker.url, BROKER_TOKEN: 'broker-e2e' } : {}),
      }),
    );
    const url = `http://127.0.0.1:${port}`;
    const login = async (page: Page) => {
      await page.goto(`${url}/`);
      await page.getByLabel('Salasana').fill(PASSWORD);
      await page.getByRole('button', { name: 'Kirjaudu', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Uusi keskustelu' }).first()).toBeVisible();
    };
    await use({ url, dataDir, llm, login });
    await srv.close();
    await llm.close();
    await sidecar?.close();
    await fakeBroker?.close();
    rmSync(dataDir, { recursive: true, force: true });
  },
  baseURL: async ({ app }, use) => use(app.url),
});

/**
 * Holds the server's frames from the delta after which the streamed text contains `text`, until
 * `release()`: the reply stays mid-stream, the run active (phase 20). Once only; call it before
 * the page opens the WebSocket.
 */
export const holdAt = async (page: Page, text: string) => {
  let streamed = '';
  let armed = true;
  let holding = false;
  const held: (string | Buffer)[] = [];
  let deliver: (m: string | Buffer) => void = () => {};
  let seen: () => void = () => {};
  const reached = new Promise<void>((r) => (seen = r));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    deliver = (m) => ws.send(m);
    server.onMessage((m) => {
      if (holding) return void held.push(m);
      ws.send(m);
      const msg = typeof m === 'string' ? JSON.parse(m) : undefined;
      if (armed && msg?.type === 'message.delta' && (streamed += msg.text).includes(text)) {
        armed = false;
        holding = true;
        seen();
      }
    });
  });
  return {
    reached,
    release: () => {
      holding = false;
      for (const m of held.splice(0)) deliver(m);
    },
  };
};

/** Phase-21 decision 4: a reply with confidence markers at three levels (9, 5, 1). */
export const CONFIDENCE_REPLY =
  'Tampere on Suomen kolmanneksi suurin kaupunki.⟦9⟧ Sen väkiluku kasvaa ensi vuonna noin prosentin.⟦7⟧ Raitiotie jatkunee Hiedanrantaan vuonna 2031.⟦3⟧';
export const CONFIDENCE_PLAIN =
  'Tampere on Suomen kolmanneksi suurin kaupunki. Sen väkiluku kasvaa ensi vuonna noin prosentin. Raitiotie jatkunee Hiedanrantaan vuonna 2031.';

/**
 * What a reader sees of CONFIDENCE_REPLY: the N of a sentence up to 6 is in the line (phase-28
 * decision 3); the other N are hidden (phase-23 decision 9).
 */
export const CONFIDENCE_SHOWN =
  'Tampere on Suomen kolmanneksi suurin kaupunki. Sen väkiluku kasvaa ensi vuonna noin prosentin. Raitiotie jatkunee Hiedanrantaan vuonna 2031.3';

/** A new chat with CONFIDENCE_REPLY; its Markdown root once the text shows. */
export const confidenceReply = async (app: App, page: Page) => {
  app.llm.push({ text: CONFIDENCE_REPLY });
  await app.login(page);
  await sendMessage(page, 'Kerro Tampereesta');
  const reply = page.locator('.md').last();
  await expect(reply).toHaveText(CONFIDENCE_SHOWN, { useInnerText: true });
  return reply;
};

/** Phase 20: an HTML page written in a reply, with a title the writing card can show. */
export const PAGE_REPLY = `Tässä sivu:\n\n${block(
  'html',
  `<!doctype html>
<html lang="fi">
<head><title>Kuukausiraportti</title></head>
<body>
<h1>Raportti lokakuulta</h1>
<p>Kulut pysyivät budjetissa.</p>
<p>Tulot kasvoivat hieman.</p>
</body>
</html>`,
)}\n\nSivu on valmis.`;

/** Opens Tiedostot from the sidebar (the drawer under 768 px). */
export const openFiles = async (page: Page) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Tiedostot', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Näkymä' })).toBeVisible();
};

/** Opens a settings entry; settings sits in the drawer under 768 px, in the sidebar above. */
export const openSettings = async (
  page: Page,
  entry:
    | 'Nimisuoja'
    | 'Aiheet'
    | 'Agentit'
    | 'Automaatiot'
    | 'Muisti'
    | 'Käyttö'
    | 'Laitteet'
    | 'Asetukset',
) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Asetukset' }).click();
  // 'Asetukset' only opens the dialog.
  if (entry !== 'Asetukset') await page.getByRole('button', { name: entry }).click();
};
export const openVault = (page: Page) => openSettings(page, 'Nimisuoja');

/** Agentit › Toiminnot › Muokkaa of the agent `name`; the form shows its name. */
export const editAgent = async (page: Page, name: string) => {
  await openSettings(page, 'Agentit');
  await page.getByRole('button', { name: `Toiminnot: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Muokkaa' }).click();
  await expect(page.getByLabel('Nimi', { exact: true })).toHaveValue(name);
};

/** A second signed-in browser (Laitteet); close `context` at the end. */
export const secondDevice = async (app: App, browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await app.login(page);
  return { context, page };
};

/** Laitteet on `page` with two sessions: their rows. */
export const deviceRows = async (page: Page) => {
  await openSettings(page, 'Laitteet');
  const rows = page.getByRole('region', { name: 'Kirjautuneet laitteet' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  return rows;
};

/** Automaatiot › Uusi automaatio, filled in for "Arkisin klo 7.30"; the next-runs list. */
export const newAutomation = async (page: Page) => {
  await openSettings(page, 'Automaatiot');
  await page.getByRole('button', { name: 'Uusi automaatio' }).click();
  await page.getByLabel('Nimi', { exact: true }).fill('Aamukatsaus');
  await page.getByLabel('Ohje', { exact: true }).fill('Anna lyhyt aamukatsaus.');
  await page
    .getByRole('group', { name: 'Aikataulu' })
    .getByRole('button', { name: 'Arkisin' })
    .click();
  await page.getByLabel('Kellonaika').fill('07:30');
  const runs = page.getByRole('list', { name: 'Seuraavat ajot' }).getByRole('listitem');
  await expect(runs).toHaveCount(5);
  return runs;
};

/** The reply of the title job (non-streaming `zdr/task-small` call), queued after the chat turn. */
export const titleTurn = (
  title: string,
  summary: string,
  proposed: { name: string; why: string } | null = null,
): FakeTurn => ({
  text: JSON.stringify({ title, topics: [], proposed_topic: proposed, summary }),
});

export const sendMessage = async (page: Page, text: string) => {
  await page.getByLabel('Viesti').fill(text);
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
};

/** Signed in, with one chat: "Moi" and the reply "Hei.". */
export const helloChat = async (app: App, page: Page) => {
  app.llm.push({ text: 'Hei.' });
  await app.login(page);
  await sendMessage(page, 'Moi');
  await expect(page.locator('.md').last()).toHaveText('Hei.');
};

/** Sidebar search: Enter runs the full-text search. */
export const search = async (page: Page, q: string) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByLabel('Hae keskusteluja').fill(q);
  await page.getByLabel('Hae keskusteluja').press('Enter');
};

export const TAX = {
  ask: 'Milloin veroilmoituksen määräaika on?',
  reply: 'Määräaika on toukokuussa, tarkista päivä OmaVerosta.',
  title: 'Veroilmoituksen määräaika',
  summary:
    'Käyttäjä kysyi veroilmoituksen määräaikaa. Määräaika on toukokuussa. Päivän voi tarkistaa OmaVerosta.',
  topic: { name: 'Verot', why: 'Veroilmoitukset ja verotus.' },
};

/** One tax chat: reply, title with a proposed topic; waits until the title shows. */
export async function taxChat(app: App, page: Page) {
  app.llm.push({ text: TAX.reply });
  app.llm.push(titleTurn(TAX.title, TAX.summary, TAX.topic));
  await sendMessage(page, TAX.ask);
  await expect(page.locator('.md').last()).toHaveText(TAX.reply);
  // Under 768 px the title shows in the top bar; above, in the sidebar.
  await expect(page.getByText(TAX.title, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
}

/** Opens the drawer under 768 px; the sidebar is already visible above. */
export const showSidebar = async (page: Page) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
};

/**
 * Turns the chat switch `name` (phase 21) to `on`: its composer chip ≥ 768; on phones its row in
 * the model sheet, which then closes.
 */
export const flip = async (page: Page, name: string, on: boolean) => {
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  if (phone) await page.getByRole('button', { name: /^Malli: / }).click();
  const control = page.getByRole(phone ? 'switch' : 'button', { name, exact: true });
  const state = phone ? 'aria-checked' : 'aria-pressed';
  await expect(control).toHaveAttribute(state, String(!on));
  await control.click();
  await expect(control).toHaveAttribute(state, String(on));
  if (!phone) return;
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Mallin valinta' })).toHaveCount(0);
};

/**
 * Turns the output mode `name` (phase-23 decision 8) to `on`: its check box in the Tila chip's
 * menu ≥ 768, which stays open after the toggle and then closes; on phones its row in the model
 * sheet (`flip`).
 */
export const flipMode = async (page: Page, name: string, on: boolean) => {
  if ((page.viewportSize()?.width ?? 1280) < 768) return flip(page, name, on);
  await page.getByRole('button', { name: /^Tila/ }).click();
  const item = page.getByRole('menuitemcheckbox', { name: new RegExp(`^${name}`) });
  await expect(item).toHaveAttribute('aria-checked', String(!on));
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', String(on));
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
};

/** Accepts the first topic proposal. */
export async function acceptProposal(page: Page) {
  const inbox = page.getByRole('region', { name: 'Ehdotukset' });
  await expect(inbox.getByRole('listitem').first()).toBeVisible();
  // "Hyväksy" is a visible button on every width; the rest of the actions are in ⋯.
  await inbox.getByRole('button', { name: 'Hyväksy', exact: true }).first().click();
  await expect(page.getByText('Ei ehdotuksia.')).toBeVisible();
}

export const USER_MD = 'Asun Tampereella.\nPidän lyhyistä vastauksista.\nKirjoita suomeksi.';

/** One agent run: an untainted `memory add`, or (`tainted`) a `recall` first, which parks it. */
/** An agent write to USER.md (phase 17: target `memory` writes claims, not a file). */
export function memoryTurns(app: App, text: string, tainted = false) {
  if (tainted) app.llm.push({ toolCalls: [{ name: 'recall', args: { query: 'väri' } }] });
  app.llm.push({
    toolCalls: [{ name: 'memory', args: { action: 'add', target: 'user', text } }],
  });
  app.llm.push({ text: 'Selvä, muistan.' });
}

export { expect };

const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

/**
 * Phase-17 claims written straight into `app.db` (extraction needs a 20-minute idle chat). Each
 * quote points at `chatId`. Returns the ids by name. `claims.list` reads them on the next open.
 */
export function seedClaims(app: App, chatId: string) {
  const db = new DatabaseSync(join(app.dataDir, 'app.db'));
  const claim = db.prepare(
    `INSERT INTO claims (userId, kind, text, confidence, status, activatedBy, validFrom, validTo,
      recordedAt, supersedesId, sourceChatId, lastConfirmedAt, timesSeen, reviewedAt)
     VALUES ('aleksi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const quote = db.prepare(
    `INSERT INTO evidence (userId, claimId, chatId, quote, stance, createdAt)
     VALUES ('aleksi', ?, ?, ?, 'supports', ?)`,
  );
  type Row = [
    kind: string,
    text: string,
    confidence: number,
    status: string,
    activatedBy: string | null,
    validFrom: string | null,
    validTo: string | null,
    recordedAt: string,
    supersedesId: number | null,
    sourceChatId: string | null,
    lastConfirmedAt: string | null,
    timesSeen: number,
    reviewedAt: string | null,
  ];
  const add = (row: Row, quotes: string[] = []) => {
    const { id } = claim.get(...row) as { id: number };
    for (const q of quotes) quote.run(id, chatId, q, row[7]);
    return id;
  };
  const coffee = add([
    'rhythm',
    'Käyttäjä juo aamuisin kahvia.',
    0.9,
    'active',
    'user',
    null,
    null,
    ago(40),
    null,
    null,
    ago(10),
    4,
    ago(40),
  ]);
  const ids = {
    coffee,
    tea: add(
      [
        'rhythm',
        'Käyttäjä juo aamuisin teetä.',
        0.7,
        'proposed',
        null,
        '2026-10',
        null,
        ago(1),
        coffee,
        chatId,
        null,
        1,
        null,
      ],
      ['Vaihdoin aamukahvin vihreään teehen.'],
    ),
    short: add(
      [
        'preference',
        'Käyttäjä haluaa vastaukset lyhyinä.',
        0.85,
        'proposed',
        null,
        null,
        null,
        ago(1),
        null,
        chatId,
        null,
        2,
        null,
      ],
      ['Vastaa lyhyesti, kiitos.', 'Pidä vastaukset tiiviinä.'],
    ),
    run: add(
      [
        'goal',
        'Käyttäjä harjoittelee puolimaratonille.',
        0.6,
        'proposed',
        null,
        null,
        null,
        ago(2),
        null,
        chatId,
        null,
        1,
        null,
      ],
      ['Juoksin taas kymmenen kilometriä, puolimaraton on toukokuussa.'],
    ),
    city: add(
      [
        'fact',
        'Käyttäjä asuu Tampereella.',
        0.9,
        'active',
        'auto',
        null,
        null,
        ago(0),
        null,
        chatId,
        ago(0),
        1,
        null,
      ],
      ['Asun Tampereella.'],
    ),
    cat: add([
      'relationship',
      'Käyttäjän kissa on nimeltään Miuku.',
      0.95,
      'active',
      'user',
      null,
      null,
      ago(20),
      null,
      chatId,
      ago(3),
      3,
      ago(20),
    ]),
    gym: add([
      'rhythm',
      'Käyttäjä käy salilla tiistaisin.',
      0.8,
      'active',
      'user',
      null,
      null,
      ago(120),
      null,
      null,
      null,
      2,
      null,
    ]),
    turku: add([
      'fact',
      'Käyttäjä asui Turussa.',
      0.9,
      'superseded',
      'user',
      null,
      '2025-08',
      ago(400),
      null,
      null,
      null,
      1,
      ago(400),
    ]),
    rejected: add([
      'quirk',
      'Käyttäjä kirjoittaa aina isoilla kirjaimilla.',
      0.4,
      'rejected',
      null,
      null,
      null,
      ago(5),
      null,
      chatId,
      null,
      1,
      ago(4),
    ]),
  };
  db.close();
  return ids;
}
