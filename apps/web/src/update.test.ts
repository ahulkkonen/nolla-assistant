import { afterEach, expect, test, vi } from 'vitest';
import { useStore } from './store.ts';
import { isIdle, reloadWhenIdle } from './update.ts';

const toast = vi.hoisted(() => ({ loading: vi.fn(() => 't'), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('isIdle: no run, an empty composer, no draft and nothing busy on the page', () => {
  const idle = { agentStatus: { a: 'idle' as const }, composing: false, draft: null };
  expect(isIdle(idle, false)).toBe(true);
  expect(isIdle(idle, true)).toBe(false);
  expect(isIdle({ ...idle, composing: true }, false)).toBe(false);
  expect(isIdle({ ...idle, draft: { chatId: 'a', text: 'Hei' } }, false)).toBe(false);
  expect(isIdle({ ...idle, agentStatus: { a: 'idle', b: 'running' } }, false)).toBe(false);
});

test('reloadWhenIdle: one watcher, waits for text in a focused field, rechecks after the toast', () => {
  vi.useFakeTimers();
  const listeners: (() => void)[] = [];
  const doc = {
    body: {},
    activeElement: null as { tagName: string; value: string } | null,
    querySelector: () => null,
    addEventListener: (_type: string, f: () => void) => listeners.push(f),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
    },
  );
  const reload = vi.fn();
  useStore.setState({ agentStatus: {}, composing: true, draft: null });
  reloadWhenIdle(reload);
  reloadWhenIdle(reload);
  expect(listeners).toHaveLength(2);

  // (b) Text in a focused input (e.g. the find bar) is not idle.
  doc.activeElement = { tagName: 'INPUT', value: 'haku' };
  useStore.setState({ composing: false });
  expect(toast.loading).not.toHaveBeenCalled();
  doc.activeElement.value = '';
  for (const f of listeners) f();
  // (c) One toast although two watchers were asked for and two listeners fired.
  expect(toast.loading).toHaveBeenCalledTimes(1);

  // (a) The user starts typing within the second: no reload, the wait starts again.
  useStore.setState({ composing: true });
  vi.advanceTimersByTime(1000);
  expect(reload).not.toHaveBeenCalled();
  expect(toast.dismiss).toHaveBeenCalledWith('t');

  useStore.setState({ composing: false });
  expect(toast.loading).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1000);
  expect(reload).toHaveBeenCalledTimes(1);
});
