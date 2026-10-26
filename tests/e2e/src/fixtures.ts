import { createECDH } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';
import { seedAgents } from '@pa/server/src/test-utils.ts';
import { type Browser, test as base, expect, type Page } from '@playwright/test';
import { WEB } from './global-setup.ts';

// One embedding model cache for all runs, outside the per-test DATA_DIR (downloaded once).
process.env.MODELS_DIR ||= join(tmpdir(), 'pa-models');

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
  app: async ({ pseudo, automation, approvalTimeoutMs, memoryUser, workFiles }, use) => {
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
    rmSync(dataDir, { recursive: true, force: true });
  },
  baseURL: async ({ app }, use) => use(app.url),
});

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
export function memoryTurns(app: App, text: string, tainted = false) {
  if (tainted) app.llm.push({ toolCalls: [{ name: 'recall', args: { query: 'väri' } }] });
  app.llm.push({
    toolCalls: [{ name: 'memory', args: { action: 'add', target: 'memory', text } }],
  });
  app.llm.push({ text: 'Selvä, muistan.' });
}

export { expect };
