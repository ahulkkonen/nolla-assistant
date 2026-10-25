import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

export const test = base.extend<{ app: App; pseudo: 'off' | 'full' | 'empty' }>({
  // Starts the fake sidecar and sets PSEUDO_URL: `full` has DICT plus one pending item.
  pseudo: ['off', { option: true }],
  app: async ({ pseudo }, use) => {
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
export const openSettings = async (page: Page, entry: 'Nimisuoja' | 'Aiheet') => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Asetukset' }).click();
  await page.getByRole('button', { name: entry }).click();
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

export { expect };
