import type { ChatSummary } from '@pa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPath, pathOf, startRouter } from './router.ts';
import { useStore } from './store.ts';
import { openChat, runSearch } from './ws.ts';

type State = ReturnType<typeof useStore.getState>;
const initial = useStore.getState();

/** A session history like the browser's; `back` fires `popstate` on the next microtask. */
let entries: { url: string; state: unknown }[] = [];
let at = 0;
const loc = new URL('http://app/');
const win = new EventTarget();
const history = {
  get state() {
    return entries[at]?.state ?? null;
  },
  pushState(state: unknown, _: string, url: string) {
    entries = [...entries.slice(0, at + 1), { url, state }];
    at++;
    loc.href = new URL(url, loc).href;
  },
  replaceState(state: unknown, _: string, url: string) {
    entries[at] = { url, state };
    loc.href = new URL(url, loc).href;
  },
  back() {
    queueMicrotask(() => {
      at--;
      loc.href = new URL(entries[at]?.url ?? '/', loc).href;
      win.dispatchEvent(new Event('popstate'));
    });
  },
};
const load = (url: string) => {
  entries = [{ url, state: null }];
  at = 0;
  loc.href = new URL(url, loc).href;
};
const here = () => loc.pathname + loc.search;
const urls = () => entries.map((e) => e.url);
const st = () => useStore.getState();

const chat = (id: string): ChatSummary => ({
  id,
  title: id,
  topicId: null,
  agentId: 'assistant',
  pinned: false,
  archived: false,
  modelPolicy: { modelId: 'auto', reasoning: 'auto', dataPolicy: 'zdr' },
  modes: null,
  updatedAt: '2026-10-29T00:00:00.000Z',
});

beforeEach(() => {
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', history);
  vi.stubGlobal('window', win);
  load('/');
});
afterEach(() => {
  useStore.setState(initial, true);
  vi.unstubAllGlobals();
});

const SCREENS = ['topics', 'memory', 'files', 'vault', 'agents', 'automations', 'usage', 'devices'];
const ROWS: [string, Partial<State>][] = [
  ['/', { screen: 'chat', activeChatId: null, settingsOpen: false }],
  ['/c/abc', { screen: 'chat', activeChatId: 'abc' }],
  ['/search?q=kissa%20koira', { screen: 'search', search: { q: 'kissa koira', results: null } }],
  ['/search', { screen: 'search', search: null }],
  ...SCREENS.map((s): [string, Partial<State>] => [`/${s}`, { screen: s as State['screen'] }]),
  ['/settings', { settingsOpen: true, screen: 'chat', activeChatId: null }],
];

describe('pathOf and applyPath (phase-23 decision 15)', () => {
  it.each(ROWS)('%s', (path, state) => {
    load(path);
    applyPath(path);
    expect(st()).toMatchObject(state);
    expect(pathOf(st())).toBe(path);
    expect(here()).toBe(path);
  });

  it('pathOf: another screen hides the open chat; settings covers every screen', () => {
    expect(pathOf({ ...initial, screen: 'files', activeChatId: 'abc' })).toBe('/files');
    expect(pathOf({ ...initial, screen: 'search', search: null })).toBe('/search');
    expect(pathOf({ ...initial, screen: 'vault', settingsOpen: true })).toBe('/settings');
  });

  it.each(['/nope', '/c/', '/c/a/b', '/c/%E0', '/files/x', `/c/${'a'.repeat(65)}`])(
    '%s is replaced with /',
    (path) => {
      load(path);
      useStore.setState({ screen: 'files' });
      applyPath(path);
      expect(st()).toMatchObject({ screen: 'chat', activeChatId: null });
      expect(urls()).toEqual(['/']);
    },
  );

  it('a path closes settings; what is on screen is not opened again', () => {
    applyPath('/c/abc');
    useStore.setState({ scrollTo: 'm1', settingsOpen: true });
    applyPath('/c/abc');
    expect(st()).toMatchObject({ activeChatId: 'abc', scrollTo: 'm1', settingsOpen: false });
    runSearch('kissa');
    useStore.setState({ search: { q: 'kissa', results: [] }, screen: 'chat' });
    applyPath('/search?q=kissa');
    expect(st()).toMatchObject({ screen: 'search', search: { q: 'kissa', results: [] } });
  });
});

describe('startRouter (decisions 16 to 18)', () => {
  let stop = () => {};
  afterEach(() => stop());

  it('?chat= becomes /c/<id>; the query of another link goes', () => {
    load('/?chat=abc');
    stop = startRouter();
    expect(st().activeChatId).toBe('abc');
    expect(urls()).toEqual(['/c/abc']);
    stop();
    load('/files?integrations=google');
    stop = startRouter();
    expect(urls()).toEqual(['/files']);
  });

  it('a new path pushes, a new query replaces, back applies without a push', async () => {
    stop = startRouter();
    st().apply({ type: 'chat.list', chats: [chat('a'), chat('b')] });
    openChat('a');
    openChat('b');
    st().setScreen('files');
    runSearch('x');
    runSearch('y');
    expect(urls()).toEqual(['/', '/c/a', '/c/b', '/files', '/search?q=y']);
    history.back();
    await Promise.resolve();
    expect(st().screen).toBe('files');
    history.back();
    await Promise.resolve();
    expect(st()).toMatchObject({ screen: 'chat', activeChatId: 'b' });
    expect(urls()).toHaveLength(5);
    st().setActive(null);
    expect(urls()).toEqual(['/', '/c/a', '/c/b', '/']);
  });

  it('settings: Esc goes back to the entry under it, a screen replaces it, a load replaces', async () => {
    stop = startRouter();
    openChat('a');
    useStore.setState({ settingsOpen: true });
    expect(here()).toBe('/settings');
    useStore.setState({ settingsOpen: false });
    await Promise.resolve();
    expect(here()).toBe('/c/a');
    expect(st().settingsOpen).toBe(false);
    useStore.setState({ settingsOpen: true });
    useStore.setState({ settingsOpen: false, screen: 'agents' });
    expect(urls()).toEqual(['/', '/c/a', '/agents']);
    // Back on /settings closes it.
    useStore.setState({ settingsOpen: true });
    history.back();
    await Promise.resolve();
    expect(st()).toMatchObject({ settingsOpen: false, screen: 'agents' });
    stop();
    useStore.setState(initial, true);
    load('/settings');
    stop = startRouter();
    expect(st().settingsOpen).toBe(true);
    useStore.setState({ settingsOpen: false });
    expect(urls()).toEqual(['/']);
  });

  it('a back step whose popstate never comes stops blocking the store after 300 ms', () => {
    vi.useFakeTimers();
    try {
      stop = startRouter();
      openChat('a');
      useStore.setState({ settingsOpen: true });
      const back = vi.spyOn(history, 'back').mockImplementation(() => {});
      useStore.setState({ settingsOpen: false });
      expect(back).toHaveBeenCalledOnce();
      openChat('b');
      expect(here()).toBe('/settings');
      vi.advanceTimersByTime(300);
      openChat('c');
      expect(here()).toBe('/c/c');
      back.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a chat created on / takes its entry; a deleted or missing open chat gives way to /', () => {
    stop = startRouter();
    st().apply({ type: 'chat.created', chat: chat('a') });
    expect(urls()).toEqual(['/c/a']);
    st().apply({ type: 'chat.deleted', chatId: 'a' });
    expect(urls()).toEqual(['/']);
    openChat('gone');
    st().apply({ type: 'error', code: 'not_found', message: 'x', chatId: 'gone' });
    expect(urls()).toEqual(['/', '/']);
    expect(st().activeChatId).toBeNull();
  });
});
