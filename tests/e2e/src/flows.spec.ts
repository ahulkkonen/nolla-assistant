import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  acceptProposal,
  COLLIDING,
  DICT,
  expect,
  HTML_REPLY,
  memoryTurns,
  mockMic,
  mockPush,
  openFiles,
  openSettings,
  openVault,
  png,
  search,
  TAX,
  taxChat,
  test,
  USER_MD,
} from './fixtures.ts';

const send = async (page: Page, text: string) => {
  await page.getByLabel('Viesti').fill(text);
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
};
const newChat = (page: Page) =>
  page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
/** The thread, not `main`: `main` also holds the sr-only chat title (h1). */
const thread = (page: Page) => page.getByRole('region', { name: 'Keskustelu' });

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
  const user = thread(page).getByText('Moi', { exact: true });
  await expect(user).toBeVisible();
  const box = await user.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x + box!.width / 2).toBeGreaterThan(vp.width / 2);
  await expect(page.locator('.md')).toHaveText('Hei! Tässä vastaus.');
  await expect(page.getByRole('button', { name: 'Lähetä', exact: true })).toBeVisible();
  await expect(page.locator('nav li > button')).toHaveCount(1);

  await page.reload();
  // Left edge: hovering a row shows its actions over the right part of the title.
  await page.locator('nav li > button').click({ position: { x: 16, y: 16 } });
  await expect(thread(page).getByText('Moi', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Lähetä', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Vastaus tulossa' })).toHaveCount(0);
});

