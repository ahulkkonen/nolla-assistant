import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLlm } from '@pa/fake-llm';
import { startFakeSidecar } from '@pa/pi-ext-pseudo/fake-sidecar';
import { hashPassword } from '@pa/server/src/auth/password.ts';
import { loadConfig } from '@pa/server/src/config.ts';
import { start } from '@pa/server/src/main.ts';
import { test as base, expect, type Page } from '@playwright/test';
import { WEB } from './global-setup.ts';

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

export const test = base.extend<{ app: App; pseudo: boolean }>({
  // Starts the fake sidecar (DICT plus one pending item) and sets PSEUDO_URL.
  pseudo: [false, { option: true }],
  app: async ({ pseudo }, use) => {
    const llm = await startFakeLlm([]);
    const sidecar = pseudo
      ? await startFakeSidecar(DICT, {
          pending: [{ kind: 'person', text: 'Koski', detector: 'gliner', score: 0.42 }],
        })
      : undefined;
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

/** Settings sits in the drawer under 768 px and in the sidebar footer above. */
export const openVault = async (page: Page) => {
  const menu = page.getByRole('button', { name: 'Valikko' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Asetukset' }).click();
  await page.getByRole('button', { name: 'Nimisuoja' }).click();
};

export { expect };
