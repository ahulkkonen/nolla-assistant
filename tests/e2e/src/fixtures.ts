import { createECDH } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FakeTurn, startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';
import { test as base, expect, type Page } from '@playwright/test';
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
  pseudo: 'off' | 'full' | 'empty';
  automation: boolean;
  approvalTimeoutMs: number;
  memoryUser: string;
}>({
  // Starts the fake sidecar and sets PSEUDO_URL: `full` has DICT plus one pending item.
  pseudo: ['off', { option: true }],
  // Writes AUTOMATION into the run's own AUTOMATIONS_DIR (always a temp dir, empty by default).
  automation: [false, { option: true }],
  // 0 keeps the server default (10 minutes).
  approvalTimeoutMs: [0, { option: true }],
  // Written to DATA_DIR/memory/aleksi/USER.md before start when non-empty.
  memoryUser: ['', { option: true }],
  app: async ({ pseudo, automation, approvalTimeoutMs, memoryUser }, use) => {
    const llm = await startFakeLlm([]);
    const sidecar =
      pseudo === 'off'
        ? undefined
        : pseudo === 'empty'
          ? await startFakeSidecar({})
          : await startFakeSidecar(DICT, {
              pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.42 }],
            });
    const dataDir = mkdtempSync(join(tmpdir(), 'pa-e2e-'));
    mkdirSync(join(dataDir, 'work/aleksi'), { recursive: true });
    mkdirSync(join(dataDir, 'automations'));
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
        AUTH_ORIGIN: `http://127.0.0.1:${port}`,
        COOKIE_SECRET: 'e'.repeat(40),
        AUTH_PASSWORD_HASH: await hashPassword(PASSWORD),
        WEB_DIST: join(WEB, 'dist'),
        HOST: '127.0.0.1',
        PORT: String(port),
        USER_ID: 'aleksi',
        LOG_LEVEL: 'warn',
        AUTOMATIONS_DIR: join(dataDir, 'automations'),
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

/** Opens a settings entry; settings sits in the drawer under 768 px, in the sidebar above. */
export const openSettings = async (
  page: Page,
  entry: 'Nimisuoja' | 'Aiheet' | 'Agentit' | 'Automaatiot' | 'Muisti' | 'Asetukset',
) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Asetukset' }).click();
  // 'Asetukset' only opens the dialog.
  if (entry !== 'Asetukset') await page.getByRole('button', { name: entry }).click();
};
export const openVault = (page: Page) => openSettings(page, 'Nimisuoja');

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

/** Accepts the first topic proposal: icon row above 768 px, the actions menu below. */
export async function acceptProposal(page: Page) {
  const inbox = page.getByRole('region', { name: 'Ehdotukset' });
  await expect(inbox.getByRole('listitem').first()).toBeVisible();
  const menu = inbox.getByRole('button', { name: /^Toiminnot/ }).first();
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole('menuitem', { name: 'Hyväksy', exact: true }).click();
  } else await inbox.getByRole('button', { name: 'Hyväksy', exact: true }).first().click();
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
