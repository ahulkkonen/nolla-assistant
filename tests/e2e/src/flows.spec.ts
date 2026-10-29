import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { SEARCH_DENIED } from '@pa/server/src/search-tool.ts';
import { devices, type Page } from '@playwright/test';
import {
  type App,
  acceptProposal,
  CHART_REPLY,
  COLLIDING,
  CONFIDENCE_PLAIN,
  CONFIDENCE_REPLY,
  DICT,
  deviceRows,
  editAgent,
  expect,
  flip,
  HTML_REPLY,
  holdAt,
  MERMAID_REPLY,
  memoryTurns,
  mockMic,
  mockPush,
  NWP_REPLY,
  newAutomation,
  openFiles,
  openSettings,
  openVault,
  PAGE_REPLY,
  png,
  REFUSED_REPLY,
  search,
  searchTurns,
  secondDevice,
  seedClaims,
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
/** The chat's two phase-21 switches: composer chips on the desktop, the model sheet on a phone. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
];

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

test('waiting line: steps with the real events; the first token takes its place without a move; the receipt stays', async ({
  app,
  page,
}) => {
  const long = Array.from({ length: 30 }, (_, i) => `Kappale ${i + 1}: pitkä vastaus.`).join(
    '\n\n',
  );
  app.llm.push({ text: long });
  app.llm.push({ text: 'Kevät on hyvä aika aloittaa.', queueMs: 1500 });
  // Once armed, holds the server's frames from the next delta on.
  let armed = false;
  let holding = false;
  const held: (string | Buffer)[] = [];
  let deliver: (m: string | Buffer) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    deliver = (m) => ws.send(m);
    server.onMessage((m) => {
      if (armed && typeof m === 'string' && JSON.parse(m).type === 'message.delta') holding = true;
      if (holding) return void held.push(m);
      ws.send(m);
    });
  });
  await app.login(page);
  await send(page, 'Kirjoita pitkästi');
  await expect(page.locator('.md').last()).toContainText('Kappale 30');
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  armed = true;
  await send(page, 'Milloin kasvimaa kannattaa aloittaa?');
  await expect(
    thread(page)
      .getByText(/^jonossa \d+ s$/)
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('status', { name: 'Vastaus tulossa' })).toHaveText('Jonossa');
  await expect.poll(() => held.length).toBeGreaterThan(0);
  const bubble = thread(page).getByText('Milloin kasvimaa kannattaa aloittaa?', { exact: true });
  const before = await bubble.boundingBox();
  // The first token: the text takes the 28 px first line, the line moves into the action row.
  deliver(held.shift() as string);
  await expect(page.locator('.md').last()).not.toBeEmpty();
  await expect(
    thread(page)
      .getByText(/^kirjoittaa \d+ s$/)
      .last(),
  ).toBeVisible();
  expect(await bubble.boundingBox()).toEqual(before);
  [armed, holding] = [false, false];
  for (const m of held.splice(0)) deliver(m);
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  // The receipt from the stored times; it stays after a reload.
  const receipt = page
    .locator('[data-message-id]')
    .last()
    .getByText(/^Jonotti \d+ s$/);
  await expect(receipt).toBeVisible();
  expect(await bubble.boundingBox()).toEqual(before);
  await page.reload();
  await page.locator('nav li > button').first().click();
  await expect(receipt).toBeVisible();
});

test.describe('android keyboard', () => {
  // Phase 26: Pixel 7 (412 x 839, touch). `resizes-content` shrinks the layout viewport, so the
  // keyboard is a 330 px smaller viewport here (the method of the mobile composer audit).
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  test.use(pixel);

  test("keyboard: the thread keeps its bottom or the reader's place, no pill; a send keeps the keyboard", async ({
    app,
    page,
  }) => {
    const long = Array.from({ length: 30 }, (_, i) => `Kappale ${i + 1}: pitkä vastaus.`).join(
      '\n\n',
    );
    app.llm.push({ text: long });
    app.llm.push({ text: long });
    await app.login(page);
    for (const q of ['Ensimmäinen kysymys', 'Toinen kysymys']) {
      await page.getByLabel('Viesti').fill(q);
      await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
      await expect(page.locator('.md').last()).toContainText('Kappale 30');
      await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
    }
    const region = thread(page);
    const view = page.viewportSize() ?? { width: 412, height: 839 };
    /** Two frames: the resize observer and a scroll event of the resize have run by then. */
    const frames = () =>
      page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
    const keyboard = async (open: boolean) => {
      await page.setViewportSize({ ...view, height: view.height - (open ? 330 : 0) });
      await frames();
    };
    /** How far the last message's end sits below the thread's bottom edge (> 0: hidden). */
    const hidden = () =>
      region.evaluate((el) => {
        const last = Array.from(el.querySelectorAll('[data-message-id]')).at(-1);
        return (last?.getBoundingClientRect().bottom ?? 0) - el.getBoundingClientRect().bottom;
      });
    const gap = () => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    const pill = page.getByRole('button', { name: /^Uusimpaan/ });

    await page.getByLabel('Viesti').tap();
    await keyboard(true);
    await expect.poll(hidden).toBeLessThanOrEqual(0);
    await page.getByLabel('Viesti').fill('Kolmas kysymys\nrivi 2\nrivi 3');
    await expect.poll(hidden).toBeLessThanOrEqual(0);
    await frames();
    await expect(pill).toHaveCount(0);

    // Scrolled up 400 px: the keyboard keeps the reader's distance to the bottom.
    await page.getByLabel('Viesti').fill('');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await keyboard(false);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await region.evaluate((el) => el.scrollBy(0, -400));
    await expect(pill).toBeVisible();
    await page.getByLabel('Viesti').tap();
    await keyboard(true);
    await expect.poll(async () => Math.abs((await gap()) - 400)).toBeLessThanOrEqual(1);

    // "Lähetä" keeps the textarea's focus, so the keyboard stays open.
    app.llm.push({ text: 'Lyhyt vastaus.' });
    await page.getByLabel('Viesti').fill('Kolmas kysymys');
    await page.getByRole('button', { name: 'Lähetä', exact: true }).tap();
    await expect(page.locator('.md').last()).toHaveText('Lyhyt vastaus.');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Viesti',
    );
  });
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

