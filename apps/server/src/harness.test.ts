import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chats, openDb, users } from '@nolla/db';
import { PseudoClient, PseudoDownError } from '@nolla/pi-ext-pseudo';
import { startFakeSidecar } from '@nolla/pi-ext-pseudo/fake-sidecar';
import { HARNESS_TOOLS } from '@nolla/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { adminWriters } from './admin.ts';
import { loadAgents } from './agents.ts';
import { callKey, type View } from './approval.ts';
import {
  AGENT_FIXED,
  CHAT_MAX,
  harness,
  NO_PII,
  NOT_FOUND,
  PSEUDO_DOWN,
  SAVED,
  STALE,
} from './harness.ts';
import { loadModes, modesDir } from './modes.ts';
import { runCleanups, seedAgents, tempDir } from './test-utils.ts';

afterEach(runCleanups);

const REAL = 'Matti Virtanen';
const MASKED = 'Pekka Laaksonen';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';

type Tool = { execute: (id: string, p: object) => Promise<{ content: { text: string }[] }> };

function setup(o: { pseudo?: unknown; allow?: string[]; reader?: () => never } = {}) {
  const data = tempDir('pa-harness-');
  const agentsDir = join(data, 'agents');
  const automationsDir = join(data, 'automations');
  seedAgents(agentsDir);
  mkdirSync(automationsDir);
  const { db, sqlite } = openDb(join(data, 'app.db'));
  const now = '2026-10-01T10:00:00.000Z';
  db.insert(users).values({ id: 'u1', createdAt: now }).run();
  let agents = loadAgents(agentsDir);
  let modes = loadModes(modesDir(agentsDir));
  const writers = adminWriters({
    db,
    dataDir: data,
    agentsDir,
    automationsDir,
    skillsDir: join(data, 'skills'),
    mcpNames: ['workspace'],
    catalog: { get: () => undefined },
    registry: { running: () => false },
    agents: () => agents,
    modes: () => modes,
    reloadAgents: () => {
      agents = loadAgents(agentsDir, () => {}, agents);
      modes = loadModes(modesDir(agentsDir), () => {}, modes);
    },
    automations: () => undefined,
    sendAll: () => {},
    warn: () => {},
  });
  const branches = new Map<string, { role: string; text: string }[]>();
  const addChat = (
    id: string,
    title: string,
    createdAt: string,
    msgs = 2,
    texts = Array.from({ length: msgs }, (_, i) => `viesti ${i} ${MASKED}`),
  ) => {
    db.insert(chats)
      .values({
        id,
        userId: 'u1',
        title,
        titleMasked: title,
        sessionPath: 'sessions/u1/',
        createdAt,
        updatedAt: createdAt,
      })
      .run();
    branches.set(
      id,
      texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text })),
    );
  };
  addChat(CHAT, 'Tämä keskustelu', now);
  const masked = new Map<string, unknown>();
  const log = vi.fn();
  const h = harness({
    writers,
    db,
    userId: 'u1',
    reader: (id) =>
      o.reader?.() ??
      ({
        sessionManager: {
          getBranch: () =>
            (branches.get(id) ?? []).map((m, i) => ({
              type: 'message',
              id: `${id}-${i}`,
              message: { role: m.role, content: m.text },
            })),
        },
      } as never),
    pseudo: (o.pseudo ?? {
      mask: async (_: string, t: string) => ({ masked: t, spans: [] }),
      unmask: async (t: string) => ({ restored: t.replaceAll(MASKED, REAL), spans: [], hold: 0 }),
    }) as never,
    agentsDir,
    automationsDir,
    chatId: CHAT,
    agentId: 'assistant',
    masked,
    allow: o.allow ?? [...HARNESS_TOOLS],
    log,
  });
  const tools = new Map<string, Tool>();
  const ends: ((e: { toolName: string; toolCallId: string }) => void)[] = [];
  h.tools({
    on: (_: string, f: (typeof ends)[number]) => ends.push(f),
    registerTool: (t: Tool & { name: string }) => tools.set(t.name, t),
  } as never);
  const end = (toolName: string, toolCallId: string) => {
    for (const f of ends) f({ toolName, toolCallId });
  };
  const view = (tool: string, input: object, id = 't1') =>
    (h.views[tool] as View)(input as never, id);
  const exec = async (tool: string, input: object, id = 't1') =>
    (await (tools.get(tool) as Tool).execute(id, input)).content[0]?.text ?? '';
  const gitLog = () =>
    spawnSync('git', ['log', '--format=%s'], { cwd: agentsDir, encoding: 'utf8' }).stdout;
  cleanups(() => sqlite.close());
  return {
    agentsDir,
    automationsDir,
    view,
    exec,
    masked,
    log,
    addChat,
    gitLog,
    writers,
    tools,
    end,
  };
}
const closers: (() => void)[] = [];
const cleanups = (f: () => void) => closers.push(f);
afterEach(() => {
  for (const f of closers.splice(0)) f();
});