test('attach image reaches the LLM as image_url', async ({ app, page }) => {
  app.llm.push({ text: 'Näen kuvan.' });
  await app.login(page);
  const file = join(mkdtempSync(join(tmpdir(), 'pa-e2e-img-')), 'punainen.png');
  writeFileSync(file, png([255, 0, 0]));
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

test('theme-color: one per scheme, both follow a chosen theme (brief 7.7)', async ({
  app,
  page,
}) => {
  await app.login(page);
  const metas = () =>
    page
      .locator('meta[name="theme-color"]')
      .evaluateAll((ms) => ms.map((m) => [m.getAttribute('media'), m.getAttribute('content')]));
  const light = '(prefers-color-scheme: light)';
  const dark = '(prefers-color-scheme: dark)';
  expect(await metas()).toEqual([
    [light, '#faf9f5'],
    [dark, '#262624'],
  ]);
  await openSettings(page, 'Asetukset');
  await page.getByRole('button', { name: 'Tumma' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await metas()).toEqual([
    [light, '#262624'],
    [dark, '#262624'],
  ]);
  await page.getByRole('button', { name: 'Järjestelmä' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await metas()).toEqual([
    [light, '#faf9f5'],
    [dark, '#262624'],
  ]);
});

test('keyboard: [ toggles sidebar, Tab reaches send with focus ring', async ({ app, page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await app.login(page);
  // From 1024 px the sidebar starts docked; `[` collapses it to the icon rail and back.
  await expect(page.getByRole('button', { name: 'Sulje sivupalkki' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('button', { name: 'Avaa sivupalkki' })).toBeVisible();
  await page.keyboard.press('[');
  await expect(page.getByRole('button', { name: 'Sulje sivupalkki' })).toBeVisible();

  // Send is disabled when empty, so type first.
  await page.getByLabel('Viesti').fill('x');
  await page.keyboard.press('Tab'); // attach
  await page.keyboard.press('Tab'); // agent picker (a new chat can still choose)
  await page.keyboard.press('Tab'); // model chip
  await page.keyboard.press('Tab'); // mic
  await page.keyboard.press('Tab'); // send
  const sendBtn = page.getByRole('button', { name: 'Lähetä', exact: true });
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

test.describe('collision', () => {
  test.use({ pseudo: 'collision' });

  test('collision: a name equal to an issued surrogate holds the message, Uusi henkilö resumes it', async ({
    app,
    page,
  }) => {
    app.llm.push({ text: 'Soitan hänelle huomenna.' });
    await app.login(page);
    const ask = `Soita ${COLLIDING} huomenna`;
    await send(page, ask);
    // Held: the toast asks for an answer, and the composer says what it waits for.
    await expect(page.getByText('Nimi on jo pseudonyymi. Vastaa Nimisuojassa.')).toBeVisible();
    await expect(page.getByLabel('Viesti')).toHaveAttribute('placeholder', 'Odottaa Nimisuojaa');
    await expect(thread(page).getByText(ask)).toBeVisible();
    expect(app.llm.requests).toHaveLength(0);

    await page.getByRole('button', { name: 'Avaa Nimisuoja' }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'Onko tämä uusi henkilö?' });
    await expect(row).toContainText(COLLIDING);
    await row.getByRole('button', { name: 'Uusi henkilö' }).click();
    await expect(page.getByRole('heading', { name: 'Vahvistettavat' })).toHaveCount(0);

    // Resumed: the reply arrives in the chat; the model never saw the typed name.
    await page.locator('nav li > button').first().click();
    await expect(page.locator('.md').last()).toHaveText('Soitan hänelle huomenna.');
    await expect(page.getByLabel('Viesti')).toHaveAttribute('placeholder', 'Kirjoita viesti');
    expect(JSON.stringify(app.llm.requests[0]?.body)).not.toContain(COLLIDING);
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
  await expect(group.getByRole('button', { name: TAX.title, exact: true })).toBeVisible();
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
  await expect(thread(page).getByText(TAX.ask)).toBeVisible();
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
    const card = page.getByRole('region', { name: /write/ });
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

test.describe('export', () => {
  test.use({ pseudo: 'full' });

  test('chat export: surrogates by default, real names with the switch', async ({ app, page }) => {
    app.llm.push({ text: 'Selvä, Pekka Laaksonen.' });
    await app.login(page);
    await send(page, 'Muistio Matti Virtanen');
    await expect(page.locator('.md').last()).toHaveText('Selvä, Matti Virtanen.');
    const dialog = page.getByRole('dialog', { name: 'Vie keskustelu' });
    const unmask = dialog.getByRole('switch', { name: 'Näytä oikeat nimet' });
    const download = async () => {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: 'Lataa' }).click(),
      ]);
      await expect(dialog).toHaveCount(0);
      return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') };
    };

    // The chat row menu: the switch is off, so the file has what the model saw.
    const row = page.locator('nav li', {
      has: page.getByRole('button', { name: 'Muistio Matti Virtanen' }),
    });
    await row.hover();
    await row.getByRole('button', { name: 'Lisää: Muistio Matti Virtanen' }).click();
    await page.getByRole('menuitem', { name: 'Vie…' }).click();
    await expect(unmask).not.toBeChecked();
    await expect(unmask).toHaveAccessibleDescription(/Tiedoston voi jakaa\./);
    let file = await download();
    expect(file.name).toMatch(/^muistio-pekka-laaksonen-\d{4}-\d{2}-\d{2}-masked\.md$/);
    expect(file.text).toContain(`Muistio ${DICT['Matti Virtanen']}`);
    expect(file.text).not.toContain('Matti Virtanen');

    // The palette: the switch on restores the real names, and the meta line says so.
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('option', { name: 'Vie keskustelu…' }).click();
    await expect(unmask).not.toBeChecked();
    await unmask.click();
    await expect(unmask).toHaveAccessibleDescription('Tiedostossa on henkilötietoja.');
    file = await download();
    expect(file.name).toMatch(/^muistio-matti-virtanen-\d{4}-\d{2}-\d{2}-avoin\.md$/);
    expect(file.text).toContain('Muistio Matti Virtanen');
    expect(file.text).not.toContain(DICT['Matti Virtanen']);
  });
});

test('model policy: a favourite without ZDR is refused, allowed for the chat, then restored', async ({
  app,
  page,
}) => {
  // Phase-10 gate item 3. The fake catalog has no ZDR endpoint for Fable.
  app.llm.push({
    match: /^Hei Fable/,
    error: { status: 404, message: 'No endpoints found matching your data policy' },
  });
  app.llm.push({ match: /^Hei Fable/, text: 'Vastaus ilman ZDR:ää.' });
  await app.login(page);
  const chip = page.getByRole('button', { name: /^Malli: / });

  // Favourite it in the catalog, then pick it from the menu.
  await chip.click();
  await page.getByRole('menuitem', { name: 'Kaikki mallit…' }).click();
  const catalog = page.getByRole('dialog', { name: 'Kaikki mallit' });
  await catalog.getByRole('button', { name: 'Lisää suosikkeihin: Claude Fable 5.1' }).click();
  await expect(catalog.getByRole('heading', { name: 'Suosikit' })).toBeVisible();
  // Listed once; the star keeps the focus when its row moves to Suosikit.
  await expect(catalog.getByRole('button', { name: /: Claude Fable 5\.1$/ })).toHaveCount(1);
  await expect(
    catalog.getByRole('button', { name: 'Poista suosikeista: Claude Fable 5.1' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await chip.click();
  await page.getByRole('menuitemradio', { name: /^Claude Fable 5\.1/ }).click();
  await expect(chip).toHaveAccessibleName('Malli: Claude Fable 5.1');

  // 1. The refusal asks for consent inline.
  await send(page, 'Hei Fable');
  const alert = page.getByRole('alert').filter({ hasText: 'ei ole ZDR-reittiä' });
  await expect(alert).toBeVisible();
  expect(app.llm.requests.at(-1)?.body.model).toBe('zdr/anthropic/claude-fable-5.1');

  // A chat switch keeps the refusal: the alert is back when the chat opens again.
  await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
  await expect(alert).toHaveCount(0);
  await page.locator('nav li > button', { hasText: 'Hei Fable' }).click();
  await expect(alert).toBeVisible();

  // 2. Consent: the same turn runs again on the open route, in place; the chip shows the badge.
  await alert.getByRole('button', { name: 'Salli ilman ZDR:ää tässä keskustelussa' }).click();
  await expect(page.locator('.md').last()).toHaveText('Vastaus ilman ZDR:ää.');
  await expect(alert).toHaveCount(0);
  await expect(chip).toHaveAccessibleName('Malli: Claude Fable 5.1, Ei ZDR');
  await expect(page.getByText('Ei ZDR', { exact: true })).toBeVisible();
  const thread = page.getByRole('region', { name: 'Keskustelu' });
  await expect(thread.getByText('Hei Fable', { exact: true })).toHaveCount(1);
  const open = app.llm.requests.filter((r) => r.body.model === 'open/anthropic/claude-fable-5.1');
  expect(open).toHaveLength(1);
  expect(JSON.stringify(open[0]?.body.messages).split('Hei Fable')).toHaveLength(2);

  // 3. "Palauta ZDR" ends the consent: the badge goes.
  await chip.click();
  await page.getByRole('menuitem', { name: 'Palauta ZDR' }).click();
  await expect(chip).toHaveAccessibleName('Malli: Claude Fable 5.1');
  await expect(page.getByText('Ei ZDR', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ZDR palautettu')).toBeVisible();
});

test('Yritä uudelleen: a failed reply runs again in place, and the thread shows the message once', async ({
  app,
  page,
}) => {
  // 400 is not retried by Pi: one failed call, then the alert.
  app.llm.push({ match: /^Hei uudelleen$/, error: { status: 400, message: 'boom' } });
  app.llm.push({ match: /^Hei uudelleen$/, text: 'Nyt onnistui.' });
  await app.login(page);
  await send(page, 'Hei uudelleen');
  const alert = page.getByRole('alert').filter({ hasText: 'Mallin kutsu epäonnistui.' });
  await alert.getByRole('button', { name: 'Yritä uudelleen' }).click();
  await expect(page.locator('.md').last()).toHaveText('Nyt onnistui.');
  await expect(alert).toHaveCount(0);
  await expect(thread(page).getByText('Hei uudelleen', { exact: true })).toHaveCount(1);
  const chat = app.llm.requests.filter((r) => r.body.stream === true);
  expect(chat).toHaveLength(2);
  expect(JSON.stringify(chat[1]?.body.messages).split('Hei uudelleen')).toHaveLength(2);
});

test.describe('files', () => {
  test.use({ workFiles: true });

  test('files: upload, folder, preview, rename, trash and restore, attach, save artifact', async ({
    app,
    page,
  }) => {
    // Phase-11 gate item 3.
    await app.login(page);
    await openFiles(page);
    const table = page.getByRole('region', { name: 'Työkansio' });

    // Two files with progress: each upload waits a moment, so the bars show.
    await page.route('**/api/files/tree/upload**', async (route) => {
      await new Promise((r) => setTimeout(r, 400));
      await route.continue();
    });
    const dir = mkdtempSync(join(tmpdir(), 'pa-e2e-files-'));
    writeFileSync(join(dir, 'ensimmäinen.txt'), 'Ensimmäinen tiedosto.\n');
    writeFileSync(join(dir, 'toinen.txt'), 'Toinen tiedosto.\n');
    await page
      .locator('#files-upload')
      .setInputFiles([join(dir, 'ensimmäinen.txt'), join(dir, 'toinen.txt')]);
    await expect(page.getByRole('progressbar', { name: 'Lataus: toinen.txt' })).toBeVisible();
    await expect(table.getByText('ensimmäinen.txt', { exact: true })).toBeVisible();
    await expect(table.getByText('toinen.txt', { exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);

    // A folder, then the Markdown preview with real text.
    await table.getByRole('button', { name: 'Raportit', exact: true }).click();
    await expect(
      page.getByRole('navigation', { name: 'Kansiopolku' }).getByText('Raportit'),
    ).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Esikatsele: Raportti 2.md' }).click();
    const pane = page.getByRole('complementary', { name: 'Esikatselu' });
    await expect(pane.getByRole('heading', { name: 'Raportti 2' })).toBeVisible();
    await expect(pane.getByText('Myynti: 120')).toBeVisible();
    await pane.getByRole('button', { name: 'Sulje esikatselu' }).click();

    // Rename.
    await page.getByRole('button', { name: 'Tiedoston toiminnot: Raportti 2.md' }).click();
    await page.getByRole('menuitem', { name: 'Nimeä uudelleen' }).click();
    await page.getByLabel('Nimi').fill('Yhteenveto.md');
    await page.getByRole('button', { name: 'Tallenna' }).click();
    await expect(table.getByText('Yhteenveto.md', { exact: true })).toBeVisible();
    await expect(table.getByText('Raportti 2.md', { exact: true })).toHaveCount(0);

    // Delete to the trash, then restore it from there.
    await page.getByRole('button', { name: 'Tiedoston toiminnot: Yhteenveto.md' }).click();
    await page.getByRole('menuitem', { name: 'Poista' }).click();
    await expect(page.getByText('Siirretty roskakoriin')).toBeVisible();
    await expect(table.getByText('Yhteenveto.md', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Roskakori', exact: true }).click();
    const bin = page.getByRole('region', { name: 'Roskakori' });
    await expect(bin.getByText('Työkansio › Raportit')).toBeVisible();
    await page.getByRole('button', { name: 'Palauta: Yhteenveto.md' }).click();
    await expect(page.getByText('Roskakori on tyhjä')).toBeVisible();
    await page.getByRole('button', { name: 'Työkansio', exact: true }).click();
    await table.getByRole('button', { name: 'Raportit', exact: true }).click();
    await expect(table.getByText('Yhteenveto.md', { exact: true })).toBeVisible();

    // Attach a work file from the composer picker and send it: the model gets its text.
    app.llm.push({ text: 'Luin muistiinpanot.' });
    await newChat(page);
    await page.getByRole('button', { name: 'Liitä tiedosto' }).click();
    await page.getByRole('menuitem', { name: 'Valitse työkansiosta' }).click();
    const picker = page.getByRole('dialog', { name: 'Valitse työkansiosta' });
    await picker.getByRole('button', { name: /^muistiinpanot\.md/ }).click();
    await picker.getByRole('button', { name: 'Liitä', exact: true }).click();
    await expect(page.getByLabel('Liitteet').getByText('muistiinpanot.md')).toBeVisible();
    await send(page, 'Lue liite');
    await expect(page.locator('.md').last()).toHaveText('Luin muistiinpanot.');
    expect(JSON.stringify(app.llm.requests.at(-1)?.body)).toContain('Kokoa kuukauden luvut');

    // Save an artifact and find it in Tiedostot.
    app.llm.push({ text: HTML_REPLY });
    await send(page, 'Tee sivu');
    await page.getByRole('button', { name: 'Tallenna tiedostoksi' }).click();
    await page.getByRole('button', { name: 'Näytä' }).click();
    await expect(page.getByRole('group', { name: 'Näkymä' })).toBeVisible();
    await expect(table.getByText('Hei artefakti.html', { exact: true })).toBeVisible();
    const saved = page.getByRole('complementary', { name: 'Esikatselu' }).locator('iframe');
    await expect(
      saved.contentFrame().getByRole('heading', { name: 'Hei artefakti' }),
    ).toBeVisible();

    // The attached copy is in Liitteet, with its chat as the source.
    await page.getByRole('button', { name: 'Liitteet', exact: true }).click();
    const uploads = page.getByRole('region', { name: 'Liitteet' });
    await expect(uploads.getByText('muistiinpanot.md', { exact: true })).toBeVisible();
    await expect(uploads.getByRole('link')).toHaveCount(1);
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
    await expect(row).toContainText('1.1. klo 3.00');
    await expect(row).toContainText('ei vielä ajettu');
    await expect(row).toContainText('Avustaja');
    await row.getByRole('button', { name: 'Suorita nyt: aamu' }).click();
    await expect(row).toContainText(/käynnissä|onnistui/);
  });
});

test.describe('memory', () => {
  test.use({ pseudo: 'full', memoryUser: USER_MD });

  test('edit USER.md, save, still there after reload', async ({ app, page }) => {
    await app.login(page);
    await openSettings(page, 'Muisti');
    const user = page.getByLabel('Käyttäjä (USER.md)');
    await expect(user).toHaveValue(USER_MD);
    await expect(page.getByText(`${USER_MD.length} / 1500`)).toBeVisible();
    const save = page.getByRole('button', { name: 'Tallenna' }).first();
    await expect(save).toBeDisabled();
    await user.fill(`${USER_MD}\nAamuisin juon kahvia.`);
    await user.press('ControlOrMeta+s');
    await expect(save).toBeDisabled();
    await page.reload();
    await openSettings(page, 'Muisti');
    await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(
      `${USER_MD}\nAamuisin juon kahvia.`,
    );
  });

  test('leaving with unsaved edits asks first', async ({ app, page }) => {
    await app.login(page);
    await openSettings(page, 'Muisti');
    await page.getByLabel('Käyttäjä (USER.md)').fill('Luonnos');
    await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Hylätäänkö tallentamattomat muutokset?',
    });
    await dialog.getByRole('button', { name: 'Peruuta' }).click();
    await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue('Luonnos');
    await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
    await dialog.getByRole('button', { name: 'Hylkää muutokset' }).click();
    await expect(page.getByLabel('Viesti')).toBeVisible();
  });

  test('an untainted agent write applies and shows the chip', async ({ app, page }) => {
    memoryTurns(app, 'Lempiväri on sininen.');
    await app.login(page);
    await page.getByLabel('Viesti').fill('Lempivärini on sininen');
    await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
    await expect(page.locator('.md').last()).toHaveText('Selvä, muistan.');
    await expect(page.getByText('Muisti päivitetty')).toBeVisible();
    await page.getByRole('button', { name: 'Avaa muisti' }).click();
    await expect(page.getByLabel('Muisti (MEMORY.md)')).toHaveValue(/Lempiväri on sininen\./);
  });

  test('a tainted agent write waits; approve applies it', async ({ app, page }) => {
    memoryTurns(app, 'Lempiväri on vihreä.', true);
    await app.login(page);
    await page.getByLabel('Viesti').fill('Muista lempivärini');
    await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
    await expect(page.locator('.md').last()).toHaveText('Selvä, muistan.');
    await expect(page.getByText('Muistikirjoitus odottaa hyväksyntää')).toBeVisible();
    await page.getByRole('button', { name: 'Avaa muisti' }).click();
    const pending = page.getByRole('region', { name: 'Odottavat kirjoitukset' });
    await expect(pending).toContainText('Lempiväri on vihreä.');
    await pending.getByRole('button', { name: 'Hyväksy' }).click();
    await expect(pending).toHaveCount(0);
    await expect(page.getByLabel('Muisti (MEMORY.md)')).toHaveValue(/Lempiväri on vihreä\./);
  });
});

test.describe('voice', () => {
  test.use({ permissions: ['microphone'] });

  test('hold to record: the transcript lands in the composer', async ({ app, page }) => {
    app.llm.setTranscript('Hei, tämä on sanelu.');
    await mockMic(page);
    await app.login(page);
    await page.getByLabel('Viesti').fill('Alku:');
    await page.getByRole('button', { name: 'Pidä pohjassa ja puhu' }).hover();
    await page.mouse.down();
    await expect(page.getByRole('status').getByText('Kuuntelee')).toBeVisible();
    await page.waitForTimeout(1000);
    await page.mouse.up();
    await expect(page.getByLabel('Viesti')).toHaveValue('Alku: Hei, tämä on sanelu.');
  });
});

test('artifact panel: an html reply opens in a sandboxed iframe', async ({ app, page }) => {
  app.llm.push({ text: HTML_REPLY });
  await app.login(page);
  await page.getByLabel('Viesti').fill('Tee sivu');
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
  const panel = page.getByRole('complementary', { name: 'Artefaktit' });
  // The panel header names the artifact; its tabs are Esikatselu and Koodi (brief 7.5).
  await expect(panel.getByRole('heading', { name: 'Hei artefakti' })).toBeVisible();
  const frame = panel.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame.contentFrame().getByRole('heading', { name: 'Hei artefakti' })).toBeVisible();
  await panel.getByRole('button', { name: 'Sulje artefaktit' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Avaa artefaktina' }).click();
  await expect(panel).toBeVisible();
});

test('artifact CSP is the first element even when the HTML starts with a script', async ({
  app,
  page,
}) => {
  app.llm.push({
    text: "Sivu:\n\n```html\n<script>document.title='x'</script><head><title>T</title></head><h1>Skripti ensin</h1>\n```",
  });
  await app.login(page);
  await page.getByLabel('Viesti').fill('Tee sivu');
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
  const frame = page.getByRole('complementary', { name: 'Artefaktit' }).locator('iframe');
  await expect(frame).toHaveAttribute(
    'srcdoc',
    /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/,
  );
  await expect(frame.contentFrame().getByRole('heading', { name: 'Skripti ensin' })).toBeVisible();
});

test('command palette: Ctrl+K, "Nimi", Enter opens the vault', async ({ app, page }) => {
  await app.login(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder('Hae komentoa tai keskustelua').fill('Nimi');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Nimisuoja' })).toBeVisible();
});

test('delete chat after confirmation', async ({ app, page }) => {
  app.llm.push({ text: 'Poistettava vastaus.' });
  await app.login(page);
  await page.getByLabel('Viesti').fill('Poistettava');
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
  await expect(page.locator('.md').last()).toHaveText('Poistettava vastaus.');
  const row = page.locator('nav li', { has: page.getByRole('button', { name: 'Poistettava' }) });
  await row.hover();
  await row.getByRole('button', { name: 'Lisää: Poistettava' }).click();
  await page.getByRole('menuitem', { name: 'Poista' }).click();
  const dialog = page.getByRole('alertdialog', { name: /^Poistetaanko keskustelu/ });
  await dialog.getByRole('button', { name: 'Poista' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.md')).toHaveCount(0);
});

test('push toggle subscribes through the service worker and posts it', async ({ app, page }) => {
  await mockPush(page);
  await app.login(page);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await openSettings(page, 'Asetukset');
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/api/push/subscribe') && r.request().method() === 'POST',
  );
  // Checked only after the subscription succeeds, so click (not `check`).
  await page.getByLabel('Ilmoita, kun vastaus tai hyväksyntä odottaa').click();
  expect((await posted).status()).toBe(200);
  await expect(page.getByLabel('Ilmoita, kun vastaus tai hyväksyntä odottaa')).toBeChecked();
});

test('integrations row: status and connect round trip', async ({ app, page }) => {
  await app.login(page);
  await page.route('**/api/integrations/google/connect', (route) =>
    route.fulfill({ json: { authUrl: '/?integrations=google' } }),
  );
  await openSettings(page, 'Asetukset');
  const dialog = page.getByRole('dialog', { name: 'Asetukset' });
  await expect(dialog.getByText('Google Workspace')).toBeVisible();
  await expect(dialog.getByText('Ei yhdistetty')).toBeVisible();
  await dialog.getByRole('button', { name: 'Yhdistä' }).click();
  await expect(page.getByText('Google yhdistetty.')).toBeVisible();
});