/** LONG_MD with a reference link per section and a sources list of definitions at the end. */
const LONG_REFS = `${LONG_MD.replace(/\[linkki\]\(https:\/\/example\.com\/(\d+)\)/g, '[lähde][$1]')}\n\nLähteet:\n\n${Array.from(
  { length: 125 },
  (_, i) => `[${i}]: https://example.com/${i}`,
).join('\n')}\n`;

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

/** Streams `text` paced and returns "N commits, M ms script" for the stream. */
const measureStream = async (app: App, page: Page, text: string, check: () => Promise<void>) => {
  app.llm.push({ text });
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
  await check();
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  return `${(await commits()) - c0} commits, ${Math.round(((await script()) - s0) * 1000)} ms script`;
};

test('long stream with a sources list: render cost', async ({ app, page }) => {
  test.setTimeout(120_000);
  const cost = await measureStream(app, page, LONG_REFS, () =>
    expect(page.locator('.md').last().locator('a[href="https://example.com/124"]')).toHaveCount(1, {
      timeout: 60_000,
    }),
  );
  console.log(`long stream with sources: ${cost}`);
  test.info().annotations.push({ type: 'long stream with sources', description: cost });
});

test('long stream: render cost, then the jump-to-latest pill', async ({ app, page }) => {
  test.setTimeout(120_000);
  const cost = await measureStream(app, page, LONG_MD, () =>
    expect(page.locator('.md').last().locator('table')).toHaveCount(125, { timeout: 60_000 }),
  );
  console.log(`long stream: ${cost}`);
  test.info().annotations.push({ type: 'long stream', description: cost });

  // A second long reply: scrolled up while it streams, the follow stops and the pill shows.
  app.llm.push({ text: LONG_MD });
  const region = thread(page);
  const gap = () => region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const pill = page.getByRole('button', { name: 'Uusimpaan' });
  await send(page, 'Vielä toinen');
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toBeVisible();
  await region.hover();
  await page.mouse.wheel(0, -3000);
  await expect(pill).toBeVisible();
  const top = await region.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(300);
  expect(await region.evaluate((el) => el.scrollTop)).toBe(top);
  await pill.click();
  await expect(pill).toHaveCount(0);
  await expect.poll(gap).toBeLessThan(48);
  // The follow resumed: the thread is still at the bottom when the reply ends.
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(gap).toBeLessThan(48);

  // End inside the thread jumps too.
  await page.mouse.wheel(0, -3000);
  await expect(pill).toBeVisible();
  await region.getByRole('region', { name: 'Koodi: ts' }).first().focus();
  await page.keyboard.press('End');
  await expect(pill).toHaveCount(0);
  await expect.poll(gap).toBeLessThan(48);
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

for (const viewport of VIEWPORTS)
  test.describe(`auto-approve ${viewport.width}`, () => {
    // Phase-21 decision 7: the fake broker gives the chat a `bash` tool (in `approval.always`).
    test.use({ broker: true, viewport });

    test('Hyväksy automaattisesti: bash runs without a card; off, the card is back', async ({
      app,
      page,
    }) => {
      app.llm.push({ text: 'Hei.', match: 'Moi' });
      for (const [match, command] of [
        ['Aja komento', 'echo valmis'],
        ['Toinen komento', 'echo taas'],
      ] as const) {
        app.llm.push({ toolCalls: [{ name: 'bash', args: { command } }], match });
        app.llm.push({ text: 'Ajettu.', match });
      }
      await app.login(page);
      await send(page, 'Moi');
      await expect(page.locator('.md').last()).toHaveText('Hei.');
      // The tools: the chip's tooltip, the sheet row's secondary text.
      if (viewport.width < 768) {
        await page.getByRole('button', { name: /^Malli: / }).click();
        await expect(
          page.getByRole('switch', { name: 'Hyväksy automaattisesti' }),
        ).toHaveAccessibleDescription(/write, edit, bash/);
        await page.keyboard.press('Escape');
      } else {
        await page.getByRole('button', { name: 'Hyväksy automaattisesti' }).hover();
        await expect(page.getByRole('tooltip')).toContainText('write, edit, bash');
      }
      await flip(page, 'Hyväksy automaattisesti', true);

      await send(page, 'Aja komento');
      await expect(page.getByRole('button', { name: /^bash valmis/ })).toBeVisible();
      await expect(page.locator('.md').last()).toHaveText('Ajettu.');
      await expect(page.getByRole('heading', { name: /Hyväksytäänkö työkalu/ })).toHaveCount(0);

      // Off: the gate asks again.
      await flip(page, 'Hyväksy automaattisesti', false);
      await send(page, 'Toinen komento');
      const card = page.getByRole('region', { name: /Hyväksytäänkö työkalu bash/ });
      await expect(card).toContainText('echo taas');
      await card.getByRole('button', { name: 'Hyväksy' }).click();
      await expect(page.getByRole('button', { name: /^bash valmis/ })).toHaveCount(2);
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
  // Phase 21: "Uusimmat" in lab order, Anthropic's alias target and Google's newest model; Opus
  // is neither and stays in "Kaikki mallit". The search filters every section.
  const latest = catalog.getByRole('region', { name: 'Uusimmat' });
  const all = catalog.getByRole('region', { name: 'Kaikki mallit' });
  await expect(latest.getByRole('listitem')).toHaveText([/^Claude Fable 5\.1/, /^Gemini 4 Argon/]);
  await expect(all.getByRole('listitem')).toHaveText([/^Claude Opus 5\.5/]);
  const search = catalog.getByRole('textbox', { name: 'Hae malleja' });
  await search.fill('argon');
  await expect(latest.getByRole('listitem')).toHaveText([/^Gemini 4 Argon/]);
  await expect(all).toHaveCount(0);
  await search.fill('opus');
  await expect(latest).toHaveCount(0);
  await search.fill('');
  await catalog.getByRole('button', { name: 'Lisää suosikkeihin: Claude Fable 5.1' }).click();
  await expect(catalog.getByRole('heading', { name: 'Suosikit' })).toBeVisible();
  // Listed once; the star keeps the focus when its row moves to Suosikit.
  await expect(catalog.getByRole('button', { name: /: Claude Fable 5\.1$/ })).toHaveCount(1);
  await expect(
    catalog.getByRole('button', { name: 'Poista suosikeista: Claude Fable 5.1' }),
  ).toBeFocused();
  await expect(latest.getByRole('listitem')).toHaveText([/^Gemini 4 Argon/]);
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
  const alert = page.getByRole('alert').filter({ hasText: 'Mallikutsu epäonnistui (400)' });
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
    await page.getByRole('button', { name: 'Lataa', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Tallenna työkansioon' }).click();
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

  test('thinking: the waiting line thinks, then "Ajatteli … s" opens to the text; the switch hides it', async ({
    app,
    page,
  }) => {
    app.llm.push(THINKING_TURN);
    await app.login(page);
    await send(page, 'Milloin kasvimaa kannattaa aloittaa?');
    // Phase 26: the waiting line carries the live thinking.
    await expect(
      thread(page)
        .getByText(/^ajattelee \d+ s$/)
        .first(),
    ).toBeVisible();
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
    // Phase 16: the prompt cache hit rate, here and in the menu.
    await expect(reply.getByText('3,4 k tokenia · välimuisti 82 %')).toBeVisible();
    // The desktop header shows the chat's total (phase 16).
    await expect(page.locator('main header').getByText('0,012 € · 3,4 k tokenia')).toBeVisible();
    const row = page.locator('nav li', { hasText: 'Kasvimaa' });
    await row.hover();
    await row.getByRole('button', { name: 'Lisää: Kasvimaa' }).click();
    await expect(
      page.getByRole('menu').getByText('0,012 € · 3,4 k tokenia · välimuisti 82 %'),
    ).toBeVisible();
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
    await expect(table.getByRole('columnheader', { name: 'Välimuisti' })).toBeVisible();
    await expect(table.getByRole('cell', { name: '82 %' })).toBeVisible();
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
  await page.getByRole('menuitemradio', { name: 'Kirjoittaja' }).click();
  await expect(page.getByRole('button', { name: 'Agentti: Kirjoittaja' })).toBeVisible();
  await page.getByLabel('Viesti').fill('Tutki tätä');
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
  await expect(page.locator('.md').last()).toHaveText('Tutkitaan.');
  // The chip now reads the chat's own agentId from the server and is locked.
  const chip = page.getByRole('button', { name: 'Agentti: Kirjoittaja' });
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
    await editAgent(page, 'Kirjoittaja');
    const name = page.getByLabel('Nimi', { exact: true });
    await name.fill('Kirjoittaja Pro');
    // The dry run merges the form into the file: the comments stay.
    await page.getByRole('tab', { name: 'YAML' }).click();
    const yaml = page.getByLabel('Tiedosto', { exact: true });
    await expect(yaml).toHaveValue(/^name: Kirjoittaja Pro$/m);
    await expect(yaml).toHaveValue(/# Test-only second profile/);
    await yaml.fill((await yaml.inputValue()).replace('Kirjoittaja Pro', 'Kirjoittaja Plus'));
    await page.getByRole('tab', { name: 'Lomake' }).click();
    await expect(name).toHaveValue('Kirjoittaja Plus');
    await page.getByRole('button', { name: 'Tallenna' }).click();
    await expect(page.getByRole('button', { name: 'Toiminnot: Kirjoittaja Plus' })).toBeVisible();
    await newChat(page);
    await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Kirjoittaja Plus' })).toBeVisible();
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
    await editAgent(page, 'Kirjoittaja');
    await page.getByRole('tab', { name: 'YAML' }).click();
    const yaml = page.getByLabel('Tiedosto', { exact: true });
    const bad = (await yaml.inputValue()).replace('model: zdr/strong', 'model: zdr/ei-ole');
    await yaml.fill(bad);
    await page.getByRole('tab', { name: 'Lomake' }).click();
    await expect(page.getByText('model: unknown model zdr/ei-ole')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true');
    await expect(yaml).toHaveValue(bad);
    await expect(yaml).toBeFocused();
    expect(readFileSync(join(app.dataDir, 'agents/kirjoittaja.yaml'), 'utf8')).toContain(
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

test.describe('claims', () => {
  // Phase-17 W1: the Havainnot tab and the chat chip, on claims seeded into app.db.
  test.use({ pseudo: 'full', memoryUser: USER_MD });

  /** A chat with one reply, then the seeded claims; returns the chat id. */
  const claimChat = async (app: App, page: Page) => {
    app.llm.push({ text: 'Hei.' });
    await app.login(page);
    await send(page, 'Moi');
    await expect(page.locator('.md').last()).toHaveText('Hei.');
    const db = new DatabaseSync(join(app.dataDir, 'app.db'));
    const { id } = db.prepare('SELECT id FROM chats LIMIT 1').get() as { id: string };
    db.close();
    seedClaims(app, id);
    return id;
  };
  const openClaims = async (page: Page) => {
    await openSettings(page, 'Muisti');
    await page.getByRole('tab', { name: 'Havainnot' }).click();
  };
  const card = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text });
  const section = (page: Page, name: string) =>
    page.getByRole('region', { name: new RegExp(`^${name}`) });

  test('accept: a proposal and a supersede become active; the old claim is superseded', async ({
    app,
    page,
  }) => {
    await claimChat(app, page);
    await openClaims(page);
    await expect(page.getByText('Hyväksytty 1 · hylätty 1')).toBeVisible();
    await card(page, 'Käyttäjä haluaa vastaukset lyhyinä.')
      .getByRole('button', { name: 'Hyväksy' })
      .click();
    await expect(section(page, 'Aktiiviset')).toContainText('Käyttäjä haluaa vastaukset lyhyinä.');
    await expect(page.getByText('Hyväksytty 2 · hylätty 1')).toBeVisible();
    const tea = card(page, 'Käyttäjä juo aamuisin teetä.');
    await expect(tea).toContainText('KorvaaKäyttäjä juo aamuisin kahvia.');
    await tea.getByRole('button', { name: 'Hyväksy' }).click();
    await expect(section(page, 'Aktiiviset')).toContainText('Käyttäjä juo aamuisin teetä.');
    await expect(section(page, 'Aktiiviset')).not.toContainText('Käyttäjä juo aamuisin kahvia.');
    await page.getByRole('button', { name: /^Korvatut/ }).click();
    await expect(section(page, 'Korvatut')).toContainText('Käyttäjä juo aamuisin kahvia.');
  });

  test('edit: an edited proposal is accepted with the new text', async ({ app, page }) => {
    await claimChat(app, page);
    await openClaims(page);
    await card(page, 'Käyttäjä harjoittelee puolimaratonille.')
      .getByRole('button', { name: 'Muokkaa' })
      .click();
    const field = page.getByLabel('Havainto');
    // The card by its editor: the claim text is in the field now, not in the card's text.
    const run = page.getByRole('listitem').filter({ has: field });
    await field.fill('ab');
    await expect(run.getByRole('button', { name: 'Hyväksy' })).toBeDisabled();
    await field.fill('Käyttäjä juoksee puolimaratonin toukokuussa.');
    await run.getByRole('button', { name: 'Hyväksy' }).click();
    await expect(section(page, 'Aktiiviset')).toContainText(
      'Käyttäjä juoksee puolimaratonin toukokuussa.',
    );
    await expect(section(page, 'Ehdotetut')).not.toContainText('puolimaraton');
  });

  test('reject: a rejected proposal leaves the list and counts', async ({ app, page }) => {
    await claimChat(app, page);
    await openClaims(page);
    await card(page, 'Käyttäjä haluaa vastaukset lyhyinä.')
      .getByRole('button', { name: 'Hylkää' })
      .click();
    await expect(page.getByText('Hyväksytty 1 · hylätty 2')).toBeVisible();
    await expect(page.getByText('Käyttäjä haluaa vastaukset lyhyinä.')).toHaveCount(0);
  });

  test('expiry: an active claim gets an end date', async ({ app, page }) => {
    await claimChat(app, page);
    await openClaims(page);
    const cat = card(page, 'Käyttäjän kissa on nimeltään Miuku.');
    await cat.getByRole('button', { name: 'Voimassa asti' }).click();
    await cat.getByLabel('Voimassa asti').fill('2030-12-31');
    await cat.getByRole('button', { name: 'Tallenna' }).click();
    await expect(card(page, 'Käyttäjän kissa on nimeltään Miuku.')).toContainText(
      'voimassa 31.12.2030 asti',
    );
  });

  test('keep: a stale claim is confirmed and leaves the stale list', async ({ app, page }) => {
    await claimChat(app, page);
    await openClaims(page);
    const stale = section(page, 'Vanhentuvat');
    await expect(stale).toContainText('Näitä ei ole vahvistettu 90 päivään.');
    await stale.getByRole('button', { name: 'Pidä' }).click();
    await expect(stale).toHaveCount(0);
    await expect(section(page, 'Aktiiviset')).toContainText('Käyttäjä käy salilla tiistaisin.');
  });

  test('lower: a stale claim loses 20 points of confidence', async ({ app, page }) => {
    await claimChat(app, page);
    await openClaims(page);
    await section(page, 'Vanhentuvat').getByRole('button', { name: 'Laske luottamusta' }).click();
    await expect(section(page, 'Vanhentuvat')).toHaveCount(0);
    await expect(card(page, 'Käyttäjä käy salilla tiistaisin.')).toContainText('varmuus 60 %');
  });

  test('chip: an auto claim shows under the reply and Kumoa rejects it', async ({ app, page }) => {
    await claimChat(app, page);
    await page.reload();
    await page.locator('nav li > button').first().click();
    const chip = page.getByRole('list', { name: 'Uudet havainnot' });
    await expect(chip).toContainText('Muisti: Käyttäjä asuu Tampereella.');
    await chip.getByRole('button', { name: 'Kumoa: Käyttäjä asuu Tampereella.' }).click();
    await expect(chip).toHaveCount(0);
    // Gone for good: the claim counts as rejected, and the reopened chat has no chip. (The
    // server holds app.db exclusively, so the test reads its state through the UI.)
    await openClaims(page);
    await expect(page.getByText('Hyväksytty 1 · hylätty 2')).toBeVisible();
    await page.reload();
    await page.locator('nav li > button').first().click();
    await expect(page.locator('.md').last()).toHaveText('Hei.');
    await expect(page.getByRole('list', { name: 'Uudet havainnot' })).toHaveCount(0);
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
    await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(/Lempiväri on sininen\./);
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
    await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(/Lempiväri on vihreä\./);
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
  await page.getByRole('button', { name: 'Avaa paneelissa' }).click();
  await expect(panel).toBeVisible();
});

test('streaming: an html block shows the writing card, never its source; long code stays code', async ({
  app,
  page,
}) => {
  app.llm.push({ text: PAGE_REPLY });
  const hold = await holdAt(page, '<h1>Raportti');
  await app.login(page);
  await send(page, 'Tee raportti');
  await hold.reached;
  // Phase-20 decision 8: the kind, the title and the line count; no source, no button.
  const card = thread(page).locator('[aria-busy="true"]');
  await expect(card).toContainText('Kuukausiraportti');
  await expect(card).toContainText(/HTML-sivu · kirjoittaa… \d+ riviä/);
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(thread(page).locator('pre')).toHaveCount(0);
  await expect(thread(page).getByText('<h1>', { exact: false })).toHaveCount(0);
  hold.release();
  await expect(thread(page).getByText('Sivu on valmis.')).toBeVisible();
  await expect(card).toHaveCount(0);

  // Decision 11: a 40-line block of code is code, with Kopioi, and no artifact.
  const py = Array.from({ length: 40 }, (_, i) => `print(${i + 1})`).join('\n');
  app.llm.push({ text: `Koodi:\n\n\`\`\`python\n${py}\n\`\`\`` });
  await page.getByRole('button', { name: 'Sulje artefaktit' }).click();
  await send(page, 'Kirjoita koodi');
  const code = thread(page).getByRole('region', { name: 'Koodi: python' });
  await expect(code).toContainText('print(40)');
  await expect(code.locator('xpath=..').getByRole('button', { name: 'Kopioi' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Avaa artefaktina' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Artefaktit' })).toHaveCount(0);
});

