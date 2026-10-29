import { expect, test } from 'vitest';
import { isIdle } from './update.ts';

test('isIdle: no run, an empty composer, no draft and no dialog', () => {
  const idle = { agentStatus: { a: 'idle' as const }, composing: false, draft: null };
  expect(isIdle(idle, false)).toBe(true);
  expect(isIdle(idle, true)).toBe(false);
  expect(isIdle({ ...idle, composing: true }, false)).toBe(false);
  expect(isIdle({ ...idle, draft: { chatId: 'a', text: 'Hei' } }, false)).toBe(false);
  expect(isIdle({ ...idle, agentStatus: { a: 'idle', b: 'running' } }, false)).toBe(false);
});
