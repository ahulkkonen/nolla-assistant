import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import {
  acceptProposal,
  expect,
  openSettings,
  openVault,
  search,
  TAX,
  taxChat,
  test,
} from './fixtures.ts';

const send = async (page: Page, text: string) => {
  await page.getByLabel('Viesti').fill(text);
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
};
const newChat = (page: Page) =>
  page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
};
/** 64x64 solid red RGB PNG. */
const png = () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(64 * 3, 0).map((_, i) => (i % 3 ? 0 : 255)),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(64).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

test('login: wrong password errors, right password shows shell', async ({ app, page }) => {
  await page.goto(app.url);
  await page.getByLabel('Salasana').fill('väärin');
  await page.getByRole('button', { name: 'Kirjaudu', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Väärä salasana.');
  await app.login(page);
});

test('new chat streams a reply, then survives reload', async ({ app, page }) => {
  app.llm.push({ text: 'Hei! Tässä vastaus.' });
  await app.login(page);
  await newChat(page);
  await send(page, 'Moi');
  const user = page.getByRole('main').getByText('Moi', { exact: true });
  await expect(user).toBeVisible();
  const box = await user.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x + box!.width / 2).toBeGreaterThan(vp.width / 2);
  await expect(page.locator('.md')).toHaveText('Hei! Tässä vastaus.');
  await expect(page.getByRole('button', { name: 'Lähetä' })).toBeVisible();
  await expect(page.locator('nav li > button')).toHaveCount(1);

  await page.reload();
  await page.locator('nav li > button').click();
  await expect(page.getByRole('main').getByText('Moi', { exact: true })).toBeVisible();
  await expect(page.locator('.md')).toHaveText('Hei! Tässä vastaus.');
});

test('stop: Escape ends a running turn', async ({ app, page }) => {
  app.llm.push({ text: 'x'.repeat(2000) });
  await app.login(page);
  await send(page, 'pitkä');
  // fake-llm streams instantly, so the running window can be shorter than one poll.
  await page
    .getByRole('button', { name: 'Pysäytä' })
    .waitFor({ timeout: 1000 })
    .catch(() => {});
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Lähetä' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Vastaus tulossa' })).toHaveCount(0);
});

test('attach image reaches the LLM as image_url', async ({ app, page }) => {
  app.llm.push({ text: 'Näen kuvan.' });
  await app.login(page);
  const file = join(mkdtempSync(join(tmpdir(), 'pa-e2e-img-')), 'punainen.png');
  writeFileSync(file, png());
  await page.locator('input[type=file]').setInputFiles(file);
  const chip = page.getByLabel('Liitteet').getByText('punainen.png');
  await expect(chip).toBeVisible();
  await expect(page.getByLabel('Lähetetään')).toHaveCount(0);
  await send(page, 'Mikä tämä on?');
  await expect(page.locator('.md')).toHaveText('Näen kuvan.');
  const body = JSON.stringify(app.llm.requests.at(-1)?.body);
  expect(body).toContain('"image_url"');
});