test('queue: a message waits for the reply, Peru gives it back, then it goes after the reply; the model chip opens during a run', async ({
  app,
  page,
}) => {
  const long = Array.from({ length: 20 }, (_, i) => `Kappale ${i + 1}: vastaus jatkuu.`).join(
    '\n\n',
  );
  app.llm.push({ text: long });
  app.llm.push({ ...titleTurn('Jono', 'Käyttäjä kokeili jonoa.'), match: 'Aiheet:' });
  app.llm.push({ text: 'Jonon viestiin vastattu.', match: 'Toinen kysymys' });
  const hold = await holdAt(page, 'Kappale 3');
  await app.login(page);
  await send(page, 'Kirjoita pitkä vastaus');
  await hold.reached;
  // Phase-20 decision 15: the chip opens during a run; the change is for the next reply.
  const chip = page.getByRole('button', { name: /^Malli: / });
  await chip.hover();
  await expect(page.getByRole('tooltip')).toContainText('Muutos koskee seuraavaa vastausta');
  await chip.click();
  await expect(page.getByRole('menuitemradio', { name: /^Auto/ })).toBeVisible();
  await chip.click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Decision 17: text during a reply shows Pysäytä and Lisää jonoon; Enter queues.
  await page.getByLabel('Viesti').fill('Toinen kysymys');
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lisää jonoon' })).toBeVisible();
  await page.getByLabel('Viesti').press('Enter');
  const row = page.getByText('Jonossa', { exact: true }).locator('..');
  await expect(row).toContainText('Toinen kysymys');
  await expect(page.getByLabel('Viesti')).toHaveValue('');
  await row.getByRole('button', { name: 'Peru jonotus' }).click();
  await expect(page.getByText('Jonossa', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Viesti')).toHaveValue('Toinen kysymys');

  // Queued again: it goes when the reply has ended, as a new turn.
  await page.getByRole('button', { name: 'Lisää jonoon' }).click();
  await expect(row).toContainText('Toinen kysymys');
  await expect(thread(page).getByText('Toinen kysymys', { exact: true })).toHaveCount(0);
  hold.release();
  await expect(thread(page).getByText('Toinen kysymys', { exact: true })).toBeVisible();
  await expect(page.locator('.md').last()).toHaveText('Jonon viestiin vastattu.');
  await expect(page.getByText('Jonossa', { exact: true })).toHaveCount(0);
});

for (const viewport of VIEWPORTS)
  test.describe(`confidence ${viewport.width}`, () => {
    test.use({ viewport });

    test('confidence: the toggle reaches the next turn; each sentence shows its level; copy drops the markers', async ({
      app,
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      app.llm.push({ text: 'Ensin ilman merkintöjä.' });
      app.llm.push({ ...titleTurn('Tampere', 'Käyttäjä kysyi Tampereesta.'), match: 'Aiheet:' });
      app.llm.push({ text: CONFIDENCE_REPLY, match: 'Kerro Tampereesta' });
      await app.login(page);
      await send(page, 'Moi');
      await expect(page.locator('.md').last()).toHaveText('Ensin ilman merkintöjä.');
      await flip(page, 'Luottamus', true);

      await send(page, 'Kerro Tampereesta');
      const reply = page.locator('.md').last();
      await expect(reply).toHaveText(CONFIDENCE_PLAIN);
      const prompt = (text: string) =>
        JSON.stringify(
          app.llm.requests.find((r) => JSON.stringify(r.body.messages).includes(text))?.body
            .messages[0],
        );
      expect(prompt('Moi')).not.toContain('Luottamusmerkinnät');
      expect(prompt('Kerro Tampereesta')).toContain('Luottamusmerkinnät');
      const spans = reply.locator('span.conf');
      await expect(spans).toHaveCount(3);
      await expect(spans.nth(0)).toHaveAttribute('title', 'Luottamus 9/9');
      await expect(spans.nth(1)).toHaveAttribute('title', 'Luottamus 5/9');
      await expect(spans.nth(2)).toHaveAttribute('title', 'Luottamus 1/9');
      // The contrast follows N: 100 is the text colour, 0 is the muted one.
      await expect(spans.nth(0)).toHaveAttribute('style', '--conf: 100;');
      await expect(spans.nth(2)).toHaveAttribute('style', '--conf: 0;');
      const color = (i: number) => spans.nth(i).evaluate((el) => getComputedStyle(el).color);
      expect(await color(2)).not.toBe(await color(0));

      await reply.hover();
      await page.getByRole('button', { name: 'Kopioi', exact: true }).last().click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CONFIDENCE_PLAIN);

      // The flag comes back with `chat.state`; off goes to the server too.
      await page.reload();
      if (viewport.width < 768) await page.getByRole('button', { name: 'Valikko' }).click();
      await page.locator('nav li > button').click({ position: { x: 16, y: 16 } });
      await expect(page.locator('.md').last()).toHaveText(CONFIDENCE_PLAIN);
      await flip(page, 'Luottamus', false);
    });
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
  // Phase 19: the frame loads the sandbox page (its own CSP header) and the document is posted.
  await expect(frame).toHaveAttribute('src', '/api/sandbox');
  const doc = frame.contentFrame();
  await expect(doc.getByRole('heading', { name: 'Skripti ensin' })).toBeVisible();
  await expect(doc.locator('head > :first-child')).toHaveAttribute(
    'content',
    /^default-src 'none';/,
  );
  // The artifact's own script runs (a srcdoc frame inherited the app CSP, which blocked it).
  expect(await doc.locator('html').evaluate(() => document.title)).toBe('x');
});

/** An artifact that tries to leave the sandbox and writes what it got. */
const ESCAPE_REPLY = `Sivu:

\`\`\`html
<h1>Pakotesti</h1><pre id="r"></pre>
<script>
var out = [];
try { out.push('cookie:' + document.cookie); } catch (e) { out.push('cookie:estetty'); }
try { (opener || top).location.href = 'https://example.com/'; } catch (e) {}
fetch('/api/chats').then(function () { return 'fetch:ok'; }, function () { return 'fetch:estetty'; })
  .then(function (f) { out.push(f); document.getElementById('r').textContent = out.join(' '); });
</script>
\`\`\``;

test('sandbox: an artifact cannot read cookies, call the API or navigate its opener', async ({
  app,
  page,
  context,
}) => {
  app.llm.push({ text: ESCAPE_REPLY });
  await app.login(page);
  const url = page.url();
  await send(page, 'Tee sivu');
  const panel = page.getByRole('complementary', { name: 'Artefaktit' });
  await expect(panel.locator('iframe').contentFrame().locator('#r')).toHaveText(
    'cookie:estetty fetch:estetty',
  );
  // "Avaa uudessa ikkunassa": the tab is sandboxed too, and its opener stays where it was.
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: 'Avaa uudessa ikkunassa' }).click(),
  ]);
  await expect(tab.locator('#r')).toHaveText('cookie:estetty fetch:estetty');
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  await tab.close();

  // Another origin that opens the sandbox page cannot have it render anything.
  const other = await context.newPage();
  await other.goto(`${app.url.replace('127.0.0.1', 'localhost')}/healthz`);
  const [foreign] = await Promise.all([
    context.waitForEvent('page'),
    other.evaluate((u) => {
      const w = window.open(`${u}/api/sandbox`);
      setTimeout(() => w?.postMessage('<h1 id="vieras">x</h1>', '*'), 1000);
    }, app.url),
  ]);
  await other.waitForTimeout(1500);
  await expect(foreign.locator('#vieras')).toHaveCount(0);
});

