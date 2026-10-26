import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { automationRuns, chats } from '@pa/db';
import type { AgentDoc, AgentList, DeviceSession } from '@pa/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test, vi } from 'vitest';
import type WebSocket from 'ws';
import { deviceLabel } from './auth/session.ts';
import { api, boot, connect, login, PASSWORD, runCleanups, tempDir } from './test-utils.ts';

afterEach(runCleanups);

// The same reply serves chat turns and the title job (JSON text).
const turn = {
  text: JSON.stringify({ title: 'x', topics: [], proposed_topic: null, summary: 'Yhteenveto' }),
};

/** Profiles and automations under DATA_DIR, seeded from the repository, as in production. */
async function bootAdmin(
  turns = Array.from({ length: 12 }, () => turn),
  prep: (data: string) => void = () => {},
) {
  const data = tempDir('pa-admin-');
  const agentsDir = join(data, 'agents');
  const automationsDir = join(data, 'automations');
  prep(data);
  const b = await boot(turns, {
    DATA_DIR: data,
    AGENTS_DIR: agentsDir,
    AUTOMATIONS_DIR: automationsDir,
  });
  const srv = await b.run();
  const { port } = b.config;
  const { cookie } = await login(port);
  const call = (method: string, path: string, body?: unknown) =>
    api(port, path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const c = await connect(port);
  await c.next('agents.state');
  return { ...b, srv, port, cookie, call, c, agentsDir, automationsDir };
}

const gitLog = (dir: string) =>
  spawnSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).stdout;

