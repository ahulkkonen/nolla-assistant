import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { onCleanup, setup } from '@pa/contract-tests/src/harness.ts';
import { expect, test } from 'vitest';
import { startFakeBroker } from './fake-broker.ts';
import { sandboxExtension } from './index.ts';

const TOKEN = 't'.repeat(32);

async function runBash(args: Record<string, unknown>) {
  const broker = await startFakeBroker({ token: TOKEN, root: '' });
  onCleanup(broker.close);
  const ext = sandboxExtension({ brokerUrl: broker.url, token: TOKEN, userId: 'u1', chatId: 'c1' });
  const pi = await setup([{ toolCalls: [{ name: 'bash', args }] }, { text: 'done' }], [ext], {
    tools: ['read', 'bash'],
  });
  broker.state.root = pi.cwd;
  const events: AgentSessionEvent[] = [];
  pi.session.subscribe((e) => void events.push(e));
  await pi.session.prompt('Aja');
  const end = events.find((e) => e.type === 'tool_execution_end');
  const result = end && 'result' in end ? end.result : undefined;
  return { ...pi, broker, events, result, text: result?.content?.[0]?.text as string };
}

test('runs the command through the broker and streams output', async () => {
  const { broker, cwd, events, result, text } = await runBash({
    command: 'echo hei > out.txt && cat out.txt',
  });
  expect(text).toContain('hei');
  expect(result.details).toEqual({ exit: 0, timedOut: false });
  expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('hei\n');
  const updates = events.filter((e) => e.type === 'tool_execution_update');
  expect(updates.some((u) => JSON.stringify(u).includes('hei'))).toBe(true);
  expect(broker.requests[0]?.body).toMatchObject({ userId: 'u1', chatId: 'c1' });
});

test('non-zero exit is reported in details', async () => {
  const { result, text } = await runBash({ command: 'echo nope; exit 3' });
  expect(result.details.exit).toBe(3);
  expect(text).toContain('[exit 3]');
});

test('timeout kills the command', async () => {
  const t0 = Date.now();
  const { broker, result } = await runBash({ command: 'sleep 10', timeout: 1 });
  expect(Date.now() - t0).toBeLessThan(8000);
  expect(result.details.timedOut).toBe(true);
  expect(broker.requests[0]?.body.timeoutMs).toBe(1000);
});