test('profile_edit: diff view, write, commit note; the YAML stays byte-equal', async () => {
  const s = setup();
  const yaml = readFileSync(join(s.agentsDir, 'assistant.yaml'), 'utf8');
  const prompt = join(s.agentsDir, 'prompts', 'assistant.md');
  const content = `${readFileSync(prompt, 'utf8')}Vastaa lyhyesti.\n`;
  const v = await s.view('profile_edit', { file: 'prompt', content });
  expect(v).toMatchObject({ view: { kind: 'diff', file: 'prompts/assistant.md', created: false } });
  const diff = 'view' in v && v.view.kind === 'diff' ? v.view.diff : '';
  expect(diff.startsWith('@@')).toBe(true);
  expect(diff).toContain('+Vastaa lyhyesti.');
  expect(await s.exec('profile_edit', { file: 'prompt', content })).toBe(SAVED);
  expect(readFileSync(prompt, 'utf8')).toBe(content);
  expect(readFileSync(join(s.agentsDir, 'assistant.yaml'), 'utf8')).toBe(yaml);
  expect(s.gitLog()).toContain('profile_edit prompts/assistant.md (chat aaaaaaaa)');
  expect(s.log).toHaveBeenCalledWith('harness write', {
    chatId: CHAT,
    tool: 'profile_edit',
    file: 'prompts/assistant.md',
  });
  // A new mode: its id from the name.
  const raw = '---\nname: Runo\n---\n\nVastaa runona.\n';
  expect(
    await s.view('profile_edit', { file: 'mode', id: 'runo', content: raw }, 't2'),
  ).toMatchObject({ view: { file: 'modes/runo.md', created: true } });
  expect(await s.exec('profile_edit', { file: 'mode', id: 'runo', content: raw }, 't2')).toBe(
    SAVED,
  );
  expect(readFileSync(join(s.agentsDir, 'modes', 'runo.md'), 'utf8')).toBe(raw);
});

test('profile_edit: stale refusal; a vault name blocks with the fixed reason', async () => {
  const s = setup();
  const prompt = join(s.agentsDir, 'prompts', 'assistant.md');
  const content = 'Uusi ohje.';
  await s.view('profile_edit', { file: 'prompt', content });
  writeFileSync(prompt, 'Joku muutti tämän.\n');
  expect(await s.exec('profile_edit', { file: 'prompt', content })).toBe(STALE);
  expect(readFileSync(prompt, 'utf8')).toBe('Joku muutti tämän.\n');
  // No card shown for this call id: refused too.
  expect(await s.exec('profile_edit', { file: 'prompt', content }, 'x')).toBe(STALE);
  s.masked.set(callKey('profile_edit', 't3'), `Olet ${MASKED}n avustaja.`);
  expect(
    await s.view('profile_edit', { file: 'prompt', content: `Olet ${REAL}n avustaja.` }, 't3'),
  ).toEqual({ error: NO_PII });
});

