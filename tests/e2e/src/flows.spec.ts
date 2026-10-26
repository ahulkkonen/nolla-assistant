import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SEARCH_DENIED } from '@pa/server/src/search-tool.ts';
import type { Page } from '@playwright/test';
import {
  acceptProposal,
  COLLIDING,
  DICT,
  deviceRows,
  editAgent,
  expect,
  HTML_REPLY,
  memoryTurns,
  mockMic,
  mockPush,
  newAutomation,
  openFiles,
  openSettings,
  openVault,
  png,
  search,
  searchTurns,
  secondDevice,
  TAX,
  THINKING_TURN,
  taxChat,
  test,
  titleTurn,
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

/** About 2,000 lines of mixed Markdown: headings, paragraphs, lists, tables and code fences. */
const LONG_MD = Array.from({ length: 125 }, (_, i) =>
  [
    `## Osa ${i + 1}`,
    '',
    `Kappale ${i + 1}: vastaus jatkuu, ja siinä on \`koodia\` ja [linkki](https://example.com/${i}).`,
    '',
    '- ensimmäinen kohta',
    '- toinen kohta',
    '',
    '| Nimi | Arvo |',
    '| --- | --- |',
    `| a${i} | ${i} |`,
    '',
    '```ts',
    `const x${i} = ${i};`,
    'console.log(x);',
    '```',
    '',
  ].join('\n'),
).join('\n');

/**
 * fake-llm sends a turn at once. This delivers its text in frames of about 200 characters, one
 * every 4 ms, as a live model does; other frames keep their order. Call before the page opens
 * the WebSocket.
 */
const paceDeltas = async (page: Page) => {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let chain = Promise.resolve();
    let buf: { msg: Record<string, unknown>; text: string } | undefined;
    const flush = () => {
      if (!buf) return;
      const m = JSON.stringify({ ...buf.msg, text: buf.text, annotations: [] });
      buf = undefined;
      chain = chain.then(() => new Promise((r) => setTimeout(r, 4))).then(() => ws.send(m));
    };
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : undefined;
      if (msg?.type === 'message.delta' && (!buf || buf.msg.messageId === msg.messageId)) {
        buf ??= { msg, text: '' };
        buf.text += msg.text;
        if (buf.text.length >= 200) flush();
        return;
      }
      flush();
      chain = chain.then(() => ws.send(m));
    });
  });
};

/** Counts React commits through the DevTools hook, which production React also calls. */
const countCommits = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
    w.__commits = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onCommitFiberRoot: () => void w.__commits++,
      onCommitFiberUnmount: () => {},
    };
  });

