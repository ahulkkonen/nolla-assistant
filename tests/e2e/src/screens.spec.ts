import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  type App,
  acceptProposal,
  CHART_REPLY,
  COLLIDING,
  CONFIDENCE_PLAIN,
  CONFIDENCE_REPLY,
  deviceRows,
  editAgent,
  expect,
  flip,
  flipMode,
  HTML_REPLY,
  holdAt,
  KIT_REPLY,
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
  SERIES_REPLY,
  search,
  searchTurns,
  secondDevice,
  seedClaims,
  sendMessage,
  showSidebar,
  TAX,
  THINKING_TURN,
  taxChat,
  test,
  titleTurn,
  USER_MD,
} from './fixtures.ts';

/** Shots of the `webkit` project go to their own folder, so the two baselines never mix. */
const shotDir = () => {
  const dir = join(
    import.meta.dirname,
    test.info().project.name === 'webkit' ? '../screenshots-webkit' : '../screenshots',
  );
  mkdirSync(dir, { recursive: true });
  return dir;
};

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
              // The tooltip's visually hidden copy (`#radix-…`, role tooltip) is portalled there too.
              (n) =>
                !n.target.join(' ').includes('data-radix-popper-content-wrapper') &&
                !/^#radix-/.test(n.target.join(' ')),
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
  // The streaming caret stays on: its blink must not decide whether a shot shows it.
  await page.addStyleTag({ content: '.md .caret { animation: none !important; }' });
  // Let transitions settle.
  await page.waitForTimeout(400);
  const noScroll = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(noScroll, `${screen} scrolls horizontally`).toBe(true);
  const path = join(shotDir(), `${screen}-${w}-${scheme}.png`);
  await page.screenshot({ path, fullPage: false });
  expect(existsSync(path)).toBe(true);
  await axe(page, `${screen}-${w}-${scheme}`);
};

/** Opens the composer's model menu (phase-10): a dropdown at ≥ 768, a bottom sheet on phones. */
const modelMenu = (page: Page) => page.getByRole('button', { name: /^Malli: / }).click();

/** A control of the model menu: a menu item, or a sheet's button or radio on phones. */
const menuControl = (page: Page, w: number, kind: 'item' | 'radio', name: string | RegExp) =>
  page.getByRole(
    w < 768
      ? kind === 'item'
        ? 'button'
        : 'radio'
      : kind === 'item'
        ? 'menuitem'
        : 'menuitemradio',
    { name },
  );

