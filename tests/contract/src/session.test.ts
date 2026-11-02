import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { startFakeLlm } from '@nolla/fake-llm';
import { expect, test } from 'vitest';
import { bootPi, keysOf, lastUserText, probe, type Seen, setup } from './harness.ts';

test('session file layout, findById and open', async () => {
  const { session, sessionManager, sessionDir, cwd } = await setup([{ text: 'reply' }], []);
  await session.prompt('first question');
  const file = sessionManager.getSessionFile();
  expect(file?.endsWith('.jsonl')).toBe(true);
  expect(dirname(file ?? '')).toBe(sessionDir);
  const header = JSON.parse(readFileSync(file ?? '', 'utf8').split('\n')[0] ?? '');
  expect(header.type).toBe('session');
  expect(header.id).toBe(sessionManager.getSessionId());
  expect(header.cwd).toBe(cwd);
  expect(SessionManager.findById(cwd, header.id, sessionDir)).toBe(file);
  const roles = SessionManager.open(file ?? '', sessionDir)
    .getEntries()
    .flatMap((e) => (e.type === 'message' ? [e.message.role] : []));
  // 1.3.0 persists the system prompt as a message entry before the user message.
  expect(roles).toEqual(['system', 'user', 'assistant']);
});

test('second createAgentSession over the opened file loads history', async () => {
  const first = await setup([{ text: 'reply' }], []);
  await first.session.prompt('first question');
  const file = first.sessionManager.getSessionFile() ?? '';
  const llm = await startFakeLlm([{ text: 'again' }]);
  try {
    const second = await bootPi({
      dataDir: first.dataDir,
      llmUrl: llm.url,
      extensions: [],
      sessionManager: SessionManager.open(file, first.sessionDir),
    });
    await second.session.prompt('second question');
    second.session.dispose();
    const msgs = llm.requests[0]?.body.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(lastUserText({ messages: msgs.slice(0, 2) })).toBe('first question');
    expect(msgs[2].content).toBe('reply');
    expect(lastUserText(llm.requests[0]?.body)).toBe('second question');
  } finally {
    await llm.close();
  }
});

test('session_start fires on bindExtensions, not on createAgentSession', async () => {
  const seen: Seen[] = [];
  const { session } = await setup([], [probe(seen)], { bind: false });
  expect(seen).toEqual([]);
  await session.bindExtensions({});
  expect(seen.map((s) => s.type)).toEqual(['session_start']);
  expect(keysOf(seen, 'session_start')).toEqual(['reason', 'type']);
  expect(seen[0]?.event.reason).toBe('startup');
});