test('automation_edit: YAML view with next runs, autoApprove stripped, a bad cron blocks', async () => {
  const s = setup();
  const input = {
    name: 'Aamukatsaus',
    cron: '30 7 * * 1',
    prompt: `Kerro ${REAL}lle päivän sää.`,
    autoApprove: ['bash'],
  };
  const v = await s.view('automation_edit', input);
  expect(v).toMatchObject({
    view: { kind: 'yaml', file: 'automations/aamukatsaus.yaml', created: true },
  });
  const view = 'view' in v && v.view.kind === 'yaml' ? v.view : undefined;
  expect(view?.nextRuns).toHaveLength(5);
  expect(view?.yaml).toContain('autoApprove: []');
  expect(view?.yaml).not.toContain('bash');
  expect(await s.exec('automation_edit', input)).toBe(SAVED);
  const file = readFileSync(join(s.automationsDir, 'aamukatsaus.yaml'), 'utf8');
  expect(file).toContain('autoApprove: []');
  expect(s.gitLog()).toBe('');
  expect(
    spawnSync('git', ['log', '--format=%s'], { cwd: s.automationsDir, encoding: 'utf8' }).stdout,
  ).toContain('automation_edit automations/aamukatsaus.yaml (chat aaaaaaaa)');
  // An update keeps the file's list; the tool never sets it.
  writeFileSync(
    join(s.automationsDir, 'aamukatsaus.yaml'),
    file.replace('autoApprove: []', 'autoApprove: [bash]'),
  );
  const upd = await s.view(
    'automation_edit',
    { id: 'aamukatsaus', enabled: false, autoApprove: [] },
    't2',
  );
  expect(upd).toMatchObject({
    view: { created: false, nextRuns: [], enabled: { from: true, to: false } },
  });
  expect('view' in upd && upd.view.kind === 'yaml' && upd.view.yaml).toMatch(
    /autoApprove: \[ ?bash ?\]/,
  );
  // An update keeps its agent; an unchanged `enabled` is not on the card.
  expect(
    await s.view('automation_edit', { id: 'aamukatsaus', agentId: 'researcher' }, 't5'),
  ).toEqual({ error: AGENT_FIXED });
  expect(
    await s.view('automation_edit', { id: 'aamukatsaus', agentId: 'assistant' }, 't6'),
  ).not.toHaveProperty('view.enabled');
  expect(await s.view('automation_edit', { name: 'x', cron: '* * *', prompt: 'x' }, 't3')).toEqual({
    error: 'Muutos ei kelpaa: cron',
  });
  expect(await s.view('automation_edit', { id: 'puuttuu', enabled: true }, 't4')).toEqual({
    error: NOT_FOUND,
  });
});

test('chat_read: restored and capped; several title hits list five; the current chat is refused', async () => {
  const s = setup();
  s.addChat('c-long', 'Pitkä keskustelu', '2026-10-02T10:00:00.000Z', 60);
  const v = await s.view('chat_read', { chatId: 'c-long' });
  expect(v).toEqual({
    view: {
      kind: 'chat',
      chatId: 'c-long',
      title: 'Pitkä keskustelu',
      createdAt: '2026-10-02T10:00:00.000Z',
      messages: 60,
      query: null,
    },
  });
  const out = await s.exec('chat_read', { chatId: 'c-long' });
  expect(out.split('\n')[0]).toBe(
    'Keskustelu "Pitkä keskustelu" (2026-10-02), 60 viestiä, 0 jätetty pois.',
  );
  expect(out).toContain(`viesti 59 ${REAL}`);
  expect(out).not.toContain(MASKED);
  expect(out).toContain('<keskustelu>');
  for (let i = 0; i < 6; i++) s.addChat(`c-loma-${i}`, `Loma ${i}`, `2026-10-1${i}T10:00:00.000Z`);
  const list = await s.exec('chat_read', { title: 'LOMA' });
  expect(list.split('\n')[0]).toBe('6 osumaa. Kutsu uudelleen yhden tunnuksella (chatId):');
  expect(list.split('\n').slice(1)).toEqual(
    [5, 4, 3, 2, 1].map((i) => `- c-loma-${i} "Loma ${i}" (2026-10-1${i})`),
  );
  expect(await s.exec('chat_read', { title: 'ei tällaista' })).toBe('Ei osumia.');
  expect(await s.exec('chat_read', { title: 'loma 3' })).toContain('Keskustelu "Loma 3"');
  // The current chat: refused by id, left out by title.
  expect(await s.view('chat_read', { chatId: CHAT })).toHaveProperty('error');
  expect(await s.exec('chat_read', { title: 'Tämä keskustelu' })).toBe('Ei osumia.');
});