/** Picks a model for the chat from "Kaikki mallit". */
const pickModel = async (page: Page, w: number, name: string) => {
  await modelMenu(page);
  await menuControl(page, w, 'item', 'Kaikki mallit…').click();
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

      test('chat-header', async ({ app, page }) => {
        test.skip(vp.width === 390, 'Phones keep the cost in the chat menu.');
        // A long title beside the cost, with the artifact panel open (thread area 528 at 1024).
        app.llm.push(THINKING_TURN);
        app.llm.push(
          titleTurn(
            'Kasvimaan aloitus keväällä ja syksyllä: maan muokkaus, kylvöt ja kastelu',
            'Käyttäjä kysyi kasvimaasta.',
          ),
        );
        app.llm.push({ text: HTML_REPLY });
        await app.login(page);
        await sendMessage(page, 'Milloin kasvimaa kannattaa aloittaa?');
        await expect(page.locator('.md').last()).toHaveText(THINKING_TURN.text, {
          timeout: 15_000,
        });
        const header = page.locator('main header');
        await expect(header.getByRole('heading', { name: /^Kasvimaan aloitus/ })).toBeVisible();
        await sendMessage(page, 'Tee sivu');
        await expect(
          page
            .getByRole('complementary', { name: 'Artefaktit' })
            .locator('iframe')
            .contentFrame()
            .getByRole('heading', { name: 'Hei artefakti' }),
        ).toBeVisible();
        const cost = header.getByText(/tokenia/);
        await expect(cost).toBeVisible();
        await cost.hover();
        await expect(page.getByRole('tooltip')).toContainText('Välimuisti');
        await shot(page, 'chat-header', vp.width, scheme);
      });

      // Phase 19: a chart, a diagram and a kit page.
      for (const [screen, text, ready] of [
        ['chart-artifact', CHART_REPLY, '#vis svg .mark-rect'],
        ['mermaid-artifact', MERMAID_REPLY, '.diagram svg'],
        ['kit-artifact', KIT_REPLY, 'figure svg'],
      ] as const)
        test(screen, async ({ app, page }) => {
          app.llm.push({ text });
          await app.login(page);
          await sendMessage(page, 'Piirrä');
          // Phase 20: a chart or a diagram shows inline and opens in the panel on request.
          if (screen !== 'kit-artifact')
            await page.getByRole('figure').getByRole('button', { name: 'Avaa paneelissa' }).click();
          const frame = page.getByRole('complementary', { name: 'Artefaktit' }).locator('iframe');
          await expect(frame.contentFrame().locator(ready).first()).toBeVisible({
            timeout: 15_000,
          });
          await shot(page, screen, vp.width, scheme);
        });

      // Phase 20: figures in the thread, the writing card and the queue.
      for (const [screen, text, ready] of [
        ['chart-inline', SERIES_REPLY, '#vis svg .mark-line path'],
        ['mermaid-inline', NWP_REPLY, '.diagram svg'],
      ] as const)
        test(screen, async ({ app, page }) => {
          app.llm.push({ text });
          await app.login(page);
          await sendMessage(page, 'Piirrä');
          await expect(
            page.getByRole('figure').locator('iframe').contentFrame().locator(ready).first(),
          ).toBeVisible({ timeout: 15_000 });
          await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
          // The whole figure in the shot: the viewport grows by what the thread scrolls.
          const extra = await page
            .getByRole('region', { name: 'Keskustelu' })
            .evaluate((el) => el.scrollHeight - el.clientHeight);
          if (extra > 0) await page.setViewportSize({ width: vp.width, height: vp.height + extra });
          await shot(page, screen, vp.width, scheme);
        });

      test('artifact-streaming', async ({ app, page }) => {
        app.llm.push({ text: PAGE_REPLY });
        const hold = await holdAt(page, '<h1>Raportti');
        await app.login(page);
        await sendMessage(page, 'Tee raportti');
        await hold.reached;
        await expect(page.locator('[aria-busy="true"]')).toContainText('kirjoittaa…');
        await shot(page, 'artifact-streaming', vp.width, scheme);
        hold.release();
      });

      test('composer-queue', async ({ app, page }) => {
        app.llm.push({ text: LONG });
        const hold = await holdAt(page, 'Kappale 6');
        await app.login(page);
        await sendMessage(page, 'Kirjoita pitkä vastaus');
        await hold.reached;
        await page.getByLabel('Viesti').fill('Tee lopuksi lyhyt yhteenveto listana.');
        await page.getByRole('button', { name: 'Lisää jonoon' }).click();
        await expect(page.getByText('Jonossa', { exact: true })).toBeVisible();
        // Text again: the two run buttons, Pysäytä and Lisää jonoon.
        await page.getByLabel('Viesti').fill('Lisää myös lähteet.');
        await expect(page.getByRole('button', { name: 'Lisää jonoon' })).toBeVisible();
        // The model chip keeps its whole name next to the two run buttons.
        const name = page.getByRole('button', { name: /^Malli: / }).locator('span.truncate');
        expect(
          await name.evaluate((el) => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await shot(page, 'composer-queue', vp.width, scheme);
        hold.release();
      });

      // Phase-21 decision 4 and phase-23 decision 9: three confidence levels with Luottamus on,
      // the legend, and the second sentence's N (hover on a desktop, a tap on the phone).
      test('chat-confidence', async ({ app, page }) => {
        app.llm.push({ text: CONFIDENCE_REPLY });
        await app.login(page);
        await sendMessage(page, 'Kerro Tampereesta');
        const reply = page.locator('.md').last();
        await expect(reply).toHaveText(CONFIDENCE_PLAIN, { useInnerText: true });
        await expect(page.locator('.md span.conf')).toHaveCount(3);
        await flipMode(page, 'Luottamus', true);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const box = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().toJSON());
        // P1: the legend row is 16 px (44 on phones for its button), 4 px between 12 × 8 swatches.
        const legend = page.getByRole('button', { name: 'Näytä luvut' }).locator('..');
        expect((await box(legend)).height).toBe(vp.width < 768 ? 44 : 16);
        const swatches = legend.locator('.conf-swatch');
        await expect(swatches).toHaveCount(9);
        const [a, b] = [await box(swatches.nth(0)), await box(swatches.nth(1))];
        expect([a.width, a.height, b.x - a.right]).toEqual([12, 8, 4]);
        const target = await box(page.getByRole('button', { name: 'Näytä luvut' }));
        expect(target.height).toBe(16);
        const sentence = reply.locator('span.conf').nth(1);
        if (vp.width < 768) await sentence.tap();
        else await sentence.hover();
        await expect(sentence.locator('sup.conf-n')).toBeVisible();
        await shot(page, 'chat-confidence', vp.width, scheme);
      });

      // Phase-23 decision 9: "Näytä luvut" on puts every N in the text (axe reads them).
      test('chat-confidence-numbers', async ({ app, page }) => {
        app.llm.push({ text: CONFIDENCE_REPLY });
        await app.login(page);
        await sendMessage(page, 'Kerro Tampereesta');
        await expect(page.locator('.md span.conf')).toHaveCount(3);
        await page.getByRole('button', { name: 'Näytä luvut' }).click();
        await expect(page.locator('.md sup.conf-n').last()).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.mouse.move(vp.width - 8, 8);
        await shot(page, 'chat-confidence-numbers', vp.width, scheme);
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
        await expect(menuControl(page, vp.width, 'item', 'Kaikki mallit…')).toBeVisible();
        await shot(page, 'model-menu', vp.width, scheme);
      });

      // Phase-23 decision 8: the Tila chip's menu (≥ 768), the model sheet's Tila rows on phones.
      test('mode-menu', async ({ app, page }) => {
        app.llm.push({ text: 'Hei.' });
        await app.login(page);
        await sendMessage(page, 'Moi');
        await expect(page.locator('.md').last()).toHaveText('Hei.');
        const box = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().toJSON());
        if (vp.width < 768) {
          await modelMenu(page);
          const row = page.getByRole('switch', { name: 'Luottamus', exact: true });
          await row.click();
          await expect(row).toBeChecked();
          await row.scrollIntoViewIfNeeded();
          // P1: the 44 px SwitchRow.
          for (const r of await page.getByRole('group', { name: 'Tila' }).locator('label').all())
            expect((await box(r)).height).toBeGreaterThanOrEqual(44);
        } else {
          const chip = page.getByRole('button', { name: /^Tila/ });
          const model = page.getByRole('button', { name: /^Malli: / });
          // P1: 32 px high, 12 px side padding, the model chip's type.
          expect((await box(chip)).height).toBe(32);
          const css = (l: Locator) =>
            l.evaluate((el) => {
              const s = getComputedStyle(el);
              return [s.paddingLeft, s.fontSize, s.lineHeight, s.fontWeight, s.color].join(' ');
            });
          expect(await css(chip)).toBe(await css(model));
          expect(await chip.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('12px');
          await chip.click();
          await page.getByRole('menuitemcheckbox', { name: /^Luottamus/ }).click();
          await expect(chip).toHaveAccessibleName('Tila: Luottamus, Perusteellinen, Suora');
          for (const r of await page.getByRole('menuitemcheckbox').all()) {
            expect((await box(r)).height).toBeGreaterThanOrEqual(40);
            expect(await r.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('8px');
          }
          await page.mouse.move(vp.width - 8, 8);
        }
        await shot(page, 'mode-menu', vp.width, scheme);
      });

      test('model-thinking', async ({ app, page }) => {
        await app.login(page);
        await pickModel(page, vp.width, 'Claude Opus 5.5');
        await modelMenu(page);
        // ≥ 768 the levels are a submenu; on phones the sheet lists them under "Ajattelu".
        if (vp.width >= 768) await page.getByRole('menuitem', { name: /^Ajattelu/ }).click();
        await expect(menuControl(page, vp.width, 'radio', /^Maksimi/)).toBeVisible();
        await expect(menuControl(page, vp.width, 'radio', /^Matala/)).toBeInViewport();
        await shot(page, 'model-thinking', vp.width, scheme);
      });

      test('model-catalog', async ({ app, page }) => {
        await app.login(page);
        await modelMenu(page);
        await menuControl(page, vp.width, 'item', 'Kaikki mallit…').click();
        const catalog = page.getByRole('dialog', { name: 'Kaikki mallit' });
        await catalog.getByRole('button', { name: 'Lisää suosikkeihin: Claude Fable 5.1' }).click();
        await expect(catalog.getByRole('heading', { name: 'Suosikit' })).toBeVisible();
        await expect(catalog.getByRole('heading', { name: 'Uusimmat' })).toBeVisible();
        await page.mouse.move(vp.width - 8, vp.height - 8);
        // The first row holds the roving tab stop: it reads as the row Enter picks.
        await catalog.locator('[data-cell]').first().focus();
        await shot(page, 'model-catalog', vp.width, scheme);
      });

      test('model-menu-chat', async ({ app, page }) => {
        // Phones only: a started chat has no agent chip, so the model sheet names the agent.
        if (vp.width >= 768) return;
        app.llm.push({ text: 'Hei.' });
        await app.login(page);
        await page.getByLabel('Viesti').fill('Hei');
        await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
        await expect(page.locator('.md').last()).toHaveText('Hei.');
        await expect(page.getByRole('button', { name: 'Lähetä', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Agentti: / })).toHaveCount(0);
        await modelMenu(page);
        await expect(
          page.getByRole('dialog', { name: 'Mallin valinta' }),
        ).toHaveAccessibleDescription('Agentti: Avustaja');
        await shot(page, 'model-menu-chat', vp.width, scheme);
      });

      test('zdr-refusal', async ({ app, page }) => {
        app.llm.push(REFUSAL);
        await app.login(page);
        await pickModel(page, vp.width, 'Claude Fable 5.1');
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
        await pickModel(page, vp.width, 'Claude Fable 5.1');
        await send(page, 'Hei Fable');
        await page.getByRole('button', { name: 'Salli ilman ZDR:ää tässä keskustelussa' }).click();
        await expect(page.locator('.md').last()).toHaveText('Vastaus ilman ZDR:ää.');
        await expect(page.getByRole('button', { name: /, Ei ZDR$/ })).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'zdr-open-badge', vp.width, scheme);
      });

      test.describe('thread depth', () => {
        const phone = vp.width < 768;
        const thread = (page: Page) => page.getByRole('region', { name: 'Keskustelu' });
        const blur = (page: Page) =>
          page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        /** One reply of the thinking turn, with its cost (and the title job). */
        const thinkingChat = async (app: App, page: Page) => {
          app.llm.push(THINKING_TURN);
          app.llm.push(titleTurn('Kasvimaa', 'Käyttäjä kysyi kasvimaasta.'));
          await app.login(page);
          await sendMessage(page, 'Milloin kasvimaa kannattaa aloittaa?');
          // The thinking takes 1,5 s; the full parallel run is slower than one test.
          await expect(page.locator('.md').last()).toHaveText(THINKING_TURN.text, {
            timeout: 15_000,
          });
          await expect(page.getByText('Kasvimaa', { exact: true }).first()).toBeVisible({
            timeout: 15_000,
          });
        };

        test('thinking-live', async ({ app, page }) => {
          app.llm.push({ ...THINKING_TURN, thinkMs: 20_000 });
          const hold = await holdAfter(page, 'message.thinking');
          await app.login(page);
          await sendMessage(page, 'Milloin kasvimaa kannattaa aloittaa?');
          await hold.reached;
          await expect(thread(page).getByText(/^Ajattelee… \d+ s$/)).toBeVisible();
          await page.waitForTimeout(1200);
          await shot(page, 'thinking-live', vp.width, scheme);
          hold.release();
        });

        test('thinking-closed', async ({ app, page }) => {
          await thinkingChat(app, page);
          await expect(
            thread(page).getByRole('button', { name: /^Ajatteli \d+ s$/ }),
          ).toBeVisible();
          await blur(page);
          await shot(page, 'thinking-closed', vp.width, scheme);
        });

        test('thinking-open', async ({ app, page }) => {
          await thinkingChat(app, page);
          await thread(page)
            .getByRole('button', { name: /^Ajatteli \d+ s$/ })
            .click();
          await expect(thread(page).getByRole('region', { name: 'Mallin ajattelu' })).toBeVisible();
          await blur(page);
          await shot(page, 'thinking-open', vp.width, scheme);
        });

        test('message-meta', async ({ app, page }) => {
          await thinkingChat(app, page);
          const reply = thread(page).locator('[data-message-id]').last();
          await expect(reply.getByText('0,012 €')).toBeVisible();
          // Desktop: the cost's tooltip with the model and the token parts.
          if (vp.width === 1440) {
            await reply.getByText('0,012 €').hover();
            await expect(page.getByRole('tooltip')).toContainText('Malli: Gemini 4 Argon');
          } else await blur(page);
          await shot(page, 'message-meta', vp.width, scheme);
        });

        test('fork-link', async ({ app, page }) => {
          app.llm.push({ text: 'Kevät on hyvä aika.' });
          app.llm.push(titleTurn('Kasvimaa', 'Käyttäjä kysyi kasvimaasta.'));
          app.llm.push({ text: 'Syksyllä maa kannattaa kääntää.' });
          app.llm.push({ text: 'Syksy sopii myös, jos maa on kuohkea.' });
          await app.login(page);
          await sendMessage(page, 'Milloin kasvimaa kannattaa aloittaa?');
          await expect(page.locator('.md').last()).toHaveText('Kevät on hyvä aika.');
          await expect(page.getByText('Kasvimaa', { exact: true }).first()).toBeVisible({
            timeout: 15_000,
          });
          await sendMessage(page, 'Entä syksyllä?');
          await expect(page.locator('.md').last()).toHaveText('Syksyllä maa kannattaa kääntää.');
          const second = thread(page).locator('[data-message-id]').nth(2);
          if (phone) await page.getByLabel('Viesti').press('ArrowUp');
          else {
            await second.hover();
            await second.getByRole('button', { name: 'Muokkaa' }).click();
          }
          await page.getByLabel('Muokattava viesti').fill('Entä jos aloitan syksyllä?');
          await page.getByRole('button', { name: 'Haarauta' }).click();
          await expect(
            page.getByRole('button', { name: 'Haarautettu keskustelusta ”Kasvimaa”' }),
          ).toBeVisible();
          await expect(page.locator('.md').last()).toHaveText(
            'Syksy sopii myös, jos maa on kuohkea.',
          );
          if (!phone) await page.mouse.move(vp.width / 2, vp.height / 2);
          await blur(page);
          await shot(page, 'fork-link', vp.width, scheme);
        });

        if (vp.width !== 1024)
          test('message-edit-fork', async ({ app, page }) => {
            app.llm.push({ text: 'Kevät on hyvä aika.' });
            await app.login(page);
            await sendMessage(page, 'Milloin kasvimaa kannattaa aloittaa?');
            await expect(page.locator('.md').last()).toHaveText('Kevät on hyvä aika.');
            if (phone) await page.getByLabel('Viesti').press('ArrowUp');
            else {
              const first = thread(page).locator('[data-message-id]').first();
              await first.hover();
              await first.getByRole('button', { name: 'Muokkaa' }).click();
            }
            await page
              .getByLabel('Muokattava viesti')
              .fill('Milloin kasvimaa kannattaa aloittaa syksyllä?');
            await expect(
              page.getByText(
                'Muokattu viesti aloittaa uuden keskustelun. Tämä keskustelu ei muutu.',
              ),
            ).toBeVisible();
            if (!phone) await page.mouse.move(vp.width / 2, vp.height - 200);
            await shot(page, 'message-edit-fork', vp.width, scheme);
          });

        test('find-bar', async ({ app, page }) => {
          app.llm.push({ text: 'Omena on hedelmä, ja omenapuu kukkii keväällä.' });
          await app.login(page);
          await sendMessage(page, 'Kerro omenasta');
          await expect(page.locator('.md').last()).toContainText('omenapuu');
          await page.keyboard.press('ControlOrMeta+f');
          await page.getByLabel('Etsi keskustelusta').fill('omena');
          await expect(page.getByText('1/3', { exact: true })).toBeVisible();
          await page.getByLabel('Etsi keskustelusta').press('Enter');
          await expect(page.getByText('2/3', { exact: true })).toBeVisible();
          await shot(page, 'find-bar', vp.width, scheme);
        });

        test('chat-menu-usage', async ({ app, page }) => {
          await thinkingChat(app, page);
          await showSidebar(page);
          const row = page.locator('nav li', { hasText: 'Kasvimaa' });
          if (!phone) await row.hover();
          await row
            .getByRole('button', { name: phone ? 'Toiminnot: Kasvimaa' : 'Lisää: Kasvimaa' })
            .click();
          await expect(page.getByRole('menu').getByText('0,012 € · 3,4 k tokenia')).toBeVisible();
          await shot(page, 'chat-menu-usage', vp.width, scheme);
        });

        test('usage-month', async ({ app, page }) => {
          await thinkingChat(app, page);
          await openSettings(page, 'Käyttö');
          await expect(page.getByText('3,4 k tokenia · 1 kutsu')).toBeVisible();
          if (!phone) await page.mouse.move(vp.width / 2, vp.height - 40);
          await blur(page);
          await shot(page, 'usage-month', vp.width, scheme);
        });

        test('usage-agents', async ({ app, page }) => {
          await thinkingChat(app, page);
          await openSettings(page, 'Käyttö');
          const agents = page.getByRole('heading', { name: 'Agenteittain' });
          await expect(page.getByText('Verkkohaut: 0')).toBeVisible();
          await agents.scrollIntoViewIfNeeded();
          if (!phone) await page.mouse.move(vp.width / 2, vp.height - 40);
          await blur(page);
          await shot(page, 'usage-agents', vp.width, scheme);
        });

        test('usage-empty', async ({ app, page }) => {
          await app.login(page);
          await openSettings(page, 'Käyttö');
          await expect(page.getByText('Ei käyttöä tässä kuussa')).toBeVisible();
          await blur(page);
          await shot(page, 'usage-empty', vp.width, scheme);
        });
      });

      test.describe('web search', () => {
        test.use({ pseudo: 'full' });
        const thread = (page: Page) => page.getByRole('region', { name: 'Keskustelu' });

        test('search-row-collapsed', async ({ app, page }) => {
          searchTurns(app, 'Helsingin sää', 'Pilvistä, 7 astetta (yle.fi/saa).');
          await app.login(page);
          await sendMessage(page, 'Millainen sää on Helsingissä?');
          await expect(page.locator('.md').last()).toContainText('Pilvistä');
          await expect(
            thread(page).getByRole('button', { name: /^web_search 2 tulosta/ }),
          ).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-row-collapsed', vp.width, scheme);
        });

        test('search-row-expanded', async ({ app, page }) => {
          searchTurns(app, 'Helsingin sää', 'Pilvistä, 7 astetta (yle.fi/saa).');
          await app.login(page);
          await sendMessage(page, 'Millainen sää on Helsingissä?');
          await expect(page.locator('.md').last()).toContainText('Pilvistä');
          await thread(page)
            .getByRole('button', { name: /^web_search 2 tulosta/ })
            .click();
          await expect(thread(page).getByRole('list', { name: 'Hakutulokset' })).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-row-expanded', vp.width, scheme);
        });

        test('search-approval-card', async ({ app, page }) => {
          app.llm.push({
            toolCalls: [{ name: 'web_search', args: { query: 'Pekka Laaksonen hallitus' } }],
          });
          await app.login(page);
          await sendMessage(page, 'Hae Matti Virtanen');
          await expect(
            page.getByRole('region', { name: 'Haku sisältää henkilötiedon' }),
          ).toContainText('Matti Virtanen hallitus');
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-approval-card', vp.width, scheme);
        });
      });

      test.describe('files', () => {
        test.use({ workFiles: true });
        const phone = vp.width < 768;
        const blur = (page: Page) =>
          page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        /** A row action: an icon button on hover at ≥ 768 px, the card's ⋯ menu on phones. */
        const rowAction = async (page: Page, menu: string, action: string) => {
          if (phone) {
            await page.getByRole('button', { name: menu }).click();
            await page.getByRole('menuitem', { name: action }).click();
          } else await page.getByRole('button', { name: action }).click();
        };
        const preview = async (page: Page, name: string) => {
          await openFiles(page);
          await rowAction(page, `Tiedoston toiminnot: ${name}`, `Esikatsele: ${name}`);
          await expect(page.getByRole('complementary', { name: 'Esikatselu' })).toBeVisible();
        };

        test('files-tree', async ({ app, page }) => {
          // A saved artifact gives one row a "Lähde" link.
          app.llm.push({ text: HTML_REPLY });
          app.llm.push(titleTurn('Esittelysivu', 'Käyttäjä pyysi sivun.'));
          await app.login(page);
          await sendMessage(page, 'Tee sivu');
          await page.getByRole('button', { name: 'Lataa', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Tallenna työkansioon' }).click();
          const toast = page.getByText('Tallennettu Työkansioon');
          await expect(toast).toBeVisible();
          await expect(page.getByText('Esittelysivu').first()).toBeVisible({ timeout: 15_000 });
          await page.getByRole('button', { name: 'Sulje artefaktit' }).click();
          await openFiles(page);
          // Phones: no "Lähde" column; the card's ⋯ menu opens the chat.
          await expect(
            phone
              ? page.getByRole('button', { name: 'Tiedoston toiminnot: Hei artefakti.html' })
              : page.getByRole('link', { name: 'Esittelysivu' }),
          ).toBeVisible();
          await expect(toast).toBeHidden({ timeout: 10_000 });
          await blur(page);
          await shot(page, 'files-tree', vp.width, scheme);
        });

        test('files-folder', async ({ app, page }) => {
          await app.login(page);
          await openFiles(page);
          await page.getByRole('button', { name: 'Raportit', exact: true }).click();
          await expect(
            page.getByRole('navigation', { name: 'Kansiopolku' }).getByText('Raportit'),
          ).toHaveAttribute('aria-current', 'page');
          await blur(page);
          await shot(page, 'files-folder', vp.width, scheme);
        });

        test('files-preview-text', async ({ app, page }) => {
          await app.login(page);
          await preview(page, 'tulokset.csv');
          await expect(page.getByRole('region', { name: 'tulokset.csv: sisältö' })).toContainText(
            'helmikuu,135,82',
          );
          await blur(page);
          await shot(page, 'files-preview-text', vp.width, scheme);
        });

        test('files-preview-image', async ({ app, page }) => {
          await app.login(page);
          await preview(page, 'kansikuva.png');
          const img = page.getByRole('img', { name: 'kansikuva.png' });
          await expect(img).toBeVisible();
          await expect
            .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
          await blur(page);
          await shot(page, 'files-preview-image', vp.width, scheme);
        });

        test('files-preview-html', async ({ app, page }) => {
          await app.login(page);
          await preview(page, 'esittely.html');
          const frame = page.getByRole('complementary', { name: 'Esikatselu' }).locator('iframe');
          await expect(
            frame.contentFrame().getByRole('heading', { name: 'Esittely' }),
          ).toBeVisible();
          await blur(page);
          await shot(page, 'files-preview-html', vp.width, scheme);
        });

        test('files-trash', async ({ app, page }) => {
          await app.login(page);
          await openFiles(page);
          for (const name of ['laskuri.py', 'arkisto.zip']) {
            await page.getByRole('button', { name: `Tiedoston toiminnot: ${name}` }).click();
            await page.getByRole('menuitem', { name: 'Poista' }).click();
            await expect(page.getByText(name, { exact: true })).toHaveCount(0);
          }
          await page.getByRole('button', { name: 'Kansion toiminnot: Kuvat' }).click();
          await page.getByRole('menuitem', { name: 'Poista' }).click();
          await page.getByRole('button', { name: 'Roskakori', exact: true }).click();
          await expect(
            page.getByRole('button', {
              name: phone ? 'Roskakorin toiminnot: Kuvat' : 'Palauta: Kuvat',
            }),
          ).toBeVisible();
          await expect(page.getByText('Siirretty roskakoriin').first()).toBeHidden({
            timeout: 10_000,
          });
          await blur(page);
          await shot(page, 'files-trash', vp.width, scheme);
        });

        test('files-upload', async ({ app, page }) => {
          await app.login(page);
          await openFiles(page);
          // A slow uplink (64 kB/s): the rows stay long enough to show their bars part way.
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: 64 * 1024,
          });
          const dir = mkdtempSync(join(tmpdir(), 'pa-e2e-up-'));
          writeFileSync(join(dir, 'kokouspöytäkirja.txt'), 'Pöytäkirja.\n'.repeat(60_000));
          writeFileSync(join(dir, 'mittaukset.csv'), 'aika,arvo\n'.repeat(60_000));
          await page
            .locator('#files-upload')
            .setInputFiles([join(dir, 'kokouspöytäkirja.txt'), join(dir, 'mittaukset.csv')]);
          const bar = page.getByRole('progressbar', { name: 'Lataus: kokouspöytäkirja.txt' });
          await expect
            .poll(async () => Number(await bar.getAttribute('aria-valuenow')))
            .toBeGreaterThan(5);
          await blur(page);
          await shot(page, 'files-upload', vp.width, scheme);
        });

        test('files-quota', async ({ app, page }) => {
          const quota = 10 * 1024 ** 3;
          await page.route('**/api/files/tree/usage', (route) =>
            route.fulfill({
              json: {
                used: quota,
                quota,
                work: quota - 2 * 1024 ** 3,
                trash: 1024 ** 3,
                files: 1024 ** 3,
                maxFileSize: 200 * 1024 ** 2,
                maxAttachSize: 25 * 1024 ** 2,
              },
            }),
          );
          await page.route('**/api/files/tree/upload**', (route) =>
            route.fulfill({ status: 413, json: { error: 'quota' } }),
          );
          await app.login(page);
          await openFiles(page);
          const dir = mkdtempSync(join(tmpdir(), 'pa-e2e-quota-'));
          writeFileSync(join(dir, 'video.mp4'), Buffer.alloc(2048));
          await page.locator('#files-upload').setInputFiles(join(dir, 'video.mp4'));
          // The row says it; no toast on top.
          await expect(
            page.getByText('Tallennustila on täynnä. Tyhjennä roskakori tai poista'),
          ).toBeVisible();
          await blur(page);
          await shot(page, 'files-quota', vp.width, scheme);
        });

        test('files-picker', async ({ app, page }) => {
          await app.login(page);
          await page.getByRole('button', { name: 'Liitä tiedosto' }).click();
          await page.getByRole('menuitem', { name: 'Valitse työkansiosta' }).click();
          const dialog = page.getByRole('dialog', { name: 'Valitse työkansiosta' });
          // A row in view, after the open animation: a click during it makes Playwright scroll
          // the list to retry the hit test (the app itself opens at the top).
          await expect(dialog.getByRole('button', { name: /^esittely\.html/ })).toBeVisible();
          await page.waitForTimeout(400);
          await dialog.getByRole('button', { name: /^esittely\.html/ }).click();
          await expect(dialog.getByRole('button', { name: /^esittely\.html/ })).toHaveAttribute(
            'aria-pressed',
            'true',
          );
          await shot(page, 'files-picker', vp.width, scheme);
        });

        test('files-deep-path', async ({ app, page }) => {
          await app.login(page);
          await openFiles(page);
          for (const name of ['Projektit', '2026', 'Syksy', 'Lokakuu', 'Viikko 43'])
            await page.getByRole('button', { name, exact: true }).click();
          const crumbs = page.getByRole('navigation', { name: 'Kansiopolku' });
          await expect(crumbs.getByText('Viikko 43')).toHaveAttribute('aria-current', 'page');
          await expect(crumbs.getByText('…')).toBeVisible();
          await blur(page);
          await shot(page, 'files-deep-path', vp.width, scheme);
        });

        if (vp.width !== 1024)
          test('toast-error', async ({ app, page }) => {
            // A zip cannot be attached (415): an error toast with its close button.
            await app.login(page);
            await openFiles(page);
            await page.getByRole('button', { name: 'Tiedoston toiminnot: arkisto.zip' }).click();
            await page.getByRole('menuitem', { name: 'Liitä keskusteluun' }).click();
            await expect(page.getByText('Tätä tiedostotyyppiä ei voi liittää.')).toBeVisible();
            await expect(page.getByRole('button', { name: 'Sulje' }).last()).toBeVisible();
            // Focus went back to ⋯ and its tooltip shows: a click on empty canvas clears both.
            if (!phone) await page.mouse.click(vp.width / 2, vp.height - 60);
            await expect(page.getByRole('tooltip')).toHaveCount(0);
            await shot(page, 'toast-error', vp.width, scheme);
          });

        test('files-attach-menu', async ({ app, page }) => {
          await app.login(page);
          await page.getByRole('button', { name: 'Liitä tiedosto' }).click();
          await expect(page.getByRole('menuitem', { name: 'Valitse työkansiosta' })).toBeVisible();
          await shot(page, 'files-attach-menu', vp.width, scheme);
        });

        test('files-move', async ({ app, page }) => {
          await app.login(page);
          await openFiles(page);
          await page.getByRole('button', { name: 'Tiedoston toiminnot: muistiinpanot.md' }).click();
          await page.getByRole('menuitem', { name: 'Siirrä' }).click();
          const dialog = page.getByRole('dialog', { name: 'Siirrä kohteeseen' });
          await expect(dialog.getByRole('button', { name: 'Raportit' })).toBeVisible();
          await shot(page, 'files-move', vp.width, scheme);
        });
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

      // Phase-21 decision 7: the chip on, in the warning colour; on phones the model sheet's row.
      test('auto-approve-on', async ({ app, page }) => {
        app.llm.push({ text: 'Hei.' });
        await app.login(page);
        await sendMessage(page, 'Moi');
        await expect(page.locator('.md').last()).toHaveText('Hei.');
        await flip(page, 'Hyväksy automaattisesti', true);
        if (vp.width < 768) await modelMenu(page);
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'auto-approve-on', vp.width, scheme);
      });

      if (vp.width !== 1024) {
        test.describe('collision', () => {
          test.use({ pseudo: 'collision' });

          test('chat-held', async ({ app, page }) => {
            await app.login(page);
            await sendMessage(page, `Soita ${COLLIDING} huomenna`);
            await expect(
              page.getByRole('button', { name: 'Avaa Nimisuoja', exact: true }),
            ).toBeVisible();
            await expect(page.getByLabel('Viesti')).toHaveAttribute(
              'placeholder',
              'Odottaa Nimisuojaa',
            );
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'chat-held', vp.width, scheme);
          });

          test('vault-collision', async ({ app, page }) => {
            // Matti Virtanen first: the card then names whose surrogate the typed name is.
            app.llm.push({ text: 'Selvä.' });
            await app.login(page);
            await sendMessage(page, 'Matti Virtanen soitti eilen');
            await expect(page.locator('.md').last()).toHaveText('Selvä.');
            await sendMessage(page, `Soita ${COLLIDING} huomenna`);
            await page.getByRole('button', { name: 'Avaa Nimisuoja', exact: true }).click();
            await expect(page.getByText(`Onko ${COLLIDING} uusi henkilö?`)).toBeVisible();
            await expect(
              page.getByText('Nimi on jo henkilön Matti Virtanen pseudonyymi.'),
            ).toBeVisible();
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'vault-collision', vp.width, scheme);
          });
        });

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
          await expect(page.getByRole('menuitemradio', { name: 'Kirjoittaja' })).toBeVisible();
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
            await expect(
              page.getByText('1.1. klo 3.00', { exact: true }).filter({ visible: true }),
            ).toBeVisible();
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await shot(page, 'settings-automations', vp.width, scheme);
          });
        });

        test('settings-agents', async ({ app, page }) => {
          await app.login(page);
          await openSettings(page, 'Agentit');
          await expect(page.getByText('Kirjoittaja', { exact: true })).toBeVisible();
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

      test.describe('memory claims', () => {
        test.use({ pseudo: 'full', memoryUser: USER_MD });
        // Phase 17 W1: the Havainnot tab with seeded claims (proposals, a supersede, stale).
        test('memory-claims', async ({ app, page }) => {
          app.llm.push({ text: 'Hei.' });
          await app.login(page);
          await sendMessage(page, 'Moi');
          await expect(page.locator('.md').last()).toHaveText('Hei.');
          const db = new DatabaseSync(join(app.dataDir, 'app.db'));
          const chat = db.prepare('SELECT id FROM chats LIMIT 1').get() as { id: string };
          db.close();
          seedClaims(app, chat.id);
          await openSettings(page, 'Muisti');
          await page.getByRole('tab', { name: 'Havainnot' }).click();
          await expect(page.getByText('Korvaa', { exact: true })).toBeVisible();
          await page.getByRole('button', { name: /^Korvatut/ }).click();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          // The whole tab: the page scrolls inside the app shell, so the viewport grows to fit.
          const tall = await page.getByRole('tabpanel').evaluate((el) => {
            let box = el.parentElement;
            while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement;
            if (box) box.scrollTop = 0;
            return el.getBoundingClientRect().bottom + 48;
          });
          await page.setViewportSize({ width: vp.width, height: Math.ceil(tall) });
          await shot(page, 'memory-claims', vp.width, scheme);
        });
      });

      test('jump-pill', async ({ app, page }) => {
        test.skip(vp.width === 1440, 'The pill is shot at 390 and 1024.');
        writeFileSync(join(app.dataDir, 'work/aleksi/note.txt'), 'Muistiinpano.\n');
        app.llm.push({ text: LONG });
        // Matched turns: the title job cannot take them.
        const match = 'Lue note.txt';
        app.llm.push({ match, toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] });
        app.llm.push({ match, text: LONG });
        const hold = await holdAfter(page, 'tool.start');
        await app.login(page);
        await send(page, 'Kirjoita pitkä vastaus');
        await expect(page.locator('.md').last()).toContainText('Kappale 61');
        await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
        await send(page, 'Lue note.txt ja jatka');
        await hold.reached;
        // Scrolled up while the turn runs: its tool round and its reply arrive as 2 new messages.
        // Scrolled up while the turn is held, in two steps like a reader.
        const region = page.getByRole('region', { name: 'Keskustelu' });
        await region.evaluate((el) => el.scrollTo({ top: 10 }));
        await page.waitForTimeout(100);
        await region.evaluate((el) => el.scrollTo({ top: 0 }));
        hold.release();
        await expect(page.getByRole('button', { name: 'Uusimpaan · 2 uutta' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Pysäytä' })).toHaveCount(0);
        if (vp.width !== 390) await page.mouse.move(8, 8);
        await shot(page, 'jump-pill', vp.width, scheme);
      });

      test.describe('admin', () => {
        // Phase 15: the editors, devices and the full export; run times in Helsinki time.
        test.use({ timezoneId: 'Europe/Helsinki' });
        const blur = (page: Page) =>
          page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const openExport = async (page: Page) => {
          await openSettings(page, 'Asetukset');
          await page.getByRole('button', { name: 'Vie kaikki', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Vie kaikki tiedot' });
          await dialog.getByLabel('Salasana', { exact: true }).fill('pitkä salasana 1');
          await dialog.getByLabel('Salasana uudelleen').fill('pitkä salasana 1');
          return dialog;
        };

        test('agents-editor', async ({ app, page }) => {
          await app.login(page);
          await editAgent(page, 'Kirjoittaja');
          await blur(page);
          await shot(page, 'agents-editor', vp.width, scheme);
        });

        test('agents-editor-yaml', async ({ app, page }) => {
          await app.login(page);
          await editAgent(page, 'Kirjoittaja');
          await page.getByRole('tab', { name: 'YAML' }).click();
          await expect(page.getByLabel('Tiedosto', { exact: true })).toHaveValue(
            /^id: kirjoittaja$/m,
          );
          await blur(page);
          await shot(page, 'agents-editor-yaml', vp.width, scheme);
        });

        test('agents-editor-error', async ({ app, page }) => {
          await app.login(page);
          await editAgent(page, 'Kirjoittaja');
          await page.getByLabel('Nimi', { exact: true }).fill('');
          await page.getByRole('button', { name: 'Tallenna' }).click();
          await expect(page.getByText('Tarkista kenttä.')).toBeVisible();
          await expect(page.getByLabel('Nimi', { exact: true })).toBeFocused();
          await shot(page, 'agents-editor-error', vp.width, scheme);
        });

        test('automation-editor', async ({ app, page }) => {
          await app.login(page);
          const runs = await newAutomation(page);
          await expect(runs.first()).toHaveText(/klo 7\.30$/);
          await page.getByRole('group', { name: 'Aikataulu' }).scrollIntoViewIfNeeded();
          // The time input keeps focus through blur(); a click on the title moves it away.
          await page.getByRole('heading', { name: 'Uusi automaatio' }).click();
          await shot(page, 'automation-editor', vp.width, scheme);
        });

        test('devices', async ({ app, page, browser }) => {
          const { context: other } = await secondDevice(app, browser);
          await app.login(page);
          await deviceRows(page);
          await blur(page);
          await shot(page, 'devices', vp.width, scheme);
          await other.close();
        });

        test('export-all-dialog', async ({ app, page }) => {
          await app.login(page);
          const dialog = await openExport(page);
          await expect(dialog.getByRole('button', { name: 'Aloita' })).toBeEnabled();
          await blur(page);
          await shot(page, 'export-all-dialog', vp.width, scheme);
        });

        test('export-all-ready', async ({ app, page }) => {
          await app.login(page);
          const dialog = await openExport(page);
          await dialog.getByRole('button', { name: 'Aloita' }).click();
          await expect(dialog.getByRole('link', { name: 'Lataa' })).toBeVisible();
          await blur(page);
          await shot(page, 'export-all-ready', vp.width, scheme);
        });
      });

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
