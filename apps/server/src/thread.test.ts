import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatExport } from '@pa/protocol';
import { afterEach, expect, test } from 'vitest';
import { api, bootChat, bootPseudo, login, open, runCleanups, turn } from './test-utils.ts';
import { monthOf } from './usage.ts';

// Phase 13 (docs/decisions/phase-13-thread.md): thinking, usage and the rate over the socket.
// Fork, edit and versions are in bridge/turns.test.ts.

afterEach(runCleanups);

const REAL = 'Matti Virtanen';
const SURROGATE = 'Pekka Laaksonen';
const cost = (usd: number) => ({ prompt_tokens: 100, completion_tokens: 20, cost: usd });

test('thinking: live state, Message.thinking with ms, thinking.get restores the text', async () => {
  const { c, chat, llm } = await bootPseudo({ [REAL]: SURROGATE }, [
    { text: 'Vastaus.', reasoning: `Mietin ${SURROGATE} asiaa.`, thinkMs: 60 },
    // A model that writes a real value into its thinking: /scan masks it before the next request.
    { text: 'Toinen.', reasoning: `Muistan ${REAL}.` },
    { text: 'Kolmas.' },
  ]);
  await turn(c, chat.id, 'Kysymys');
  const live = c.inbox.flatMap((m) => (m.type === 'message.thinking' ? [m.active] : []));
  expect(live).toEqual([true, false]);
  const final = c.inbox.findLast((m) => m.type === 'message.final');
  const message = final?.type === 'message.final' ? final.message : undefined;
  expect(message?.thinking?.ms).toBeGreaterThanOrEqual(50);
  c.send({ type: 'thinking.get', chatId: chat.id, messageId: message?.id ?? '' });
  const t = await c.next('thinking.text');
  expect(t.text).toBe(`Mietin ${REAL} asiaa.`);
  expect(t.annotations).toEqual([expect.objectContaining({ modelSaw: SURROGATE })]);

  await turn(c, chat.id, 'Jatka');
  await turn(c, chat.id, 'Vielä');
  const replay = JSON.stringify(llm.requests.at(-1)?.body);
  expect(replay).toContain(`Muistan ${SURROGATE}.`);
  expect(replay).not.toContain(REAL);
  // A message without thinking text has no thinking row.
  const plain = (await open(c, chat.id)).messages.at(-1);
  expect(plain?.thinking).toBeUndefined();
});

test('message.phase: sent, then headers, before the reply streams under the same id (phase 26)', async () => {
  const { c, chat, srv } = await bootChat([
    { toolCalls: [{ name: 'read', args: { path: 'note.txt' } }], queueMs: 80 },
    { text: 'Luin sen.', reasoning: 'Mietin.', thinkMs: 30, queueMs: 60 },
  ]);
  writeFileSync(join(srv.registry.cwd, 'note.txt'), 'hei');
  c.send({ type: 'user.message', chatId: chat.id, text: 'Lue', localId: 'local-1' });
  await c.idle();
  const kinds = new Set([
    'message.accepted',
    'message.phase',
    'message.thinking',
    'message.delta',
    'tool.start',
    'tool.end',
    'message.final',
  ]);
  const seen = c.inbox.filter((m) => kinds.has(m.type));
  const label = (m: (typeof seen)[number]) =>
    m.type === 'message.phase'
      ? m.phase
      : m.type === 'message.thinking'
        ? `thinking ${m.active}`
        : m.type;
  // One request per round: each round's phases come before anything of its message.
  expect(seen.map(label)).toEqual([
    'message.accepted',
    'sent',
    'headers',
    'tool.start',
    'tool.end',
    'message.final',
    'sent',
    'headers',
    'thinking true',
    'thinking false',
    ...seen.filter((m) => m.type === 'message.delta').map(() => 'message.delta'),
    'message.final',
  ]);
  const phases = seen.flatMap((m) => (m.type === 'message.phase' ? [m] : []));
  const [sent1, headers1, sent2, headers2] = phases;
  // Each round has its own stream id; the second round's thinking and text use it.
  expect(headers1?.messageId).toBe(sent1?.messageId);
  expect(headers2?.messageId).toBe(sent2?.messageId);
  expect(sent2?.messageId).not.toBe(sent1?.messageId);
  for (const m of seen)
    if (m.type === 'message.thinking' || m.type === 'message.delta')
      expect(m.messageId).toBe(sent2?.messageId);
  expect((headers1?.at ?? 0) - (sent1?.at ?? 0)).toBeGreaterThanOrEqual(70);
  expect((headers2?.at ?? 0) - (sent2?.at ?? 0)).toBeGreaterThanOrEqual(50);
  // The stored message keeps the same wait (the receipt after a reload) and its writing time.
  const finals = seen.flatMap((m) => (m.type === 'message.final' ? [m.message] : []));
  expect(finals[0]?.phases).toEqual({ queueMs: (headers1?.at ?? 0) - (sent1?.at ?? 0) });
  expect(finals[1]?.phases).toEqual({
    queueMs: (headers2?.at ?? 0) - (sent2?.at ?? 0),
    writeMs: expect.any(Number),
  });
  const stored = (await open(c, chat.id)).messages.filter((m) => m.role === 'assistant');
  expect(stored.map((m) => m.phases)).toEqual(finals.map((m) => m.phases));
});