test('long stream: render cost, then the jump-to-latest pill', async ({ app, page }) => {
  test.setTimeout(120_000);
  app.llm.push({ text: LONG_MD });
  await countCommits(page);
  await paceDeltas(page);
  await app.login(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const script = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'ScriptDuration')!
      .value;
  const commits = () => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
  const [c0, s0] = [await commits(), await script()];
  await send(page, 'Kirjoita pitkä vastaus');
  await expect(page.locator('.md').last().locator('table')).toHaveCount(125, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  const cost = `${(await commits()) - c0} commits, ${Math.round(((await script()) - s0) * 1000)} ms script`;
  console.log(`long stream: ${cost}`);
  test.info().annotations.push({ type: 'long stream', description: cost });
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
    app.llm.push({ text: 'Selvä.' });
    app.llm.push({ text: 'Soitan hänelle huomenna.' });
    // The title job runs 2 s after the first turn, maybe while the message is held: its own turn,
    // or it takes the resumed reply. Chat calls are counted without it.
    app.llm.push({ ...titleTurn('Soitto', 'Käyttäjä pyysi soittamaan.'), match: 'Aiheet:' });
    const chatCalls = () =>
      app.llm.requests.filter((r) => (r.body as { model?: string }).model !== 'zdr/task-small');
    await app.login(page);
    // Matti Virtanen gets his entity; his surrogate is the name the user types next.
    await send(page, 'Matti Virtanen soitti eilen');
    await expect(page.locator('.md').last()).toHaveText('Selvä.');
    const ask = `Soita ${COLLIDING} huomenna`;
    await send(page, ask);
    // Held: the toast asks for an answer, and the composer says what it waits for.
    await expect(page.getByText('Nimi on jo pseudonyymi. Vastaa Nimisuojassa.')).toBeVisible();
    await expect(page.getByLabel('Viesti')).toHaveAttribute('placeholder', 'Odottaa Nimisuojaa');
    await expect(thread(page).getByText(ask)).toBeVisible();
    // The held bubble says it too, after the toast has gone.
    await expect(
      thread(page).getByRole('button', { name: 'Avaa Nimisuoja ja vastaa' }),
    ).toBeVisible();
    expect(chatCalls()).toHaveLength(1);

    await page.getByRole('button', { name: 'Avaa Nimisuoja', exact: true }).click();
    const row = page.getByRole('listitem').filter({ hasText: `Onko ${COLLIDING} uusi henkilö?` });
    await expect(row).toContainText('Nimi on jo henkilön Matti Virtanen pseudonyymi.');
    await row.getByRole('button', { name: 'Uusi henkilö' }).click();
    await expect(page.getByRole('heading', { name: 'Vahvistettavat' })).toHaveCount(0);

    // Resumed: the reply arrives in the chat; the model never saw the typed name.
    await page.locator('nav li > button').first().click();
    await expect(page.locator('.md').last()).toHaveText('Soitan hänelle huomenna.');
    await expect(page.getByLabel('Viesti')).toHaveAttribute('placeholder', 'Kirjoita viesti');
    await expect(
      thread(page).getByRole('button', { name: 'Avaa Nimisuoja ja vastaa' }),
    ).toHaveCount(0);
    // "Pekka Laaksonen" in that request is Matti Virtanen's surrogate in the earlier turn; the typed
    // name went out as the new person's own surrogate.
    const body = JSON.stringify(chatCalls()[1]?.body);
    expect(body).not.toContain(`Soita ${COLLIDING}`);
    expect(body).toContain('Soita Uusi');
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

test.describe('thread depth', () => {
  // Phase-13 gate item 4.
  const msgs = (page: Page) => thread(page).locator('[data-message-id]');

  test('fork: Haarauta on the first message opens a new chat; the old chat keeps both turns', async ({
    app,
    page,
  }) => {
    app.llm.push({ text: 'Ensimmäinen vastaus.' });
    app.llm.push(titleTurn('Kasvimaa', 'Käyttäjä kysyi kasvimaasta.'));
    app.llm.push({ text: 'Toinen vastaus.' });
    app.llm.push({ text: 'Haaran vastaus.' });
    await app.login(page);
    await send(page, 'Ensimmäinen kysymys');
    await expect(page.locator('.md').last()).toHaveText('Ensimmäinen vastaus.');
    await expect(page.locator('nav li > button', { hasText: 'Kasvimaa' })).toBeVisible();
    await send(page, 'Toinen kysymys');
    await expect(page.locator('.md').last()).toHaveText('Toinen vastaus.');

    await msgs(page).first().hover();
    await msgs(page).first().getByRole('button', { name: 'Muokkaa' }).click();
    await page.getByLabel('Muokattava viesti').fill('Ensimmäinen kysymys, toisin');
    await expect(
      page.getByText('Muokattu viesti aloittaa uuden keskustelun. Tämä keskustelu ei muutu.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Haarauta' }).click();

    const link = page.getByRole('button', { name: 'Haarautettu keskustelusta ”Kasvimaa”' });
    await expect(link).toBeVisible();
    await expect(thread(page).getByText('Ensimmäinen kysymys, toisin')).toBeVisible();
    await expect(page.locator('.md').last()).toHaveText('Haaran vastaus.');
    await expect(page.locator('nav li > button', { hasText: 'Kasvimaa (haara)' })).toBeVisible();

    // The source keeps both turns; the link opens it.
    await link.click();
    await expect(thread(page).getByText('Toinen vastaus.')).toBeVisible();
    await expect(msgs(page)).toHaveCount(4);
  });

  test('fork: an error keeps the edit box and its text; a double click sends one fork', async ({
    app,
    page,
  }) => {
    app.llm.push({ text: 'Vastaus.' });
    app.llm.push({ text: 'Haaran vastaus.' });
    // The first chat.fork gets an error from here; later ones go to the server, counted.
    let fail = true;
    let forks = 0;
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const msg = typeof m === 'string' ? JSON.parse(m) : null;
        if (msg?.type === 'chat.fork') {
          forks++;
          if (fail) {
            fail = false;
            ws.send(
              JSON.stringify({ type: 'error', code: 'failed', message: 'x', chatId: msg.chatId }),
            );
            return;
          }
        }
        server.send(m);
      });
    });
    await app.login(page);
    await send(page, 'Kysymys');
    await expect(page.locator('.md').last()).toHaveText('Vastaus.');
    await msgs(page).first().hover();
    await msgs(page).first().getByRole('button', { name: 'Muokkaa' }).click();
    const box = page.getByLabel('Muokattava viesti');
    await box.fill('Toisin kysytty');
    const fork = page.getByRole('button', { name: 'Haarauta' });
    await fork.click();
    await expect(page.getByText('Haarautus epäonnistui. Yritä uudelleen.')).toBeVisible();
    await expect(box).toHaveValue('Toisin kysytty');
    await expect(fork).toBeEnabled();

    await fork.dblclick();
    await expect(page.getByRole('button', { name: /^Haarautettu / })).toBeVisible();
    await expect(page.locator('.md').last()).toHaveText('Haaran vastaus.');
    expect(forks).toBe(2);
  });

  test('thinking: live row, then "Ajatteli … s" opens to the text; the switch hides it', async ({
    app,
    page,
  }) => {
    app.llm.push(THINKING_TURN);
    await app.login(page);
    await send(page, 'Milloin kasvimaa kannattaa aloittaa?');
    await expect(thread(page).getByText(/^Ajattelee… \d+ s$/)).toBeVisible();
    await expect(page.locator('.md').last()).toHaveText(THINKING_TURN.text);
    const row = thread(page).getByRole('button', { name: /^Ajatteli \d+ s$/ });
    await row.click();
    await expect(thread(page).getByRole('region', { name: 'Mallin ajattelu' })).toHaveText(
      THINKING_TURN.reasoning,
    );
    await openSettings(page, 'Asetukset');
    await page.getByLabel('Näytä ajattelu').click();
    await page.keyboard.press('Escape');
    await expect(row).toHaveCount(0);
  });

  test('cost: the reply shows its time and cost, the chat menu the chat total', async ({
    app,
    page,
  }) => {
    app.llm.push(THINKING_TURN);
    app.llm.push(titleTurn('Kasvimaa', 'Käyttäjä kysyi kasvimaasta.'));
    await app.login(page);
    await send(page, 'Milloin kasvimaa kannattaa aloittaa?');
    await expect(page.locator('.md').last()).toHaveText(THINKING_TURN.text);
    const reply = msgs(page).last();
    await expect(reply.getByText(/^klo \d{1,2}\.\d{2}$/)).toBeVisible();
    await expect(reply.getByText('0,012 €')).toBeVisible();
    await expect(reply.getByText('3,4 k tokenia')).toBeVisible();
    const row = page.locator('nav li', { hasText: 'Kasvimaa' });
    await row.hover();
    await row.getByRole('button', { name: 'Lisää: Kasvimaa' }).click();
    await expect(page.getByRole('menu').getByText('0,012 € · 3,4 k tokenia')).toBeVisible();
  });

  test('find: Ctrl+F, two hits 1/2, Enter 2/2, Esc closes', async ({ app, page }) => {
    app.llm.push({ text: 'Omena on hedelmä.' });
    await app.login(page);
    await send(page, 'Kerro omena');
    await expect(page.locator('.md').last()).toHaveText('Omena on hedelmä.');
    await page.keyboard.press('ControlOrMeta+f');
    const field = page.getByLabel('Etsi keskustelusta');
    await field.fill('omena');
    await expect(page.getByText('1/2', { exact: true })).toBeVisible();
    // The hits are CSS custom highlights; the DOM keeps its text nodes.
    const size = () =>
      // The DOM typings of this package lack the registry's Map methods.
      (CSS.highlights as unknown as Map<string, Set<Range>>).get('find')?.size;
    expect(await page.evaluate(size)).toBe(2);
    await field.press('Enter');
    await expect(page.getByText('2/2', { exact: true })).toBeVisible();
    await field.press('Escape');
    await expect(page.getByLabel('Etsi keskustelusta')).toHaveCount(0);
  });

  test('usage: Käyttö shows the model with its cost for this month', async ({ app, page }) => {
    app.llm.push(THINKING_TURN);
    await app.login(page);
    await send(page, 'Milloin kasvimaa kannattaa aloittaa?');
    await expect(page.locator('.md').last()).toHaveText(THINKING_TURN.text);
    await openSettings(page, 'Käyttö');
    const table = page.getByRole('region', { name: 'Mallit' });
    await expect(table.getByText('Gemini 4 Argon')).toBeVisible();
    await expect(table.getByText('0,012 €')).toBeVisible();
    await expect(page.getByText('Kurssi: EKP 23.10.2026, 1 € = 1,1193 $.')).toBeVisible();
  });
});