test('vega-lite: the chart renders in the sandbox with the lifted title (phase 19)', async ({
  app,
  page,
}) => {
  app.llm.push({ text: CHART_REPLY });
  await app.login(page);
  await send(page, 'Piirrä kulutus');
  // Phase 20: a chart shows inline; "Avaa paneelissa" opens it in the panel.
  await thread(page).getByRole('button', { name: 'Avaa paneelissa' }).click();
  const panel = page.getByRole('complementary', { name: 'Artefaktit' });
  // The server titles the artifact from the spec's title.text.
  await expect(
    panel.getByRole('heading', { name: 'Sähkönkulutus kuukausittain 2025' }),
  ).toBeVisible();
  const frame = panel.locator('iframe').contentFrame();
  // R1: title, subtitle (with <strong>) and caption are HTML; the number and unit do not break.
  await expect(frame.getByRole('heading', { level: 2 })).toHaveText(
    'Sähkönkulutus kuukausittain 2025',
  );
  await expect(frame.locator('.chart strong')).toHaveText('yli kolme kertaa');
  await expect(frame.locator('figcaption')).toHaveText(/3 370 kWh/);
  await expect(frame.locator('#vis svg')).toBeVisible();
  // R2: the model's font is gone; R7: the bars have the theme's accent.
  await expect(frame.locator('#vis svg text').first()).toHaveAttribute(
    'font-family',
    /Inter Variable/,
  );
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim(),
  );
  await expect(frame.locator('#vis svg .mark-rect path').first()).toHaveAttribute('fill', accent);
});