test('usage.get, the summary totals and fx.state at attach', async () => {
  // 60 of the 100 prompt tokens come from the prompt cache (phase-16 decision 12).
  const cached = { ...cost(0.0123), cached_tokens: 60 };
  const { c, chat } = await bootChat([{ text: 'Vastaus.', usage: cached }]);
  await turn(c, chat.id, 'Kysymys');
  const updated = c.inbox.findLast((m) => m.type === 'chat.updated');
  expect(updated?.type === 'chat.updated' && updated.chat.usage).toEqual({
    costUsd: 0.0123,
    tokens: 120,
    input: 40,
    output: 20,
    cacheRead: 60,
    cacheWrite: 0,
  });
  c.send({ type: 'usage.get', month: monthOf(new Date()) });
  const usage = await c.next('usage.state');
  expect(usage.rows).toEqual([
    {
      model: 'zdr/google/gemini-4-argon',
      name: 'Gemini 4 Argon',
      calls: 1,
      tokens: 120,
      reasoning: 0,
      input: 40,
      output: 20,
      cacheRead: 60,
      cacheWrite: 0,
      costUsd: 0.0123,
      estimated: false,
    },
  ]);
  // The fake LLM serves the ECB CSV; the first socket may attach before the first fetch ends.
  for (;;) {
    const fx = await c.next('fx.state');
    if (fx.rate) {
      expect(fx.rate).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
      break;
    }
  }
});

test('the export carries the chat total, the cost per reply and the rate', async () => {
  const { c, chat, config } = await bootChat([{ text: 'Vastaus.', usage: cost(0.0123) }]);
  await turn(c, chat.id, 'Kysymys');
  while (!(await c.next('fx.state')).rate);
  const { cookie } = await login(config.port);
  const get = async (format: string) =>
    api(config.port, `/api/chats/${chat.id}/export?format=${format}`, { headers: { cookie } });
  const md = await (await get('md')).text();
  const nb = (t: string) => t.replace(/ €/g, '\u00a0€');
  expect(md).toContain(nb('- Kustannus: 0,01 € · 120 tokenia (EKP 23.10.2026)'));
  expect(md).toContain(nb('Kustannus: 0,011 € · 120 tokenia'));
  const json = (await (await get('json')).json()) as ChatExport;
  expect(json.fx).toEqual({ usdPerEur: 1.1193, date: '2026-10-23' });
  expect(json.chat.usage).toEqual({
    costUsd: 0.0123,
    tokens: 120,
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(json.messages[1]?.usage).toMatchObject({ costUsd: 0.0123, estimated: false });
});
