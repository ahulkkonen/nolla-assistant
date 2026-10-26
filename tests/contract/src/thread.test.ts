import { existsSync, readFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, test } from 'vitest';
import { setup } from './harness.ts';

// Pi facts that phase 13 builds on (docs/decisions/phase-13-thread.md, research 2, 4 and 5).

const turn = {
  text: 'vastaus',
  reasoning: 'mietin ensin',
  usage: { prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: 5, cost: 0.0123 },
};

test('provider_stream_event carries the usage chunk; Pi drops its cost', async () => {
  const chunks: unknown[] = [];
  const { session } = await setup(
    [turn],
    [(pi) => void pi.on('provider_stream_event', (e) => void chunks.push(e.data))],
  );
  await session.prompt('kysymys');
  const last = chunks.at(-1) as { usage?: { cost?: number } };
  expect(last.usage?.cost).toBe(0.0123);
  const m = session.messages.at(-1);
  if (m?.role !== 'assistant') throw new Error('no assistant message');
  // Pi's own price table (0 in the harness), not LiteLLM's cost.
  expect(m.usage).toMatchObject({ input: 100, output: 20, reasoning: 5, cost: { total: 0 } });
});

test('a message_end replacement with an unknown key reaches the JSONL and survives reopen', async () => {
  const { session, sessionManager, sessionDir } = await setup(
    [turn],
    [
      (pi) =>
        void pi.on('message_end', (e) =>
          e.message.role === 'assistant'
            ? { message: { ...e.message, pa: { costUsd: 0.0123 } } as typeof e.message }
            : undefined,
        ),
    ],
  );
  const seen: unknown[] = [];
  session.subscribe((e) => {
    if (e.type === 'message_end' && e.message.role === 'assistant') seen.push(e.message);
  });
  await session.prompt('kysymys');
  // Listeners see the replaced message.
  expect(seen[0]).toMatchObject({ pa: { costUsd: 0.0123 } });
  const file = sessionManager.getSessionFile() ?? '';
  const reopened = SessionManager.open(file, sessionDir)
    .getEntries()
    .flatMap((e) => (e.type === 'message' && e.message.role === 'assistant' ? [e.message] : []));
  expect(reopened[0]).toMatchObject({ pa: { costUsd: 0.0123 } });
});

test('reasoning deltas form one thinking block; thinking_end comes only after the text', async () => {
  const kinds: string[] = [];
  const { session } = await setup(
    [turn],
    [(pi) => void pi.on('message_update', (e) => void kinds.push(e.assistantMessageEvent.type))],
  );
  await session.prompt('kysymys');
  expect(kinds.indexOf('thinking_start')).toBeLessThan(kinds.indexOf('text_start'));
  expect(kinds.lastIndexOf('thinking_delta')).toBeLessThan(kinds.indexOf('text_delta'));
  expect(kinds.indexOf('thinking_end')).toBeGreaterThan(kinds.lastIndexOf('text_delta'));
  const m = session.messages.at(-1);
  if (m?.role !== 'assistant') throw new Error('no assistant message');
  expect(m.content).toEqual([
    expect.objectContaining({ type: 'thinking', thinking: 'mietin ensin' }),
    expect.objectContaining({ type: 'text', text: 'vastaus' }),
  ]);
});

test('createBranchedSession on a second manager copies the path and leaves the source', async () => {
  const { session, sessionManager, sessionDir, cwd } = await setup(
    [{ text: 'eka' }, { text: 'toka' }],
    [],
  );
  await session.prompt('ensimmäinen');
  await session.prompt('toinen');
  const source = sessionManager.getSessionFile() ?? '';
  const before = readFileSync(source, 'utf8');
  const firstReply = sessionManager
    .getBranch()
    .find((e) => e.type === 'message' && e.message.role === 'assistant');
  if (!firstReply) throw new Error('no reply');

  const second = SessionManager.open(source, sessionDir);
  const file = second.createBranchedSession(firstReply.id) ?? '';
  const id = second.getSessionId();
  expect(id).not.toBe(sessionManager.getSessionId());
  expect(existsSync(file)).toBe(true);
  expect(SessionManager.findById(cwd, id, sessionDir)).toBe(file);
  // The source file and the live manager do not change.
  expect(readFileSync(source, 'utf8')).toBe(before);
  expect(sessionManager.getSessionFile()).toBe(source);
  // The copy holds the path up to the fork point, same ids, same masked content.
  const copied = SessionManager.open(file, sessionDir).getEntries();
  const path = sessionManager.getBranch(firstReply.id);
  expect(copied.map((e) => e.id)).toEqual(path.map((e) => e.id));
  expect(JSON.stringify(copied.at(-1))).toBe(JSON.stringify(path.at(-1)));
  const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '');
  expect(header).toMatchObject({ type: 'session', id, parentSession: source });
});

test('one message_end per assistant message, tool rounds included (no re-emit)', async () => {
  const ends: unknown[] = [];
  const { session } = await setup(
    [{ toolCalls: [{ name: 'read', args: { path: 'missing.txt' } }] }, { text: 'valmis' }],
    [
      (pi) =>
        void pi.on(
          'message_end',
          (e) => void (e.message.role === 'assistant' && ends.push(e.message)),
        ),
    ],
  );
  const listened: unknown[] = [];
  session.subscribe((e) => {
    if (e.type === 'message_end' && e.message.role === 'assistant') listened.push(e.message);
  });
  await session.prompt('lue');
  expect(ends).toHaveLength(2);
  expect(new Set(ends).size).toBe(2);
  expect(listened).toHaveLength(2);
});