test('agents: create, update from the form keeps comments, YAML tab, dry run, delete rules, reload', {
  timeout: 60_000,
}, async () => {
  const { call, c, agentsDir, automationsDir, srv, llm } = await bootAdmin();
  const file = (id: string) => join(agentsDir, `${id}.yaml`);
  /** Each save and the watcher's reload send `agents.state`: wait for one that has `id`. */
  const stateWith = async (id: string) => {
    for (;;) {
      const { agents } = await c.next('agents.state');
      const found = agents.find((x) => x.id === id);
      if (found) return found;
    }
  };
  const list = (await (await call('GET', '/api/agents')).json()) as AgentList;
  expect(list.defaultId).toBe('assistant');
  expect(list.agents.map((a) => [a.id, a.error])).toEqual([
    ['assistant', null],
    ['research', null],
  ]);
  expect(list.options.tools).toContain('web_search');
  expect(list.options.aliases.map((a) => a.id)).toContain('zdr/strong');
  const a = list.agents[0] as AgentDoc & { profile: NonNullable<AgentDoc['profile']> };
  expect(a.profile).toMatchObject({ name: 'Avustaja', prompt: 'prompts/assistant.md' });
  expect(a.prompt).toContain('web_search');

  // The form: comments on unchanged keys stay, lists stay in flow style, the prompt file changes.
  const put = await call('PUT', '/api/agents/assistant', {
    profile: {
      ...a.profile,
      name: 'Avustaja 2',
      tools: { ...a.profile.tools, allow: [...a.profile.tools.allow, 'grep'] },
    },
    prompt: `${a.prompt}\nLisärivi.`,
  });
  expect(put.status).toBe(200);
  const yaml = readFileSync(file('assistant'), 'utf8');
  expect(yaml).toContain('# web_search asks only when the query names a vault entity');
  expect(yaml).toContain('name: Avustaja 2');
  expect(yaml).toMatch(/allow: \[.*web_search, grep \]/);
  expect(readFileSync(join(agentsDir, 'prompts', 'assistant.md'), 'utf8')).toContain('Lisärivi.');
  expect((await stateWith('assistant')).name).toBe('Avustaja 2');
  expect(gitLog(agentsDir)).toContain('agent assistant saved');

  // Dry run from the YAML tab: the parsed profile back, nothing written.
  const dry = await call('PUT', '/api/agents/assistant?dry=1', {
    yaml: yaml.replace('name: Avustaja 2', 'name: Kuiva'),
    prompt: 'x',
  });
  expect(dry.status).toBe(200);
  expect(((await dry.json()) as AgentDoc).profile?.name).toBe('Kuiva');
  expect(readFileSync(file('assistant'), 'utf8')).toBe(yaml);
  // A YAML tab save writes the text as sent.
  const raw = await call('PUT', '/api/agents/assistant', {
    yaml: `${yaml}# oma kommentti\n`,
    prompt: a.prompt,
  });
  expect(raw.status).toBe(200);
  expect(readFileSync(file('assistant'), 'utf8')).toBe(`${yaml}# oma kommentti\n`);
  // A key the form does not send survives a form save (here `skills`).
  const skilled = yaml.replace('skills: []', 'skills: [ cite ]');
  expect(skilled).not.toBe(yaml);
  await call('PUT', '/api/agents/assistant', { yaml: skilled, prompt: a.prompt });
  const { skills: __, ...noSkills } = a.profile;
  const formSave = await call('PUT', '/api/agents/assistant', {
    profile: { ...noSkills, name: 'Avustaja 3' },
    prompt: a.prompt,
  });
  expect(formSave.status).toBe(200);
  const afterForm = readFileSync(file('assistant'), 'utf8');
  expect(afterForm).toContain('skills: [ cite ]');
  expect(afterForm).toContain('name: Avustaja 3');

  // New from the form: the id comes from the name, the prompt file from the id.
  const created = await call('POST', '/api/agents', {
    profile: {
      name: 'Kirjoittaja Ääkkönen',
      model: 'zdr/fast',
      tools: { allow: ['read', 'write'] },
      approval: { always: ['write'] },
    },
    prompt: 'Olet kirjoittaja.',
  });
  expect(created.status).toBe(201);
  const doc = (await created.json()) as AgentDoc & { profile: NonNullable<AgentDoc['profile']> };
  expect(doc).toMatchObject({
    id: 'kirjoittaja-aakkonen',
    profile: { prompt: 'prompts/kirjoittaja-aakkonen.md' },
  });
  expect(readFileSync(join(agentsDir, 'prompts', 'kirjoittaja-aakkonen.md'), 'utf8')).toBe(
    'Olet kirjoittaja.\n',
  );
  expect((await stateWith('kirjoittaja-aakkonen')).name).toBe('Kirjoittaja Ääkkönen');
  expect((await call('POST', '/api/agents', { yaml: doc.yaml, prompt: 'x' })).status).toBe(409);
  // "Monista": the copy without an id gets its own id and prompt file.
  const { id: _, ...copy } = doc.profile;
  const dup = await call('POST', '/api/agents', {
    profile: { ...copy, name: 'Kirjoittaja Ääkkönen (kopio)' },
    prompt: 'Olet kirjoittaja.',
  });
  expect(((await dup.json()) as AgentDoc).profile?.prompt).toBe(
    'prompts/kirjoittaja-aakkonen-kopio.md',
  );

  // The registry picks the saved prompt at the chat's next message.
  c.send({ type: 'chat.create', agentId: 'kirjoittaja-aakkonen' });
  const { chat } = await c.next('chat.created');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Moi' });
  await c.idle();
  const sent = (s: string) => llm.requests.some((r) => JSON.stringify(r.body).includes(s));
  expect(sent('Olet kirjoittaja.')).toBe(true);
  const saved = await call('PUT', '/api/agents/kirjoittaja-aakkonen', {
    profile: doc.profile,
    prompt: 'Olet runoilija.',
  });
  expect(saved.status).toBe(200);
  c.send({ type: 'user.message', chatId: chat.id, text: 'Toinen' });
  await c.idle();
  expect(sent('Olet runoilija.')).toBe(true);

  // Delete: never the default agent, never while a chat runs or an automation names it.
  const del = () => call('DELETE', '/api/agents/kirjoittaja-aakkonen');
  const assistant = await call('DELETE', '/api/agents/assistant');
  expect([assistant.status, await assistant.json()]).toEqual([409, { error: 'default_agent' }]);
  let release = () => {};
  srv.registry.hold(chat.id, new Promise<void>((r) => (release = r)));
  const busy = await del();
  expect([busy.status, await busy.json()]).toEqual([409, { error: 'in_use', chats: 1 }]);
  release();
  await vi.waitFor(() => expect(srv.registry.running(chat.id)).toBe(false));
  const auto = join(automationsDir, 'k.yaml');
  writeFileSync(auto, "id: k\ncron: '0 0 1 1 *'\nagentId: kirjoittaja-aakkonen\nprompt: x\n");
  const named = await del();
  expect([named.status, await named.json()]).toEqual([
    409,
    { error: 'in_use', automations: ['k'] },
  ]);
  rmSync(auto);
  expect((await del()).status).toBe(204);
  expect(existsSync(file('kirjoittaja-aakkonen'))).toBe(false);
  expect(existsSync(join(agentsDir, 'prompts', 'kirjoittaja-aakkonen.md'))).toBe(false);
  expect(srv.db.select().from(chats).where(eq(chats.id, chat.id)).get()?.agentId).toBe('assistant');
  expect((await del()).status).toBe(404);
  expect(gitLog(agentsDir)).toContain('agent kirjoittaja-aakkonen deleted');
});

