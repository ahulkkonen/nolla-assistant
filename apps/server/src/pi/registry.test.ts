import { expect, test } from 'vitest';
import { sessionTaint } from './registry.ts';

/** Runs `tool_call` of a session taint for one tool, as Pi calls the hook. */
const callTool = (o: Parameters<typeof sessionTaint>[1], toolName: string) => {
  const hooks = new Map<string, (e: unknown, ctx: unknown) => void>();
  const t = sessionTaint('c1', o);
  t.extension({ on: (name: string, h: never) => hooks.set(name, h) } as never);
  hooks.get('tool_call')?.({ toolName, input: {} }, { cwd: process.cwd() });
  return t.tainted();
};

test('phase-30 decision 14: with pseudo, a tool with outside content marks the chat; memory is not needed', () => {
  const marked: string[] = [];
  const onTaint = (chatId: string) => void marked.push(chatId);
  expect(callTool({ pseudo: {} as never, onTaint }, 'fetch_url')).toBe(true);
  expect(marked).toEqual(['c1']);
  // Without the sidecar nothing is masked, so nothing is marked; the turn still counts.
  expect(callTool({ onTaint }, 'fetch_url')).toBe(true);
  expect(callTool({ pseudo: {} as never, onTaint }, 'memory')).toBe(false);
  expect(marked).toEqual(['c1']);
});