test('export: chart and diagram download as SVG with inlined fonts, and as PNG', async ({
  app,
  page,
}) => {
  const save = async (item: 'Lataa SVG' | 'Lataa PNG') => {
    // The menu of the previous export must be gone, or the click lands on its closing frame.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('button', { name: 'Lataa', exact: true }).click();
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: item }).click(),
    ]);
    return { name: file.suggestedFilename(), body: readFileSync(await file.path()) };
  };
  app.llm.push({ text: CHART_REPLY });
  await app.login(page);
  await send(page, 'Piirrä kulutus');
  // Phase 20: the panel opens from the inline figure.
  await thread(page).getByRole('button', { name: 'Avaa paneelissa' }).click();
  const frame = page.getByRole('complementary', { name: 'Artefaktit' }).locator('iframe');
  await expect(frame.contentFrame().locator('#vis svg')).toBeVisible();
  const svg = await save('Lataa SVG');
  expect(svg.name).toBe('Sähkönkulutus-kuukausittain-2025.svg');
  const text = svg.body.toString('utf8');
  expect(text).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  expect(text).toContain("@font-face{font-family:'Inter Variable'");
  expect(text).toContain('data:font/woff2;base64,');
  // The lifted title and caption are in the file, the chart's marks too.
  // Phase 21: wrapped into tspan lines.
  expect(text).toContain('Sähkönkulutus kuukausittain 2025</tspan>');
  expect(text).toContain('yhteensä 3 370 kWh');
  expect(text).toContain('mark-rect');
  const png = await save('Lataa PNG');
  expect(png.name).toBe('Sähkönkulutus-kuukausittain-2025.png');
  expect(png.body.subarray(1, 4).toString()).toBe('PNG');
  // Twice the SVG's width (device pixel ratio 2), from the PNG header.
  const width = Number(/width="(\d+)"/.exec(text)?.[1]);
  expect(png.body.readUInt32BE(16)).toBe(width * 2);

  app.llm.push({ text: MERMAID_REPLY });
  await send(page, 'Piirrä suunnitelma');
  // A new figure shows inline and leaves the panel where it is; it opens on request.
  await thread(page)
    .getByRole('figure', { name: 'Lomasuunnitelma' })
    .getByRole('button', { name: 'Avaa paneelissa' })
    .click();
  await expect(frame.contentFrame().locator('.diagram svg')).toBeVisible();
  const diagram = await save('Lataa SVG');
  const exported = diagram.body.toString('utf8');
  expect(exported).toContain('Lomasuunnitelma</tspan>');
  // Phase 21: the arrowheads stay (`url(#…)` is kept), the sheet is at least 560 px wide.
  expect(exported).toMatch(/marker-end="url\(#m[^"]*pointEnd\)"/);
  expect(Number(/width="(\d+)"/.exec(exported)?.[1])).toBeGreaterThanOrEqual(560);
});

