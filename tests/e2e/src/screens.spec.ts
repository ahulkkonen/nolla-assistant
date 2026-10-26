import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  acceptProposal,
  expect,
  HTML_REPLY,
  memoryTurns,
  mockMic,
  mockPush,
  openSettings,
  openVault,
  search,
  sendMessage,
  showSidebar,
  TAX,
  taxChat,
  test,
  titleTurn,
  USER_MD,
} from './fixtures.ts';

const DIR = join(import.meta.dirname, '../screenshots');
mkdirSync(DIR, { recursive: true });

const sizes = [
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

/** The rules brief 7.8 holds at every impact level (docs/decisions/phase-9-ui.md). */
const BRIEF_RULES = new Set([
  'color-contrast',
  'button-name',
  'link-name',
  'label',
  'select-name',
  'aria-allowed-attr',
  'aria-valid-attr-value',
  'aria-required-children',
  'aria-required-parent',
  'aria-hidden-focus',
  'nested-interactive',
  'scrollable-region-focusable',
  'frame-title',
  'image-alt',
  'html-has-lang',
  'html-lang-valid',
  'meta-viewport',
  'document-title',
  'landmark-one-main',
  'region',
  'page-has-heading-one',
  'heading-order',
  'list',
  'listitem',
  'duplicate-id-aria',
  'td-headers-attr',
  'th-has-data-cells',
]);

/**
 * Axe scan of the screen just shot; the sandboxed artifact iframe is not app UI. With
 * A violation fails the test (unless `AXE_STRICT=0`) when it is serious or critical, or when its rule is
 * one of BRIEF_RULES at any impact. Without it the same violations are printed and the test
 * passes.
 */
const axe = async (page: Page, name: string) => {
  const { violations } = await new AxeBuilder({ page }).exclude('iframe[sandbox]').analyze();
  const found = violations
    // `region` on Radix's popper wrapper only: open menus and tooltips are portalled to <body>,
    // outside every landmark, by Radix's portal structure (not app layout). Other `region`
    // findings still count.
    .map((v) =>
      v.id === 'region'
        ? {
            ...v,
            nodes: v.nodes.filter(
              (n) => !n.target.join(' ').includes('data-radix-popper-content-wrapper'),
            ),
          }
        : v,
    )
    .filter((v) => v.nodes.length)
    .filter((v) => v.impact === 'serious' || v.impact === 'critical' || BRIEF_RULES.has(v.id))
    .map((v) => `${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  if (process.env.AXE_STRICT !== '0') expect(found, `axe: ${name}`).toEqual([]);
  else for (const f of found) console.warn(`axe: ${name}: ${f}`);
};

const shot = async (page: Page, screen: string, w: number, scheme: string) => {
  // Let transitions and the caret settle.
  await page.waitForTimeout(400);
  const noScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(noScroll, `${screen} scrolls horizontally`).toBe(true);
  const path = join(DIR, `${screen}-${w}-${scheme}.png`);
  await page.screenshot({ path, fullPage: false });
  expect(existsSync(path)).toBe(true);
  await axe(page, `${screen}-${w}-${scheme}`);
};

/** Opens the composer's model menu (phase-10). */
const modelMenu = (page: Page) => page.getByRole('button', { name: /^Malli: / }).click();

/** Picks a model for the chat from "Kaikki mallit". */
const pickModel = async (page: Page, name: string) => {
  await modelMenu(page);
  await page.getByRole('menuitem', { name: 'Kaikki mallit…' }).click();
  const catalog = page.getByRole('dialog', { name: 'Kaikki mallit' });
  await catalog.getByRole('button', { name: new RegExp(`^${name.replace(/\./g, '\\.')}`) }).click();
  await expect(catalog).toHaveCount(0);
};

/** OpenRouter's refusal of a model without a ZDR endpoint, as LiteLLM passes it on. */
const REFUSAL = {
  match: /^Hei Fable/,
  error: { status: 404, message: 'No endpoints found matching your data policy' },
};

const send = async (page: Page, text: string) => {
  await page.getByLabel('Viesti').fill(text);
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
};

/**
 * fake-llm streams a whole turn at once, so a running state is gone before a screenshot.
 * This forwards server frames until the first frame of `type`, then holds the rest until
 * `release()`. It holds once: a later frame of `type` (after the release) must pass, or the
 * rest of the turn would stay held. Call it before the page opens the WebSocket.
 */
const holdAfter = async (page: Page, type: string) => {
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
      if (armed && typeof m === 'string' && JSON.parse(m).type === type) {
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

/** Holds server frames of one `type` while closed (all others pass); `open()` delivers them. */
const gate = async (page: Page, type: string) => {
  let closed = false;
  const held: (string | Buffer)[] = [];
  let deliver: (m: string | Buffer) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    deliver = (m) => ws.send(m);
    server.onMessage((m) => {
      if (closed && typeof m === 'string' && JSON.parse(m).type === type) return void held.push(m);
      ws.send(m);
    });
  });
  return {
    close: () => void (closed = true),
    open: () => {
      closed = false;
      for (const m of held.splice(0)) deliver(m);
    },
  };
};

/** 64x64 solid grey RGB PNG. */
const png = () => {
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
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 128)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array(64).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const LONG = Array.from(
  { length: 80 },
  (_, i) => `Kappale ${i + 1}: tämä on pitkä vastaus, joka virtaa hitaasti näytölle. `,
)
  .join('')
  .slice(0, 4000);

for (const scheme of ['light', 'dark'] as const) {
  for (const vp of sizes) {
    test.describe(`${vp.width} ${scheme}`, () => {
      // The phone is a touch device: no hover, coarse pointer, touch-only states (brief 7.7).
      test.use({
        viewport: vp,
        colorScheme: scheme,
        ...(vp.width === 390 ? { hasTouch: true, isMobile: true } : {}),
      });

      test('login', async ({ app, page }) => {
        await page.goto(app.url);
        await expect(page.getByLabel('Salasana')).toBeVisible();
        await shot(page, 'login', vp.width, scheme);
      });

      test('voice-recording', async ({ app, page }) => {
        await mockMic(page);
        await app.login(page);
        await page.getByRole('button', { name: 'Pidä pohjassa ja puhu' }).hover();
        await page.mouse.down();
        await expect(page.getByRole('status').getByText('Kuuntelee')).toBeVisible();
        await page.waitForTimeout(600);
        await shot(page, 'voice-recording', vp.width, scheme);
        await page.keyboard.press('Escape');
        await page.mouse.up();
      });

      test('artifact-panel', async ({ app, page }) => {
        app.llm.push({ text: HTML_REPLY });
        await app.login(page);
        await sendMessage(page, 'Tee sivu');
        const frame = page.getByRole('complementary', { name: 'Artefaktit' }).locator('iframe');
        await expect(
          frame.contentFrame().getByRole('heading', { name: 'Hei artefakti' }),
        ).toBeVisible();
        await shot(page, 'artifact-panel', vp.width, scheme);
      });

      test('palette', async ({ app, page }) => {
        await app.login(page);
        await page.keyboard.press('ControlOrMeta+k');
        await expect(page.getByPlaceholder('Hae komentoa tai keskustelua')).toBeVisible();
        await shot(page, 'palette', vp.width, scheme);
      });

      test('message-actions', async ({ app, page }) => {
        app.llm.push({ text: 'Tässä vastaus, jonka voi kopioida tai yrittää uudelleen.' });
        await app.login(page);
        await sendMessage(page, 'Kerro jotain');
        const reply = page.locator('.md').last();
        await expect(reply).toHaveText('Tässä vastaus, jonka voi kopioida tai yrittää uudelleen.');
        await reply.hover();
        await expect(page.getByRole('button', { name: 'Yritä uudelleen' })).toBeVisible();
        await shot(page, 'message-actions', vp.width, scheme);
      });

      test('settings-notifications', async ({ app, page }) => {
        await mockPush(page);
        await app.login(page);
        await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
        await openSettings(page, 'Asetukset');
        // Its own state: notifications switched on.
        const push = page.getByLabel('Ilmoita, kun vastaus tai hyväksyntä odottaa');
        await push.click();
        await expect(push).toBeChecked();
        await page
          .getByRole('heading', { name: 'Ilmoitukset' })
          .evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'settings-notifications', vp.width, scheme);
      });

      test('settings-integrations', async ({ app, page }) => {
        // Its own state: Google connected (the connect call answers without a redirect).
        await page.route('**/api/integrations/google/connect', (route) =>
          route.fulfill({ json: { connected: true } }),
        );
        await app.login(page);
        await openSettings(page, 'Asetukset');
        await expect(page.getByText('Ei yhdistetty')).toBeVisible();
        await page.getByRole('button', { name: 'Yhdistä' }).click();
        await expect(page.getByText('Yhdistetty', { exact: true })).toBeVisible();
        // To the top of the dialog body (as far as the content allows).
        await page
          .getByRole('heading', { name: 'Integraatiot' })
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'settings-integrations', vp.width, scheme);
      });

      test('model-menu', async ({ app, page }) => {
        await app.login(page);
        await modelMenu(page);
        await expect(page.getByRole('menuitem', { name: 'Kaikki mallit…' })).toBeVisible();
        await shot(page, 'model-menu', vp.width, scheme);
      });

      test('model-thinking', async ({ app, page }) => {
        await app.login(page);
        await pickModel(page, 'Claude Opus 5.5');
        await modelMenu(page);
        await expect(page.getByRole('menuitemradio', { name: /^Maksimi/ })).toBeVisible();
        await shot(page, 'model-thinking', vp.width, scheme);
      });

      test('model-catalog', async ({ app, page }) => {
        await app.login(page);
        await modelMenu(page);
        await page.getByRole('menuitem', { name: 'Kaikki mallit…' }).click();
        const catalog = page.getByRole('dialog', { name: 'Kaikki mallit' });
        await catalog.getByRole('button', { name: 'Lisää suosikkeihin: Claude Fable 5.1' }).click();
        await expect(catalog.getByRole('heading', { name: 'Suosikit' })).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'model-catalog', vp.width, scheme);
      });

      test('zdr-refusal', async ({ app, page }) => {
        app.llm.push(REFUSAL);
        await app.login(page);
        await pickModel(page, 'Claude Fable 5.1');
        await send(page, 'Hei Fable');
        await expect(
          page.getByRole('alert').filter({ hasText: 'ei ole ZDR-reittiä' }),
        ).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'zdr-refusal', vp.width, scheme);
      });

      test('zdr-open-badge', async ({ app, page }) => {
        app.llm.push(REFUSAL);
        app.llm.push({ match: /^Hei Fable/, text: 'Vastaus ilman ZDR:ää.' });
        await app.login(page);
        await pickModel(page, 'Claude Fable 5.1');
        await send(page, 'Hei Fable');
        await page.getByRole('button', { name: 'Salli ilman ZDR:ää tässä keskustelussa' }).click();
        await expect(page.locator('.md').last()).toHaveText('Vastaus ilman ZDR:ää.');
        await expect(page.getByRole('button', { name: /, Ei ZDR$/ })).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'zdr-open-badge', vp.width, scheme);
      });

      test('empty-chat', async ({ app, page }) => {
        await app.login(page);
        await shot(page, 'empty-chat', vp.width, scheme);
      });

      test('chat', async ({ app, page }) => {
        writeFileSync(join(app.dataDir, 'work/aleksi/note.txt'), 'Muistiinpano.\n');
        app.llm.push({ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] });
        app.llm.push({ text: 'Luin tiedoston.' });
        await app.login(page);
        await page.getByLabel('Viesti').fill('Lue note.txt');
        await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
        await expect(page.locator('.md').last()).toHaveText('Luin tiedoston.');
        await expect(page.getByRole('button', { name: 'Lähetä', exact: true })).toBeVisible();
        // Tool rows start collapsed.
        await expect(page.getByRole('button', { name: /^read/ }).first()).toHaveAttribute(
          'aria-expanded',
          'false',
        );
        await shot(page, 'chat', vp.width, scheme);
        if (vp.width === 1024) return;
        await shot(page, 'tool-collapsed', vp.width, scheme);
        await page.getByRole('button', { name: /^read/ }).first().click();
        await shot(page, 'tool-expanded', vp.width, scheme);
      });

      if (vp.width !== 1024) {
        test.describe('pseudo', () => {
          test.use({ pseudo: 'full' });

          test('vault', async ({ app, page }) => {
            app.llm.push({ text: 'Selvä, Pekka Laaksonen.' });
            await app.login(page);
            await send(page, 'Matti Virtanen ja Liisa Korhonen, hetu 010190-123M');
            await expect(page.locator('.md').last()).toHaveText('Selvä, Matti Virtanen.');
            await openVault(page);
            await expect(page.getByText('Koski')).toBeVisible();
            await expect(page.getByLabel(/^Valitse /).filter({ visible: true })).toHaveCount(3);
            await shot(page, 'vault', vp.width, scheme);
            await page.getByRole('checkbox', { name: 'Valitse Matti Virtanen' }).check();
            await page.getByRole('checkbox', { name: 'Valitse Liisa Korhonen' }).check();
            await expect(page.getByRole('button', { name: 'Yhdistä', exact: true })).toBeVisible();
            await shot(page, 'vault-merge', vp.width, scheme);
          });

          test('skeleton', async ({ app, page }) => {
            // Holds the vault list, so its skeleton shows (after 300 ms of loading).
            const g = await gate(page, 'vault.state');
            g.close();
            await app.login(page);
            await openVault(page);
            await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
            await shot(page, 'skeleton', vp.width, scheme);
            g.open();
          });

          test('confirm-never-detect', async ({ app, page }) => {
            app.llm.push({ text: 'Selvä, Pekka Laaksonen.' });
            await app.login(page);
            await send(page, 'Matti Virtanen ja Liisa Korhonen, hetu 010190-123M');
            await expect(page.locator('.md').last()).toHaveText('Selvä, Matti Virtanen.');
            await openVault(page);
            await page
              .getByRole('button', { name: 'Toiminnot: Matti Virtanen' })
              .filter({ visible: true })
              .click();
            await page.getByRole('menuitem', { name: 'Älä tunnista enää' }).click();
            await expect(page.getByRole('alertdialog')).toBeVisible();
            await shot(page, 'confirm-never-detect', vp.width, scheme);
          });

          test('chat-annotated', async ({ app, page }) => {
            app.llm.push({ text: 'Hei Pekka Laaksonen! Hetu 010190-900B on tallessa.' });
            await app.login(page);
            await send(page, 'Moi, olen Matti Virtanen, hetu 010190-123M');
            await expect(page.locator('.md').last()).toHaveText(
              'Hei Matti Virtanen! Hetu 010190-123M on tallessa.',
            );
            const masked = page.locator('.md span[tabindex="0"]').first();
            if (vp.width === 390) {
              // Touch: a tap opens the hint; there is no hover tooltip.
              await masked.click();
              await expect(
                page.getByRole('dialog').getByText('Malli näki: Pekka Laaksonen'),
              ).toBeVisible();
            } else {
              await masked.focus();
              await expect(page.getByRole('tooltip')).toHaveText('Malli näki: Pekka Laaksonen');
            }
            await shot(page, 'chat-annotated', vp.width, scheme);
            await page.keyboard.press('Escape');
            const menu = page.getByRole('button', { name: 'Valikko' });
            if (await menu.isVisible()) await menu.click();
            await page.getByRole('button', { name: 'Asetukset' }).click();
            await page.getByLabel('Näytä mitä malli näki').check();
            // Settings, then (under 768 px) the drawer; the gear's focus tooltip eats one Escape.
            await expect(async () => {
              await page.keyboard.press('Escape');
              await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 500 });
            }).toPass();
            await expect(page.locator('.md').last()).toHaveText(
              'Hei Pekka Laaksonen! Hetu 010190-900B on tallessa.',
            );
            await expect(page.getByText('Näytetään mitä malli näki')).toBeVisible();
            // Focus returns to the gear and opens its tooltip; it is not part of this screen.
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'chat-annotated-modelsaw', vp.width, scheme);
          });
        });

        test('confirm-delete', async ({ app, page }) => {
          app.llm.push({ text: 'Poistettava vastaus.' });
          await app.login(page);
          await sendMessage(page, 'Verot 2026');
          await expect(page.locator('.md').last()).toHaveText('Poistettava vastaus.');
          await showSidebar(page);
          const row = page.locator('nav li', {
            has: page.getByRole('button', { name: 'Verot 2026', exact: true }),
          });
          await row.hover();
          // The row menu: "Lisää: …" beside the pin above 768 px, "Toiminnot: …" in the drawer.
          await row.getByRole('button', { name: /^(Lisää|Toiminnot): / }).click();
          await page.getByRole('menuitem', { name: 'Poista' }).click();
          await expect(page.getByRole('alertdialog')).toBeVisible();
          await shot(page, 'confirm-delete', vp.width, scheme);
        });

        test('export-dialog', async ({ app, page }) => {
          app.llm.push({ text: 'Tässä yhteenveto veroista.' });
          await app.login(page);
          await sendMessage(page, 'Verot 2026');
          await expect(page.locator('.md').last()).toHaveText('Tässä yhteenveto veroista.');
          await showSidebar(page);
          const row = page.locator('nav li', {
            has: page.getByRole('button', { name: 'Verot 2026', exact: true }),
          });
          await row.hover();
          await row.getByRole('button', { name: /^(Lisää|Toiminnot): / }).click();
          await page.getByRole('menuitem', { name: 'Vie…' }).click();
          const dialog = page.getByRole('dialog', { name: 'Vie keskustelu' });
          // On: the meta line says that the file holds personal data (brief 7.11).
          await dialog.getByRole('switch', { name: 'Näytä oikeat nimet' }).click();
          await expect(dialog.getByText('Tiedostossa on henkilötietoja.')).toBeVisible();
          await shot(page, 'export-dialog', vp.width, scheme);
        });

        test('settings-top', async ({ app, page }) => {
          await app.login(page);
          await openSettings(page, 'Asetukset');
          await expect(page.getByRole('heading', { name: 'Hallinta' })).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'settings-top', vp.width, scheme);
        });

        test('topics-inbox', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await openSettings(page, 'Aiheet');
          await expect(
            page.getByRole('region', { name: 'Ehdotukset' }).getByText('Verot', { exact: true }),
          ).toBeVisible();
          await shot(page, 'topics-inbox', vp.width, scheme);
        });

        test('sidebar-topics', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await openSettings(page, 'Aiheet');
          await acceptProposal(page);
          await showSidebar(page);
          // Left edge: the hover actions cover the right half of a row in the 280 px drawer.
          await page
            .getByRole('button', { name: TAX.title, exact: true })
            .click({ position: { x: 16, y: 16 } });
          await expect(page.getByRole('dialog')).toHaveCount(0);
          await showSidebar(page);
          await expect(page.getByRole('heading', { name: /Verot/ })).toBeVisible();
          await page.mouse.move(vp.width - 8, vp.height / 2);
          await shot(page, 'sidebar-topics', vp.width, scheme);
        });

        test('search-results', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await search(page, 'määräaika');
          await expect(
            page.getByRole('list', { name: 'Haku: määräaika' }).getByRole('button').first(),
          ).toContainText(TAX.title, { timeout: 15_000 });
          // Focus returns to the menu button when the drawer closes; not part of this screen.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-results', vp.width, scheme);
        });

        test('related-chats', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await page.getByRole('button', { name: 'Uusi keskustelu' }).first().click();
          // Same summary, so the two summaries' embeddings are neighbours.
          app.llm.push({ text: 'Eräpäivä näkyy OmaVerossa.' });
          app.llm.push(titleTurn('Veron eräpäivä', TAX.summary));
          await sendMessage(page, 'Milloin veron eräpäivä on?');
          await expect(page.getByText('Veron eräpäivä', { exact: true }).first()).toBeVisible({
            timeout: 15_000,
          });
          await showSidebar(page);
          // Left edge: the hover actions cover the right half of a row in the 280 px drawer.
          await page
            .getByRole('button', { name: TAX.title, exact: true })
            .click({ position: { x: 16, y: 16 } });
          const row = page.getByRole('navigation', { name: 'Liittyvät keskustelut' });
          await expect(row.getByRole('button', { name: 'Veron eräpäivä' })).toBeVisible();
          await page.mouse.move(vp.width - 8, vp.height / 2);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'related-chats', vp.width, scheme);
        });

        test('topics-list', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await openSettings(page, 'Aiheet');
          await acceptProposal(page);
          await expect(
            page.getByRole('region', { name: 'Omat aiheet' }).getByText('Verot', { exact: true }),
          ).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'topics-list', vp.width, scheme);
        });

        test('sidebar-topics-collapsed', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await openSettings(page, 'Aiheet');
          await acceptProposal(page);
          await showSidebar(page);
          const group = page.getByRole('button', { name: /^Verot/ });
          await group.click();
          await expect(group).toHaveAttribute('aria-expanded', 'false');
          await page.mouse.move(vp.width - 8, vp.height / 2);
          await shot(page, 'sidebar-topics-collapsed', vp.width, scheme);
        });

        test('sidebar-pinned', async ({ app, page }) => {
          await app.login(page);
          await taxChat(app, page);
          await showSidebar(page);
          const row = page.locator('nav li', {
            has: page.getByRole('button', { name: TAX.title, exact: true }),
          });
          await row.hover();
          // Under 768 px the row actions are a menu.
          const menu = row.getByRole('button', { name: /^Toiminnot/ });
          if (await menu.isVisible()) {
            await menu.click();
            await page.getByRole('menuitem', { name: 'Kiinnitä' }).click();
          } else await row.getByRole('button', { name: 'Kiinnitä' }).click();
          await expect(page.getByRole('heading', { name: 'Kiinnitetyt' })).toBeVisible();
          await page.mouse.move(vp.width - 8, vp.height / 2);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'sidebar-pinned', vp.width, scheme);
        });

        test('search-empty', async ({ app, page }) => {
          await app.login(page);
          await search(page, 'hammaslääkäri');
          await expect(page.getByText('Ei tuloksia haulle')).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-empty', vp.width, scheme);
        });

        test('approval-card', async ({ app, page }) => {
          // Long enough to pass the 6-line clamp at every width.
          const content = `Hei,\n\n${'tämä on pitkä kirje, jonka avustaja haluaa kirjoittaa tiedostoon. '.repeat(8)}`;
          app.llm.push({ toolCalls: [{ name: 'write', args: { path: 'kirje.txt', content } }] });
          app.llm.push({ text: 'Selvä, en kirjoittanut.' });
          await app.login(page);
          await sendMessage(page, 'Kirjoita kirje');
          // Inline, not a modal (brief 7.5): a labelled region.
          const card = page.getByRole('region', { name: /write/ });
          await expect(card.getByRole('button', { name: 'Näytä lisää' })).toBeVisible();
          await shot(page, 'approval-card', vp.width, scheme);
          await card.getByRole('button', { name: 'Hylkää' }).click();
          await expect(page.locator('.md').last()).toHaveText('Selvä, en kirjoittanut.');
        });

        test.describe('short approval timeout', () => {
          test.use({ approvalTimeoutMs: 1500 });

          test('approval-expired', async ({ app, page }) => {
            app.llm.push({
              toolCalls: [{ name: 'write', args: { path: 'kirje.txt', content: 'Hei' } }],
            });
            app.llm.push({ text: 'Hyväksyntä vanheni, en kirjoittanut tiedostoa.' });
            await app.login(page);
            await sendMessage(page, 'Kirjoita kirje');
            await expect(page.getByRole('region', { name: /write/ })).toBeVisible();
            // The card goes; its tool row carries the outcome (brief 7.5).
            await expect(page.getByRole('button', { name: /^write vanhentunut/ })).toBeVisible({
              timeout: 10_000,
            });
            await expect(page.locator('.md').last()).toHaveText(
              'Hyväksyntä vanheni, en kirjoittanut tiedostoa.',
            );
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'approval-expired', vp.width, scheme);
          });
        });

        test('agent-picker', async ({ app, page }) => {
          await app.login(page);
          await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
          await expect(page.getByRole('menuitemradio', { name: 'Tutkija' })).toBeVisible();
          await shot(page, 'agent-picker', vp.width, scheme);
        });

        test('subagents-row', async ({ app, page }) => {
          const tasks = ['Verot', 'Asuminen', 'Liikenne'].map((label) => ({
            label,
            task: `Tiivistä aihe ${label}`,
          }));
          // Every turn is reserved for its caller (`match`): children run in parallel with each
          // other and with the title job, so a FIFO queue could hand a turn to the wrong call.
          const parent = /^Tiivistä kolme aihetta/;
          app.llm.push({
            match: parent,
            toolCalls: [{ name: 'subagent', args: { mode: 'parallel', tasks } }],
          });
          for (const t of tasks)
            app.llm.push({ match: new RegExp(`${t.task}$`), text: 'Tiivistelmä.' });
          app.llm.push({ match: parent, text: 'Valmis.' });
          const hold = await holdAfter(page, 'subagent.state');
          await app.login(page);
          await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
          await page.getByRole('menuitemradio', { name: 'Tutkija' }).click();
          await sendMessage(page, 'Tiivistä kolme aihetta');
          await hold.reached;
          const row = page.getByRole('button', { name: '3 aliagenttia jonossa' });
          await row.click();
          await expect(page.getByText('Asuminen')).toBeVisible();
          await shot(page, 'subagents-row', vp.width, scheme);
          hold.release();
          await expect(page.locator('.md').last()).toHaveText('Valmis.', { timeout: 30_000 });
        });

        test.describe('automation', () => {
          test.use({ automation: true });

          test('settings-automations', async ({ app, page }) => {
            await app.login(page);
            await openSettings(page, 'Automaatiot');
            await expect(page.getByText('1.1. klo 3.00').filter({ visible: true })).toBeVisible();
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'settings-automations', vp.width, scheme);
          });
        });

        test('settings-agents', async ({ app, page }) => {
          await app.login(page);
          await openSettings(page, 'Agentit');
          await expect(page.getByText('Tutkija')).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'settings-agents', vp.width, scheme);
        });

        test.describe('memory', () => {
          test.use({ pseudo: 'full', memoryUser: USER_MD });
          const blur = (page: import('@playwright/test').Page) =>
            page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

          test('memory', async ({ app, page }) => {
            await app.login(page);
            await openSettings(page, 'Muisti');
            await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(USER_MD);
            await blur(page);
            await shot(page, 'memory', vp.width, scheme);
          });

          test('memory-pending', async ({ app, page }) => {
            memoryTurns(app, 'Lempiväri on vihreä.', true);
            await app.login(page);
            await sendMessage(page, 'Muista lempivärini');
            await expect(page.getByText('Muistikirjoitus odottaa hyväksyntää')).toBeVisible();
            await page.getByRole('button', { name: 'Avaa muisti' }).click();
            await expect(
              page.getByRole('region', { name: 'Odottavat kirjoitukset' }),
            ).toContainText('Lempiväri on vihreä.');
            await blur(page);
            await shot(page, 'memory-pending', vp.width, scheme);
          });

          test('memory-chip', async ({ app, page }) => {
            memoryTurns(app, 'Lempiväri on sininen.');
            await app.login(page);
            await sendMessage(page, 'Lempivärini on sininen');
            await expect(page.locator('.md').last()).toHaveText('Selvä, muistan.');
            await expect(page.getByText('Muisti päivitetty')).toBeVisible();
            await expect(page.getByText('Lempiväri on sininen.')).toBeVisible();
            await blur(page);
            await shot(page, 'memory-chip', vp.width, scheme);
          });

          test('toast', async ({ app, page }) => {
            await app.login(page);
            await openSettings(page, 'Muisti');
            const user = page.getByLabel('Käyttäjä (USER.md)');
            await expect(user).toHaveValue(USER_MD);
            await user.fill(`${USER_MD}\nAamuisin juon kahvia.`);
            await page.getByRole('button', { name: 'Tallenna' }).first().click();
            await expect(page.getByText('Tallennettu')).toBeVisible();
            await blur(page);
            await shot(page, 'toast', vp.width, scheme);
          });

          test('memory-overcap', async ({ app, page }) => {
            await app.login(page);
            await openSettings(page, 'Muisti');
            const user = page.getByLabel('Käyttäjä (USER.md)');
            await user.fill(`${USER_MD}\n${'Pitkä lisärivi muistiin. '.repeat(64)}`);
            await expect(user).toHaveAttribute('aria-invalid', 'true');
            await expect(page.getByText(/· liian pitkä/)).toBeVisible();
            await blur(page);
            await shot(page, 'memory-overcap', vp.width, scheme);
          });

          test('memory-consolidating', async ({ app, page }) => {
            app.llm.push({
              text: JSON.stringify({ user: 'Asun Tampereella.\nVastaa lyhyesti.', memory: '' }),
            });
            const g = await gate(page, 'memory.state');
            await app.login(page);
            await openSettings(page, 'Muisti');
            await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(USER_MD);
            g.close();
            await page.getByRole('button', { name: 'Tiivistä nyt' }).click();
            await expect(page.getByRole('button', { name: 'Tiivistetään…' })).toBeDisabled();
            await blur(page);
            await shot(page, 'memory-consolidating', vp.width, scheme);
            g.open();
            await expect(page.getByRole('region', { name: 'Tiivistysehdotus' })).toBeVisible();
          });

          test('memory-consolidation-edit', async ({ app, page }) => {
            app.llm.push({
              text: JSON.stringify({ user: 'Asun Tampereella.\nVastaa lyhyesti.', memory: '' }),
            });
            await app.login(page);
            await openSettings(page, 'Muisti');
            await page.getByRole('button', { name: 'Tiivistä nyt' }).click();
            await page.getByRole('button', { name: 'Muokkaa' }).click();
            await expect(page.getByLabel('Käyttäjä (USER.md)')).toHaveValue(
              'Asun Tampereella.\nVastaa lyhyesti.',
            );
            await blur(page);
            await shot(page, 'memory-consolidation-edit', vp.width, scheme);
          });

          test('memory-consolidation', async ({ app, page }) => {
            app.llm.push({
              text: JSON.stringify({
                user: 'Asun Tampereella.\nVastaa lyhyesti ja suomeksi.',
                memory: '',
              }),
            });
            await app.login(page);
            await openSettings(page, 'Muisti');
            await page.getByRole('button', { name: 'Tiivistä nyt' }).click();
            const section = page.getByRole('region', { name: 'Tiivistysehdotus' });
            await expect(section).toContainText('Vastaa lyhyesti ja suomeksi.');
            await blur(page);
            await shot(page, 'memory-consolidation', vp.width, scheme);
          });
        });

        test.describe('pseudo empty', () => {
          test.use({ pseudo: 'empty' });

          test('vault-empty', async ({ app, page }) => {
            await app.login(page);
            await openVault(page);
            await expect(
              page.getByText('Ei vielä tunnistettuja nimiä tai tunnuksia'),
            ).toBeVisible();
            await shot(page, 'vault-empty', vp.width, scheme);
          });
        });

        test('login-error', async ({ app, page }) => {
          await page.goto(app.url);
          await page.getByLabel('Salasana').fill('väärin');
          await page.getByRole('button', { name: 'Kirjaudu', exact: true }).click();
          await expect(page.getByRole('alert')).toHaveText('Väärä salasana.');
          await shot(page, 'login-error', vp.width, scheme);
        });

        test('streaming', async ({ app, page }) => {
          app.llm.push({ text: LONG });
          const hold = await holdAfter(page, 'message.delta');
          await app.login(page);
          await send(page, 'Kirjoita pitkä vastaus');
          await hold.reached;
          await expect(page.getByRole('button', { name: 'Pysäytä' })).toBeVisible();
          await expect(page.locator('.md').last()).not.toBeEmpty();
          await shot(page, 'streaming', vp.width, scheme);
          hold.release();
          await expect(page.getByRole('button', { name: 'Lähetä', exact: true })).toBeVisible();
        });

        test('tool-running', async ({ app, page }) => {
          writeFileSync(join(app.dataDir, 'work/aleksi/note.txt'), 'Muistiinpano.\n');
          app.llm.push({ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] });
          app.llm.push({ text: 'Luin tiedoston.' });
          const hold = await holdAfter(page, 'tool.start');
          await app.login(page);
          await send(page, 'Lue note.txt');
          await hold.reached;
          await expect(page.getByRole('button', { name: /^read käynnissä/ })).toBeVisible();
          await shot(page, 'tool-running', vp.width, scheme);
          hold.release();
          await expect(page.locator('.md').last()).toHaveText('Luin tiedoston.');
        });

        test('error-toast', async ({ app, page }) => {
          // No scripted turn: fake-llm answers 500 and the server sends `llm_failed`.
          await app.login(page);
          await send(page, 'Hei');
          // A failed reply is an inline alert in the thread, not a toast (brief 7.5).
          await expect(page.getByRole('alert').getByText('Mallin kutsu epäonnistui.')).toBeVisible({
            timeout: 30_000,
          });
          await shot(page, 'error-toast', vp.width, scheme);
        });

        test('composer-attachments', async ({ app, page }) => {
          const dir = mkdtempSync(join(tmpdir(), 'pa-e2e-att-'));
          writeFileSync(join(dir, 'kuva.png'), png());
          writeFileSync(join(dir, 'muistio.txt'), 'Muistiinpano.\n');
          await app.login(page);
          await page
            .locator('input[type=file]')
            .setInputFiles([join(dir, 'kuva.png'), join(dir, 'muistio.txt')]);
          const chips = page.getByLabel('Liitteet');
          await expect(chips.getByText('kuva.png')).toBeVisible();
          await expect(chips.getByText('muistio.txt')).toBeVisible();
          await expect(page.getByLabel('Lähetetään')).toHaveCount(0);
          await page.getByLabel('Viesti').fill('Katso nämä');
          await shot(page, 'composer-attachments', vp.width, scheme);
        });
      }

      if (vp.width === 390) {
        test('sidebar-open', async ({ app, page }) => {
          await app.login(page);
          await page.getByRole('button', { name: 'Valikko' }).click();
          await expect(page.getByRole('dialog')).toBeVisible();
          await shot(page, 'sidebar-open', vp.width, scheme);
        });
      }
    });
  }
}