test.describe('web search', () => {
  // Phase-14 gate: the row and its links; a vault name asks; approve runs it; deny tells the model.
  test.use({ pseudo: 'full' });

  test('search: links in the row, a vault name raises the card, approve runs, deny is told', async ({
    app,
    page,
  }) => {
    searchTurns(app, 'Helsingin sää', 'Pilvistä, 7 astetta.');
    await app.login(page);
    await send(page, 'Millainen sää on Helsingissä?');
    await expect(page.locator('.md').last()).toHaveText('Pilvistä, 7 astetta.');
    await thread(page)
      .getByRole('button', { name: /^web_search 2 tulosta/ })
      .click();
    const list = thread(page).getByRole('list', { name: 'Hakutulokset' });
    const yle = list.getByRole('link', { name: 'Sää | Yle' });
    await expect(yle).toHaveAttribute('href', 'https://yle.fi/saa');
    await expect(yle).toHaveAttribute('target', '_blank');
    await expect(yle).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(list.getByText('ilmatieteenlaitos.fi', { exact: true })).toBeVisible();

    // The model's query names a vault person: the card shows the real query; approve runs it.
    app.llm.push({
      toolCalls: [{ name: 'web_search', args: { query: 'Pekka Laaksonen hallitus' } }],
    });
    app.llm.push({
      citations: [
        { url: 'https://valtioneuvosto.example/mv', title: 'Matti Virtanen – ministeri' },
      ],
    });
    app.llm.push({ text: 'Löytyi.' });
    await send(page, 'Hae Matti Virtanen');
    const card = page.getByRole('region', { name: 'Haku sisältää henkilötiedon' });
    await expect(card).toContainText('Matti Virtanen hallitus');
    await expect(card).toContainText('Kysely lähtee hakupalveluun sellaisenaan.');
    await card.getByRole('button', { name: 'Hyväksy' }).click();
    await expect(page.locator('.md').last()).toHaveText('Löytyi.');
    await expect(thread(page).getByRole('button', { name: /^web_search 1 tulos/ })).toBeVisible();

    // Deny: no search, the row says "estetty", and the model reads why.
    app.llm.push({ toolCalls: [{ name: 'web_search', args: { query: 'Pekka Laaksonen' } }] });
    app.llm.push({ text: 'Selvä, haen ilman nimeä.' });
    await send(page, 'Hae vielä Matti Virtanen');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Hylkää' }).click();
    await expect(page.locator('.md').last()).toHaveText('Selvä, haen ilman nimeä.');
    await expect(thread(page).getByRole('button', { name: /^web_search estetty/ })).toBeVisible();
    expect(JSON.stringify(app.llm.requests.at(-1)?.body)).toContain(SEARCH_DENIED);
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
    await row.getByRole('button', { name: 'Aja nyt: aamu' }).click();
    await expect(row).toContainText(/käynnissä|onnistui/);
  });
});

