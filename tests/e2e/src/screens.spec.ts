import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
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
};

const send = async (page: Page, text: string) => {
  await page.getByLabel('Viesti').fill(text);
  await page.getByLabel('Viesti').press('ControlOrMeta+Enter');
};

/**
 * fake-llm streams a whole turn at once, so a running state is gone before a screenshot.
 * This forwards server frames until the first frame of `type`, then holds the rest until
 * `release()`. Call it before the page opens the WebSocket.
 */
const holdAfter = async (page: Page, type: string) => {
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
      if (typeof m === 'string' && JSON.parse(m).type === type) {
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
      test.use({ viewport: vp, colorScheme: scheme });

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
        await openSettings(page, 'Asetukset');
        await page.getByRole('heading', { name: 'Ilmoitukset' }).scrollIntoViewIfNeeded();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'settings-notifications', vp.width, scheme);
      });

      test('settings-integrations', async ({ app, page }) => {
        await app.login(page);
        await openSettings(page, 'Asetukset');
        await expect(page.getByText('Ei yhdistetty')).toBeVisible();
        await page.getByRole('heading', { name: 'Integraatiot' }).scrollIntoViewIfNeeded();
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await shot(page, 'settings-integrations', vp.width, scheme);
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

          test('chat-annotated', async ({ app, page }) => {
            app.llm.push({ text: 'Hei Pekka Laaksonen! Hetu 010190-900B on tallessa.' });
            await app.login(page);
            await send(page, 'Moi, olen Matti Virtanen, hetu 010190-123M');
            await expect(page.locator('.md').last()).toHaveText(
              'Hei Matti Virtanen! Hetu 010190-123M on tallessa.',
            );
            await page.locator('.md span[tabindex="0"]').first().focus();
            await expect(page.getByRole('tooltip')).toHaveText('Malli näki: Pekka Laaksonen');
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
          await expect(page.getByText('Ei osumia.')).toBeVisible();
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await shot(page, 'search-empty', vp.width, scheme);
        });

        test('approval-card', async ({ app, page }) => {
          const content = `Hei,\n\n${'tämä on pitkä kirje, jonka avustaja haluaa kirjoittaa tiedostoon. '.repeat(4)}`;
          app.llm.push({ toolCalls: [{ name: 'write', args: { path: 'kirje.txt', content } }] });
          app.llm.push({ text: 'Selvä, en kirjoittanut.' });
          await app.login(page);
          await sendMessage(page, 'Kirjoita kirje');
          const card = page.getByRole('alertdialog', { name: /write/ });
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
            await expect(page.getByRole('alertdialog')).toBeVisible();
            await expect(page.getByText('Hyväksyntä vanheni: write')).toBeVisible({
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
          app.llm.push({ toolCalls: [{ name: 'subagent', args: { mode: 'parallel', tasks } }] });
          for (const _ of tasks) app.llm.push({ text: 'Tiivistelmä.' });
          app.llm.push({ text: 'Valmis.' });
          const hold = await holdAfter(page, 'subagent.state');
          await app.login(page);
          await page.getByRole('button', { name: 'Agentti: Avustaja' }).click();
          await page.getByRole('menuitemradio', { name: 'Tutkija' }).click();
          await sendMessage(page, 'Tiivistä kolme aihetta');
          await hold.reached;
          const row = page.getByRole('button', { name: '3 jonossa' });
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
            await page.getByRole('button', { name: 'Muisti', exact: true }).click();
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
              page.getByText('Ei vielä tunnistettuja nimiä tai tunnuksia.'),
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
          await expect(page.getByRole('status').getByText('Mallin kutsu epäonnistui.')).toBeVisible(
            {
              timeout: 30_000,
            },
          );
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