test('agents: validation errors name the field', { timeout: 30_000 }, async () => {
  // A copy that a crash cut short is replaced, not kept.
  const { call, agentsDir } = await bootAdmin(undefined, (data) => {
    mkdirSync(join(data, 'agents.seeding'));
    writeFileSync(join(data, 'agents.seeding', 'puolikas.yaml'), 'id: puo');
  });
  expect(existsSync(join(agentsDir, 'assistant.yaml'))).toBe(true);
  expect(existsSync(join(agentsDir, 'puolikas.yaml'))).toBe(false);
  expect(existsSync(`${agentsDir}.seeding`)).toBe(false);
  const { agents } = (await (await call('GET', '/api/agents')).json()) as AgentList;
  const profile = agents[0]?.profile;
  const before = readFileSync(join(agentsDir, 'assistant.yaml'), 'utf8');
  const bad = async (method: string, path: string, body: object, field: string) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_message', path: field });
  };
  const put = (p: object, field: string) =>
    bad('PUT', '/api/agents/assistant', { profile: { ...profile, ...p }, prompt: 'x' }, field);
  const post = (p: object, field: string) =>
    bad('POST', '/api/agents', { profile: { model: 'zdr/fast', ...p }, prompt: 'x' }, field);
  await put({ model: 'zdr/acme/none' }, 'model');
  await put({ model: 'zdr/nope' }, 'model');
  await put({ id: 'other' }, 'id');
  await put({ prompt: 'prompts/research.md' }, 'prompt');
  await put({ tools: { allow: ['read'], extra: 1 } }, 'tools');
  await post({ name: 'B', tools: { allow: ['bash'] } }, 'approval');
  await post({ name: '', tools: { allow: [] } }, 'name');
  await post({ name: 'C', tools: { allow: [1] } }, 'tools.allow.0');
  await post({ name: 'D', tools: { allow: ['read', 'teleport'] } }, 'tools.allow.1');
  // An alias bomb is a 400, not a 500.
  const ten = (p: string) => `[${Array(10).fill(`*${p}`).join(', ')}]`;
  const bomb = `a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b ${ten('a')}\nc: &c ${ten('b')}\nd: &d ${ten('c')}\ne: ${ten('d')}\n`;
  await bad('PUT', '/api/agents/assistant', { yaml: bomb, prompt: 'x' }, '');
  await bad('POST', '/api/agents', { yaml: bomb, prompt: 'x' }, '');
  await bad('PUT', '/api/agents/assistant', { yaml: 'name: [', prompt: 'x' }, '');
  await bad('PUT', '/api/agents/assistant', { yaml: '- a\n- b\n', prompt: 'x' }, '');
  expect((await call('PUT', '/api/agents/..%2Fx', { profile, prompt: 'x' })).status).toBe(404);
  expect((await call('PUT', '/api/agents/nope', { profile, prompt: 'x' })).status).toBe(404);
  expect(readFileSync(join(agentsDir, 'assistant.yaml'), 'utf8')).toBe(before);
  expect(existsSync(join(agentsDir, 'b.yaml'))).toBe(false);

  // A hand-written profile uses `prompts/kopio.md`: a new `kopio` must not overwrite it.
  writeFileSync(join(agentsDir, 'prompts', 'kopio.md'), 'Vieras ohje.');
  writeFileSync(join(agentsDir, 'vieras.yaml'), 'id: vieras\nprompt: prompts/kopio.md\n');
  const fresh = { model: 'zdr/fast', tools: { allow: ['read'] } };
  const taken = await call('POST', '/api/agents', {
    profile: { ...fresh, id: 'kopio', name: 'Kopio' },
    prompt: 'x',
  });
  expect([taken.status, await taken.json()]).toEqual([409, { error: 'exists' }]);
  const derived = await call('POST', '/api/agents', {
    profile: { ...fresh, name: 'Kopio' },
    prompt: 'x',
  });
  expect(((await derived.json()) as AgentDoc).id).toBe('kopio-2');
  expect(readFileSync(join(agentsDir, 'prompts', 'kopio.md'), 'utf8')).toBe('Vieras ohje.');
});

