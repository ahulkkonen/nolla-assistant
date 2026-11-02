import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationRuns, chats, topics } from '@nolla/db';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import { UNATTENDED_REASON } from './approval.ts';
import { start } from './main.ts';
import { boot, cleanups, connect, runCleanups } from './test-utils.ts';

afterEach(runCleanups);

const file = (cron: string, id: string) =>
  `id: ${id}\ncron: '${cron}'\ntimezone: Europe/Helsinki\nprompt: Moikka\ndeliver: push\n`;

// The same reply serves the session turn and the title job (JSON text).
const turn = {
  text: JSON.stringify({ title: 'x', topics: [], proposed_topic: null, summary: 'Yhteenveto' }),
};

test('automations run as chats under Automaatiot', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-auto-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'tick.yaml'), file('* * * * * *', 'tick'));
  writeFileSync(join(dir, 'later.yaml'), file('0 0 1 1 *', 'later'));
  writeFileSync(join(dir, 'bad.yaml'), file('not a cron', 'bad'));
  writeFileSync(join(dir, 'other.yaml'), file('* * * * *', 'mismatch'));
  writeFileSync(join(dir, 'off.yaml.disabled'), file('* * * * *', 'off'));
  writeFileSync(join(dir, 'broken.yaml'), 'prompt: Synteettinen Henkilö soita\n  bad: [\n');
  const b = await boot(
    Array.from({ length: 40 }, () => turn),
    { AUTOMATIONS_DIR: dir },
  );
  const logs: string[] = [];
  const srv = await start(b.config, { write: (l) => logs.push(l) });
  cleanups.push(srv.close);

  const inTopic = (title: string) =>
    srv.db
      .select({ chat: chats, topicName: topics.name })
      .from(chats)
      .innerJoin(topics, eq(chats.topicId, topics.id))
      .where(eq(chats.title, title))
      .all();
  await vi.waitFor(
    () =>
      expect(
        srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'tick')).get(),
      ).toMatchObject({ lastStatus: 'ok' }),
    { timeout: 5000, interval: 100 },
  );
  const run = srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'tick')).get();
  const row = srv.db
    .select()
    .from(chats)
    .where(eq(chats.id, run?.lastChatId ?? ''))
    .get();
  expect(row).toMatchObject({ titleLocked: true, agentId: 'assistant' });
  expect(row?.title).toMatch(/^tick \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(srv.db.select().from(topics).where(eq(topics.name, 'Automaatiot')).all()).toHaveLength(1);
  expect(
    readdirSync(join(b.config.dataDir, 'sessions', 'aleksi')).some((f) =>
      f.includes(row?.id ?? '?'),
    ),
  ).toBe(true);
  expect(existsSync(join(b.config.dataDir, 'sessions'))).toBe(true);
  // Title job: locked title stays, summary is written.
  await vi.waitFor(
    () =>
      expect(
        srv.db
          .select()
          .from(chats)
          .where(eq(chats.id, row?.id ?? ''))
          .get(),
      ).toMatchObject({ title: row?.title, summary: 'Yhteenveto' }),
    { timeout: 8000, interval: 200 },
  );

  const c = await connect(b.config.port);
  c.send({ type: 'automations.list' });
  const { automations } = await c.next('automations.state');
  expect(automations.map((a) => a.id)).toEqual(['later', 'tick']);
  expect(automations.find((a) => a.id === 'tick')).toMatchObject({
    lastStatus: 'ok',
    enabled: true,
  });

  expect(logs.filter((l) => l.includes('bad automation')).length).toBeGreaterThan(0);
  // A YAML error logs its name and line, never the source line it quotes.
  const broken = logs.map((l) => JSON.parse(l)).find((l) => l.file === 'broken.yaml');
  expect(broken).toMatchObject({ error: 'YAMLParseError', line: expect.any(Number) });
  expect(logs.join('')).not.toContain('Synteettinen');
  c.send({ type: 'automations.run', id: 'later' });
  expect(
    (await c.next('automations.state')).automations.find((x) => x.id === 'later'),
  ).toMatchObject({
    lastStatus: 'running',
  });
  const status = () =>
    srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'later')).get()?.lastStatus;
  await vi.waitFor(() => expect(status()).toBe('ok'), { timeout: 5000, interval: 100 });
  expect(
    inTopic(
      `later ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Helsinki' }).slice(0, 16)}`,
    ).length,
  ).toBeGreaterThan(0);
  c.send({ type: 'automations.run', id: 'nope' });
  await expect(c.next('automations.state')).rejects.toThrow('not_found');
});

test.each([
  ['', false],
  ['autoApprove: [write]\n', true],
])('unattended approval (%j)', { timeout: 30_000 }, async (extra, written) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-auto-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'wr.yaml'), `${file('0 0 1 1 *', 'wr')}${extra}`);
  const b = await boot(
    [
      { toolCalls: [{ name: 'write', args: { path: 'auto.txt', content: 'x' } }] },
      { text: 'Valmis.' },
    ],
    { AUTOMATIONS_DIR: dir },
  );
  const srv = await start(b.config);
  cleanups.push(srv.close);
  const c = await connect(b.config.port);
  c.send({ type: 'automations.run', id: 'wr' });
  await c.next('automations.state');
  await vi.waitFor(
    () =>
      expect(
        srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'wr')).get(),
      ).toMatchObject({
        lastStatus: 'ok',
      }),
    { timeout: 5000, interval: 100 },
  );
  expect(existsSync(join(srv.registry.cwd, 'auto.txt'))).toBe(written);
  expect(JSON.stringify(b.llm.requests[1]?.body).includes(UNATTENDED_REASON)).toBe(!written);
});
