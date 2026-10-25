import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Page } from '@playwright/test';
import { expect, openVault, test } from './fixtures.ts';

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
        await expect(page.getByRole('button', { name: 'Lähetä' })).toBeVisible();
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
          test.use({ pseudo: true });

          test('vault', async ({ app, page }) => {
            app.llm.push({ text: 'Selvä, Pekka Laaksonen.' });
            await app.login(page);
            await send(page, 'Matti Virtanen ja Liisa Korhonen, hetu 010190-123M');
            await expect(page.locator('.md').last()).toHaveText('Selvä, Matti Virtanen.');
            await openVault(page);
            await expect(page.getByText('Koski')).toBeVisible();
            await expect(page.getByLabel(/^Valitse /).filter({ visible: true })).toHaveCount(3);
            await shot(page, 'vault', vp.width, scheme);
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
          await expect(page.getByRole('button', { name: 'Lähetä' })).toBeVisible();
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