test('chat_read: the newest messages within the cap; one long message is cut', async () => {
  const s = setup();
  // 40 messages of 1,000 characters each: 19 fit (with the "Käyttäjä: " prefixes).
  const many = Array.from(
    { length: 40 },
    (_, i) => `m${String(i).padStart(2, '0')}${'x'.repeat(997)}`,
  );
  s.addChat('c-big', 'Iso', '2026-10-02T10:00:00.000Z', 0, many);
  const out = await s.exec('chat_read', { chatId: 'c-big' });
  expect(out.split('\n')[0]).toMatch(
    /^Keskustelu "Iso" \(2026-10-02\), 40 viestiä, 2[01] jätetty pois\.$/,
  );
  expect(out).toContain('m39');
  expect(out).not.toContain('m00');
  const body = out.slice(out.indexOf('<keskustelu>'));
  expect(body.length).toBeLessThan(CHAT_MAX + 50);
  s.addChat('c-one', 'Yksi', '2026-10-02T11:00:00.000Z', 0, [`alku ${'y '.repeat(20_000)}`]);
  const one = await s.exec('chat_read', { chatId: 'c-one' });
  expect(one.split('\n')[0]).toContain('1 viestiä, 0 jätetty pois.');
  expect(one).toContain('…');
  expect(one.length).toBeLessThan(CHAT_MAX + 300);
});

test('no block reason holds a seeded real value', async () => {
  const s = setup();
  const reasons = await Promise.all([
    s.view('automation_edit', { name: REAL, cron: REAL, prompt: REAL }),
    s.view('automation_edit', { id: REAL, prompt: REAL }),
    s.view('automation_edit', { name: 'a', cron: '0 7 * * *', prompt: 'x', agentId: REAL }),
    s.view('profile_edit', { file: 'mode', content: `---\nname: ${REAL}\nfoo: ${REAL}\n---\n\nx` }),
    s.view('profile_edit', { file: 'mode', content: `---\nname: [${REAL}\n---\n\nx` }),
    s.view('chat_read', { chatId: REAL }),
    s.view('chat_read', { chatId: REAL, title: REAL }),
  ]);
  for (const r of reasons) {
    expect(r).toHaveProperty('error');
    expect(JSON.stringify(r)).not.toContain('Matti');
  }
});

test('profile_edit: the sidecar probe refuses a real name the model wrote; a down sidecar refuses', async () => {
  const sc = await startFakeSidecar({ [REAL]: MASKED });
  cleanups(sc.close);
  const s = setup({ pseudo: new PseudoClient(sc.url, 'u1') });
  // Written as is, not masked: the recorder sees the same text.
  s.masked.set(callKey('profile_edit', 't1'), `Olet ${REAL}n avustaja.`);
  expect(
    await s.view('profile_edit', { file: 'prompt', content: `Olet ${REAL}n avustaja.` }),
  ).toEqual({ error: NO_PII });
  expect(
    await s.view('profile_edit', { file: 'prompt', content: 'Vastaa lyhyesti.' }, 't2'),
  ).toHaveProperty('view');
  const d = setup({
    pseudo: {
      mask: async () => {
        throw new PseudoDownError('down');
      },
    },
  });
  expect(await d.view('profile_edit', { file: 'prompt', content: 'Vastaa lyhyesti.' })).toEqual({
    error: PSEUDO_DOWN,
  });
});

test('only the tools of tools.allow are registered', () => {
  const s = setup({ allow: ['chat_read', 'read'] });
  expect([...s.tools.keys()]).toEqual(['chat_read']);
});

test('a call that ends without execute drops its stamp', async () => {
  const s = setup();
  const content = 'Uusi ohje.';
  await s.view('profile_edit', { file: 'prompt', content });
  s.end('profile_edit', 't1');
  expect(await s.exec('profile_edit', { file: 'prompt', content })).toBe(STALE);
});

test('chat_read: a failed read answers fixed text in the view and in execute', async () => {
  const s = setup({
    reader: () => {
      throw new Error(`ENOENT /data/${REAL}`);
    },
  });
  s.addChat('c-x', 'X', '2026-10-02T10:00:00.000Z');
  expect(await s.view('chat_read', { chatId: 'c-x' })).toEqual({
    error: 'Keskustelua ei voitu lukea nyt.',
  });
  expect(await s.exec('chat_read', { chatId: 'c-x' })).toBe('Keskustelua ei voitu lukea nyt.');
});

test('chat_read: the cap holds after the restore', async () => {
  // Each surrogate grows on restore: the restored text would pass the cap.
  const s = setup({
    pseudo: {
      unmask: async (t: string) => ({ restored: t.replaceAll('P', 'PPPP'), spans: [], hold: 0 }),
    },
  });
  s.addChat('c-p', 'P', '2026-10-02T10:00:00.000Z', 0, ['P'.repeat(15_000)]);
  const out = await s.exec('chat_read', { chatId: 'c-p' });
  const body = out.slice(out.indexOf('<keskustelu>'));
  expect(body.length).toBeLessThan(CHAT_MAX + 50);
});