/** RGBA of a PNG's first pixel: no filter changes it (every filter adds zeros there). */
const firstPixel = (png: Buffer) => {
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; at += png.readUInt32BE(at) + 12)
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT')
      data.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
  return [...inflateSync(Buffer.concat(data)).subarray(1, 5)];
};

test('inline figures: a chart and a diagram in the thread, keyboard actions, a light PNG in dark mode', async ({
  app,
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  app.llm.push({ text: CHART_REPLY });
  app.llm.push({ text: MERMAID_REPLY });
  await app.login(page);
  await send(page, 'Piirrä kulutus');
  // Phase-20 decision 3: the figure has the chart's title as its name and its own sandbox page.
  const chart = thread(page).getByRole('figure', { name: 'Sähkönkulutus kuukausittain 2025' });
  await expect(
    chart.locator('iframe').contentFrame().locator('#vis svg .mark-rect path').first(),
  ).toBeVisible();
  await expect(chart.getByText('Kuvaaja', { exact: true })).toBeVisible();
  // Keyboard: Tab from the user message reaches both actions, in order.
  await thread(page).getByText('Piirrä kulutus', { exact: true }).click();
  const open = chart.getByRole('button', { name: 'Avaa paneelissa' });
  for (let i = 0; i < 20 && !(await open.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(open).toBeFocused();
  await page.keyboard.press('Tab');
  const png = chart.getByRole('button', { name: 'Lataa PNG' });
  await expect(png).toBeFocused();
  // Decision 7: the export is light whatever the theme.
  const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(file.suggestedFilename()).toBe('Sähkönkulutus-kuukausittain-2025.png');
  expect(firstPixel(readFileSync(await file.path()))).toEqual([255, 255, 255, 255]);

  await send(page, 'Piirrä suunnitelma');
  const diagram = thread(page).getByRole('figure', { name: 'Lomasuunnitelma' });
  await expect(diagram.locator('iframe').contentFrame().locator('.diagram svg')).toBeVisible();
  await expect(diagram.getByText('Kaavio', { exact: true })).toBeVisible();
  const [file2] = await Promise.all([
    page.waitForEvent('download'),
    diagram.getByRole('button', { name: 'Lataa PNG' }).click(),
  ]);
  expect(firstPixel(readFileSync(await file2.path()))).toEqual([255, 255, 255, 255]);
  // "Avaa paneelissa" opens the figure in the panel.
  await diagram.getByRole('button', { name: 'Avaa paneelissa' }).click();
  const panel = page.getByRole('complementary', { name: 'Artefaktit' });
  await expect(panel.getByRole('heading', { name: 'Lomasuunnitelma' })).toBeVisible();
});

test('inline figure: a lazy frame off screen does not fall back after 30 s', async ({
  app,
  page,
}) => {
  test.setTimeout(120_000);
  const prose = Array.from(
    { length: 200 },
    (_, i) => `Kappale ${i + 1}: kaavion jälkeen tulee pitkä selitys, joka vie tilaa.`,
  ).join('\n\n');
  app.llm.push({ text: `${CHART_REPLY}\n\n${prose}` });
  await app.login(page);
  await send(page, 'Piirrä ja selitä');
  await expect(thread(page).getByText('Kappale 200:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
  // The thread follows to the end: the figure is far above, and its lazy frame waits.
  await page.waitForTimeout(31_000);
  const chart = thread(page).getByRole('figure', { name: 'Sähkönkulutus kuukausittain 2025' });
  await chart.scrollIntoViewIfNeeded();
  await expect(
    chart.locator('iframe').contentFrame().locator('#vis svg .mark-rect path').first(),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Kaavion data' })).toHaveCount(0);
});

test('diagram: a model directive keeps our font; subgraph titles paint over the edges; classes colour nodes', async ({
  app,
  page,
}) => {
  // T1: the model's %%{init}%% asks for another font; the secure keys keep ours.
  app.llm.push({
    text: NWP_REPLY.replace(
      'flowchart TD',
      '%%{init: {"themeVariables": {"fontFamily": "Courier New"}}}%%\nflowchart TD',
    ),
  });
  await app.login(page);
  await send(page, 'Piirrä ennuste');
  const doc = thread(page)
    .getByRole('figure', { name: 'Sääennusteen tuotanto' })
    .locator('iframe')
    .contentFrame();
  const label = doc.locator('.diagram svg .node text').first();
  await expect(label).toBeVisible();
  const font = await label.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toMatch(/^"?Inter Variable/);
  expect(await doc.locator('.diagram svg style').first().textContent()).not.toContain('Courier');
  // Decision 26: the cluster label is the last child of its root, after the edges.
  const order = await doc
    .locator('.diagram svg g.root')
    .first()
    .evaluate((root) =>
      Array.from(root.children, (c) => c.getAttribute('class')?.split(' ')[0] ?? c.tagName),
    );
  expect(order.indexOf('cluster-label')).toBeGreaterThan(order.indexOf('edgePaths'));
  // Decision 24, phase 21: `:::alert` without a classDef gets a red tint and dark red text.
  const rgb = (c: string) => c.match(/\d+/g)?.map(Number) ?? [];
  const alert = doc.locator('.diagram svg .node.alert');
  const [r = 0, g = 0, b = 0] = rgb(
    await alert
      .locator('rect')
      .first()
      .evaluate((el) => getComputedStyle(el).fill),
  );
  expect(r).toBeGreaterThan(g);
  expect(r).toBeGreaterThan(b);
  expect(g).toBeGreaterThan(200);
  const [tr = 0, tg = 0] = rgb(
    await alert
      .locator('text')
      .first()
      .evaluate((el) => getComputedStyle(el).fill),
  );
  expect(tr).toBeLessThan(140);
  expect(tr).toBeGreaterThan(tg);
  // Phase 21: the decision is a box with a dashed hairline; every node box is 212 px wide.
  const decision = doc.locator('.diagram svg .node.decision > rect');
  expect(await decision.evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe('4px, 3px');
  expect(await decision.evaluate((el) => (el as SVGRectElement).getBBox().width)).toBe(211);
});

test('vega-lite: a spec with a url falls back to its data as a table (R6)', async ({
  app,
  page,
}) => {
  app.llm.push({ text: REFUSED_REPLY });
  await app.login(page);
  await send(page, 'Piirrä haettu data');
  // Phase 20: the fallback shows in the thread's figure.
  const data = thread(page)
    .getByRole('figure', { name: 'Haettu data' })
    .getByRole('region', { name: 'Kaavion data' });
  await expect(data.getByText('Kaavio epäonnistui')).toBeVisible();
  await expect(data.getByText(/url/)).toBeVisible();
  await expect(data.getByRole('cell', { name: 'Kahvi' })).toBeVisible();
  await expect(data.getByRole('cell', { name: '12' })).toBeVisible();
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