test.describe('admin', () => {
  // Phase-15 gate: the editors, devices and the full export. The run times are Helsinki times.
  test.use({ timezoneId: 'Europe/Helsinki' });

  test('agents: rename in the form, YAML and back, the picker shows the new name', async ({
    app,
    page,
  }) => {
    await app.login(page);
    await editAgent(page, 'Tutkija');
    const name = page.getByLabel('Nimi', { exact: true });
    await name.fill('Tutkija Pro');
    // The dry run merges the form into the file: the comments stay.
    await page.getByRole('tab', { name: 'YAML' }).click();
    const yaml = page.getByLabel('Tiedosto', { exact: true });
    await expect(yaml).toHaveValue(/^name: Tutkija Pro$/m);
    await expect(yaml).toHaveValue(/# Children ask for their own gated tools\./);
    await yaml.fill((await yaml.inputValue()).replace('Tutkija Pro', 'Tutkija Plus'));
    await page.getByRole('tab', { name: 'Lomake' }).click();
    await expect(name).toHaveValue('Tutkija Plus');
    await page.getByRole('button', { name: 'Tallenna' }).click();
    await expect(page.getByRole('button', { name: 'Toiminnot: Tutkija Plus' })).toBeVisible();
    await newChat(page);
    await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Tutkija Plus' })).toBeVisible();
  });

  test('automations: Arkisin klo 7.30 shows five next runs, saves, turns off', async ({
    app,
    page,
  }) => {
    await app.login(page);
    const runs = await newAutomation(page);
    for (const r of await runs.all()) await expect(r).toHaveText(/^(ma|ti|ke|to|pe) .+ klo 7\.30$/);
    await page.getByRole('button', { name: 'Tallenna' }).click();
    const row = page.getByRole('row', { name: /Aamukatsaus/ });
    await expect(row).toContainText('Arkisin klo 7.30');
    await expect(row).toContainText(/(ma|ti|ke|to|pe) .+ klo 7\.30/);
    const on = row.getByRole('switch', { name: 'Käytössä: Aamukatsaus' });
    await expect(on).toBeChecked();
    await on.click();
    await expect(on).not.toBeChecked();
    await expect(row).toContainText('–');
  });

  test('devices: revoke all signs the other browser out, this one stays', async ({
    app,
    page,
    browser,
  }) => {
    const { context: other, page: second } = await secondDevice(app, browser);
    await app.login(page);
    const list = await deviceRows(page);
    await expect(list.filter({ hasText: 'Tämä laite' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Kirjaa ulos kaikkialta' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Kirjaa ulos' }).click();
    await expect(second.getByRole('button', { name: 'Kirjaudu', exact: true })).toBeVisible();
    await expect(list).toHaveCount(1);
    // The new cookie of this device works after a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Uusi keskustelu' }).first()).toBeVisible();
    await other.close();
  });

  test('agents: a failed dry run keeps the YAML tab and its text; leaving asks first', async ({
    app,
    page,
  }) => {
    await app.login(page);
    await editAgent(page, 'Tutkija');
    await page.getByRole('tab', { name: 'YAML' }).click();
    const yaml = page.getByLabel('Tiedosto', { exact: true });
    const bad = (await yaml.inputValue()).replace('model: zdr/strong', 'model: zdr/ei-ole');
    await yaml.fill(bad);
    await page.getByRole('tab', { name: 'Lomake' }).click();
    await expect(page.getByText('model: unknown model zdr/ei-ole')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true');
    await expect(yaml).toHaveValue(bad);
    await expect(yaml).toBeFocused();
    expect(readFileSync(join(app.dataDir, 'agents/research.yaml'), 'utf8')).toContain(
      'model: zdr/strong',
    );
    // Unsaved: a navigation away is held and asked.
    await newChat(page);
    const ask = page.getByRole('alertdialog', { name: 'Hylätäänkö tallentamattomat muutokset?' });
    await expect(ask).toBeVisible();
    await expect(yaml).toBeAttached();
    await ask.getByRole('button', { name: 'Hylkää muutokset' }).click();
    await expect(page.getByLabel('Viesti')).toBeVisible();
  });

  test('devices: a revoke from another browser signs this one out (4401), then the last one itself', async ({
    app,
    page,
    browser,
  }) => {
    await app.login(page);
    const { context: other, page: second } = await secondDevice(app, browser);
    const rows = await deviceRows(second);
    // The row without "Tämä laite" is `page`: its socket closes with 4401.
    await rows
      .filter({ hasNotText: 'Tämä laite' })
      .getByRole('button', { name: /^Kirjaa ulos: .+, kirjautunut / })
      .click();
    await expect(page.getByRole('button', { name: 'Kirjaudu', exact: true })).toBeVisible();
    await expect(rows).toHaveCount(1);
    await rows.getByRole('button', { name: / \(tämä laite\)$/ }).click();
    await second.getByRole('alertdialog').getByRole('button', { name: 'Kirjaa ulos' }).click();
    await expect(second.getByRole('button', { name: 'Kirjaudu', exact: true })).toBeVisible();
    await other.close();
  });

  test('export: real names need a fresh sign-in; the masked export does not', async ({
    app,
    page,
  }) => {
    await app.login(page);
    // An 11-minute-old session: past the 10-minute fresh-login rule.
    const db = new DatabaseSync(join(app.dataDir, 'app.db'));
    db.prepare('UPDATE authSessions SET createdAt = ?').run(
      new Date(Date.now() - 11 * 60_000).toISOString(),
    );
    db.close();
    await openSettings(page, 'Asetukset');
    await page.getByRole('button', { name: 'Vie kaikki', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Vie kaikki tiedot' });
    const unmask = dialog.getByRole('switch', { name: 'Näytä oikeat nimet' });
    await unmask.click();
    await dialog.getByLabel('Salasana', { exact: true }).fill('pitkä salasana 1');
    await dialog.getByLabel('Salasana uudelleen').fill('pitkä salasana 1');
    await dialog.getByRole('button', { name: 'Aloita' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Oikeat nimet vaativat tuoreen kirjautumisen. Kirjaudu ulos ja takaisin sisään, ja yritä uudelleen.',
    );
    await unmask.click();
    await dialog.getByRole('button', { name: 'Aloita' }).click();
    await expect(dialog.getByRole('link', { name: 'Lataa' })).toBeVisible();
  });

  test('export: a masked export builds and downloads once', async ({ app, page }) => {
    app.llm.push({ text: 'Hei.' });
    await app.login(page);
    await send(page, 'Moi');
    await expect(page.locator('.md').last()).toHaveText('Hei.');
    await openSettings(page, 'Asetukset');
    await page.getByRole('button', { name: 'Vie kaikki', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Vie kaikki tiedot' });
    await expect(dialog.getByRole('switch', { name: 'Näytä oikeat nimet' })).not.toBeChecked();
    await dialog.getByLabel('Salasana', { exact: true }).fill('pitkä salasana 1');
    const start = dialog.getByRole('button', { name: 'Aloita' });
    await expect(start).toBeDisabled();
    await dialog.getByLabel('Salasana uudelleen').fill('pitkä salasana 1');
    await start.click();
    const link = dialog.getByRole('link', { name: 'Lataa' });
    await expect(link).toBeVisible();
    await expect(dialog.locator('code')).toHaveText(/^openssl enc -d -aes-256-cbc .+\.zip$/);
    const href = await link.getAttribute('href');
    const download = page.waitForEvent('download');
    await link.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.zip\.enc$/);
    expect(
      readFileSync(await file.path())
        .subarray(0, 8)
        .toString(),
    ).toBe('Salted__');
    await expect(dialog).toHaveCount(0);
    // Once: the file is gone after the download.
    await expect.poll(async () => (await page.request.get(href ?? '')).status()).not.toBe(200);
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