test('automations: create, preview, update, disable, delete, run now', {
  timeout: 60_000,
}, async () => {
  const { call, c, automationsDir, srv } = await bootAdmin();
  const preview = await call('POST', '/api/automations/preview', { cron: '30 7 * * 1-5' });
  const { runs } = (await preview.json()) as { runs: string[] };
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  expect(runs).toHaveLength(5);
  for (const r of runs) expect(local.format(new Date(r))).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 07:30$/);
  for (const [body, field] of [
    [{ cron: '61 * * * *' }, 'cron'],
    [{ cron: '* * * * *', timezone: 'Mars/Olympus' }, 'timezone'],
    // Seconds, and runs closer than 5 minutes.
    [{ cron: '0 30 7 * * 1-5' }, 'cron'],
    [{ cron: '*/2 * * * *' }, 'cron'],
    [{ cron: '0,1 9 * * *' }, 'cron'],
  ] as const) {
    const res = await call('POST', '/api/automations/preview', body);
    expect([res.status, ((await res.json()) as { path: string }).path]).toEqual([400, field]);
  }

  const fields = {
    name: 'Aamukatsaus',
    cron: '30 7 * * 1-5',
    agentId: 'assistant',
    prompt: 'Moikka',
    deliver: 'chat',
  };
  const created = await call('POST', '/api/automations', fields);
  expect([created.status, await created.json()]).toEqual([201, { id: 'aamukatsaus' }]);
  expect((await c.next('automations.state')).automations).toEqual([
    expect.objectContaining({
      id: 'aamukatsaus',
      name: 'Aamukatsaus',
      enabled: true,
      timezone: 'Europe/Helsinki',
      prompt: 'Moikka',
      autoApprove: [],
      nextRunAt: runs[0],
    }),
  ]);
  expect((await call('POST', '/api/automations', fields)).status).toBe(201);
  // File name order.
  expect((await c.next('automations.state')).automations.map((a) => a.id)).toEqual([
    'aamukatsaus-2',
    'aamukatsaus',
  ]);
  expect((await call('DELETE', '/api/automations/aamukatsaus-2')).status).toBe(204);
  await c.next('automations.state');

  const path = '/api/automations/aamukatsaus';
  expect(
    (await call('PUT', path, { ...fields, timezone: 'Europe/Stockholm', autoApprove: ['write'] }))
      .status,
  ).toBe(200);
  await c.next('automations.state');
  // A whole state item back: only the file's keys are written; keys it leaves out stay.
  const off = await call('PUT', path, {
    ...fields,
    deliver: 'push',
    enabled: false,
    lastStatus: 'ok',
  });
  expect(off.status).toBe(200);
  expect((await c.next('automations.state')).automations[0]).toMatchObject({
    enabled: false,
    deliver: 'push',
    nextRunAt: null,
  });
  const text = readFileSync(join(automationsDir, 'aamukatsaus.yaml'), 'utf8');
  expect(text).toContain('enabled: false');
  expect(text).not.toContain('lastStatus');
  expect(text).toContain('timezone: Europe/Stockholm');
  expect(text).toContain('autoApprove: [ write ]');
  for (const [body, field] of [
    [{ ...fields, agentId: 'nope' }, 'agentId'],
    [{ ...fields, cron: 'joka aamu' }, 'cron'],
    [{ ...fields, cron: '*/1 * * * *' }, 'cron'],
    [{ ...fields, id: 'muu' }, 'id'],
  ] as const) {
    const res = await call('PUT', path, body);
    expect([res.status, ((await res.json()) as { path: string }).path]).toEqual([400, field]);
  }
  expect((await call('PUT', '/api/automations/nope', fields)).status).toBe(404);
  // A hand-written file keeps its six-field cron while the form toggles it.
  const hand = "id: vuosi\ncron: '0 0 0 1 1 *'\nprompt: Moi\n";
  writeFileSync(join(automationsDir, 'vuosi.yaml'), hand);
  const toggled = await call('PUT', '/api/automations/vuosi', {
    cron: '0 0 0 1 1 *',
    prompt: 'Moi',
    enabled: false,
  });
  expect(toggled.status).toBe(200);
  expect(
    (await c.next('automations.state')).automations.find((x) => x.id === 'vuosi')?.enabled,
  ).toBe(false);
  expect((await call('DELETE', '/api/automations/vuosi')).status).toBe(204);
  await c.next('automations.state');

  // "Aja nyt" runs a disabled automation through the existing path.
  c.send({ type: 'automations.run', id: 'aamukatsaus' });
  expect((await c.next('automations.state')).automations[0]?.lastStatus).toBe('running');
  const run = () =>
    srv.db.select().from(automationRuns).where(eq(automationRuns.id, 'aamukatsaus')).get();
  await vi.waitFor(() => expect(run()?.lastStatus).toBe('ok'), { timeout: 10_000 });

  expect((await call('DELETE', path)).status).toBe(204);
  expect((await c.next('automations.state')).automations).toEqual([]);
  expect(existsSync(join(automationsDir, 'aamukatsaus.yaml'))).toBe(false);
  expect(run()).toBeUndefined();
  expect((await call('DELETE', path)).status).toBe(404);
  expect(gitLog(automationsDir)).toContain('automation aamukatsaus saved');
});

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('sessions: list, revoke one, revoke all rotates the current token and closes the other sockets', {
  timeout: 30_000,
}, async () => {
  expect(deviceLabel(MAC_CHROME)).toBe('Chrome · macOS');
  expect(deviceLabel(IPHONE)).toBe('Safari · iPhone');
  expect(deviceLabel('curl/8.7')).toBeNull();
  const b = await boot([]);
  await b.run();
  const { port } = b.config;
  const signIn = async (ua: string) => {
    const res = await api(port, '/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify({ password: PASSWORD }),
    });
    return res.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  };
  const [a, phone, other] = [await signIn(MAC_CHROME), await signIn(IPHONE), await signIn('x')];
  const sessions = (cookie: string) => api(port, '/api/auth/sessions', { headers: { cookie } });
  const listed = async (cookie: string) =>
    ((await (await sessions(cookie)).json()) as { sessions: DeviceSession[] }).sessions;
  const all = await listed(a);
  expect(all.map((s) => [s.label, s.current])).toEqual(
    expect.arrayContaining([
      ['Chrome · macOS', true],
      ['Safari · iPhone', false],
      [null, false],
    ]),
  );
  const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', r));

  // One device.
  const phoneWs = await connect(port, undefined, phone);
  const phoneClosed = closed(phoneWs.ws);
  const phoneId = all.find((s) => s.label === 'Safari · iPhone')?.id;
  const revoke = (id: string, cookie = a) =>
    api(port, `/api/auth/sessions/${id}`, { method: 'DELETE', headers: { cookie } });
  expect((await revoke(phoneId ?? '')).status).toBe(204);
  expect(await phoneClosed).toBe(4401);
  expect((await sessions(phone)).status).toBe(401);
  expect((await revoke('nope')).status).toBe(404);

  // Everywhere: the others go, this device gets a new token and keeps its socket.
  const own = await connect(port, undefined, a);
  const otherWs = await connect(port, undefined, other);
  const otherClosed = closed(otherWs.ws);
  const res = await api(port, '/api/auth/sessions/revoke-all', {
    method: 'POST',
    headers: { cookie: a },
  });
  expect(res.status).toBe(204);
  const rotated = res.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  expect(rotated).toMatch(/^pa_session=/);
  expect(rotated).not.toBe(a);
  expect(await otherClosed).toBe(4401);
  expect((await sessions(a)).status).toBe(401);
  expect((await sessions(other)).status).toBe(401);
  expect(await listed(rotated)).toEqual([
    expect.objectContaining({
      label: 'Chrome · macOS',
      current: true,
      createdAt: all.find((s) => s.current)?.createdAt,
    }),
  ]);
  own.send({ type: 'ping' });
  await own.next('pong');
  // The moved socket belongs to the new session: signing out closes it.
  const ownClosed = closed(own.ws);
  await api(port, '/api/auth/logout', { method: 'POST', headers: { cookie: rotated } });
  expect(await ownClosed).toBe(4401);
});