test('PWA: manifest, service worker, icons', async ({ app, page, request }) => {
  const res = await request.get(`${app.url}/manifest.webmanifest`);
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m).toMatchObject({ display: 'standalone' });
  for (const k of ['name', 'short_name', 'start_url']) expect(m[k]).toBeTruthy();
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(m.icons.filter((i: { purpose?: string }) => i.purpose === 'maskable')).toHaveLength(1);
  for (const i of m.icons) {
    const r = await request.get(new URL(i.src, app.url).href);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  const sw = await request.get(`${app.url}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toContain('no-cache');

  await page.goto(app.url);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, {
    timeout: 10_000,
  });
  await expect(page.locator('link[rel=apple-touch-icon]')).toHaveCount(1);
});

test('keyboard: [ toggles sidebar, Tab reaches send with focus ring', async ({ app, page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await app.login(page);
  // Below 1200 px the sidebar starts as the icon rail.
  await expect(page.getByRole('button', { name: 'Avaa sivupalkki' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('button', { name: 'Sulje sivupalkki' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('button', { name: 'Avaa sivupalkki' })).toBeVisible();

  // Send is disabled when empty, so type first.
  await page.getByLabel('Viesti').fill('x');
  await page.keyboard.press('Tab'); // attach
  await page.keyboard.press('Tab'); // agent picker (a new chat can still choose)
  await page.keyboard.press('Tab'); // send
  const sendBtn = page.getByRole('button', { name: 'Lähetä' });
  await expect(sendBtn).toBeFocused();
  expect(await sendBtn.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
});

test.describe('vault', () => {
  test.use({ pseudo: 'full' });

  test('open from settings, merge two, confirm pending', async ({ app, page }) => {
    app.llm.push({ text: 'Selvä.' });
    await app.login(page);
    await send(page, 'Matti Virtanen ja Liisa Korhonen, hetu 010190-123M');
    await expect(page.locator('.md')).toHaveText('Selvä.');
    await openVault(page);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await page.getByRole('checkbox', { name: 'Valitse Matti Virtanen' }).check();
    await page.getByRole('checkbox', { name: 'Valitse Liisa Korhonen' }).check();
    await page.getByRole('button', { name: 'Yhdistä', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Liisa Korhonen' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Vahvista' }).click();
    await expect(page.getByRole('heading', { name: 'Vahvistettavat' })).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'Koski' })).toHaveCount(1);
  });
});

test('title and topic proposal: accept moves the chat under the topic', async ({ app, page }) => {
  await app.login(page);
  await taxChat(app, page);
  await expect(page.locator('nav li > button', { hasText: TAX.title })).toBeVisible();
  await openSettings(page, 'Aiheet');
  await expect(
    page.getByRole('region', { name: 'Ehdotukset' }).getByText('Verot', { exact: true }),
  ).toBeVisible();
  await acceptProposal(page);
  await expect(
    page.getByRole('region', { name: 'Omat aiheet' }).getByText('Verot', { exact: true }),
  ).toBeVisible();
  const group = page.locator('nav li', { has: page.getByRole('heading', { name: /Verot/ }) });
  await expect(group.getByRole('button', { name: TAX.title })).toBeVisible();
});

test('search finds the chat by a word from its message and opens it', async ({ app, page }) => {
  await app.login(page);
  await taxChat(app, page);
  await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
  await search(page, 'määräaika');
  const hit = page.getByRole('list', { name: 'Haku: määräaika' }).getByRole('button').first();
  await expect(hit).toContainText(TAX.title, { timeout: 15_000 });
  await expect(hit.locator('mark').first()).toBeVisible();
  await hit.click();
  await expect(page.getByRole('main').getByText(TAX.ask)).toBeVisible();
  await page.getByLabel('Hae keskusteluja').fill('');
});

test.describe('approval', () => {
  test.use({ pseudo: 'full' });

  test('card shows real args while the model saw surrogates; approve runs the tool', async ({
    app,
    page,
  }) => {
    // The model writes with the surrogate; the gate restores it before asking.
    app.llm.push({
      toolCalls: [{ name: 'write', args: { path: 'kirje.txt', content: 'Hei Pekka Laaksonen' } }],
    });
    app.llm.push({ text: 'Kirjoitettu.' });
    await app.login(page);
    await page.getByLabel('Viesti').fill('Kirjoita kirje Matti Virtanen');
    await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
    const card = page.getByRole('region', { name: 'Hyväksyntä: write' });
    await expect(card).toContainText('Hei Matti Virtanen');
    const body = JSON.stringify(app.llm.requests[0]?.body);
    expect(body).toContain('Pekka Laaksonen');
    expect(body).not.toContain('Matti Virtanen');
    await card.getByRole('button', { name: 'Hyväksy' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('.md').last()).toHaveText('Kirjoitettu.');
    await expect(page.getByRole('button', { name: /^write valmis/ })).toBeVisible();
  });
});

test('agent picker: a new chat is created with the picked agent', async ({ app, page }) => {
  app.llm.push({ text: 'Tutkitaan.' });
  await app.login(page);
  await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
  await page.getByRole('menuitemradio', { name: 'Tutkija' }).click();
  await expect(page.getByRole('button', { name: 'Agentti: Tutkija' })).toBeVisible();
  await page.getByLabel('Viesti').fill('Tutki tätä');
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
  await expect(page.locator('.md').last()).toHaveText('Tutkitaan.');
  // The chip now reads the chat's own agentId from the server and is locked.
  const chip = page.getByRole('button', { name: 'Agentti: Tutkija' });
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
  await expect(page.getByRole('button', { name: 'Agentti: Avustaja' })).toBeVisible();
});

test.describe('automations', () => {
  test.use({ automation: true });

  test('settings lists the automation and runs it now', async ({ app, page }) => {
    app.llm.push({ text: 'Huomenta.' });
    await app.login(page);
    await openSettings(page, 'Automaatiot');
    const row = page.getByRole('row', { name: /aamu/ });
    await expect(row).toContainText('0 3 1 1 *');
    await expect(row).toContainText('Avustaja');
    await row.getByRole('button', { name: 'Suorita nyt: aamu' }).click();
    await expect(row).toContainText(/käynnissä|onnistui/);
  });
});
