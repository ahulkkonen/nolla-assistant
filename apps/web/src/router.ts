import { useStore } from './store.ts';
import { openChat, runSearch } from './ws.ts';

type State = ReturnType<typeof useStore.getState>;
type Screen = State['screen'];

/**
 * Phase-23 decision 15: one path per store screen. A chat is `/c/<id>`, a search `/search?q=<q>`,
 * and Asetukset `/settings` over the current screen. The Files folder, the memory tab and the
 * panel stay state.
 */
const PATHS: Record<Screen, string> = {
  chat: '/',
  search: '/search',
  topics: '/topics',
  memory: '/memory',
  files: '/files',
  vault: '/vault',
  agents: '/agents',
  automations: '/automations',
  usage: '/usage',
  devices: '/devices',
};
const SCREENS = new Map(Object.entries(PATHS).map(([s, p]) => [p, s as Screen]));

export function pathOf(s: State): string {
  if (s.settingsOpen) return '/settings';
  if (s.screen === 'chat' && s.activeChatId) return `/c/${encodeURIComponent(s.activeChatId)}`;
  if (s.screen === 'search' && s.search) return `/search?q=${encodeURIComponent(s.search.q)}`;
  return PATHS[s.screen];
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** Set while `applyPath` changes the store: a back step never pushes. */
let applying = false;
/** A `history.back()` on its way: the store waits for its popstate. */
let backing = false;

/**
 * Sets the store from a URL (load, back, forward). What is already on screen is not opened
 * again. An unknown path, or a query the store drops, is replaced with `pathOf`.
 */
export function applyPath(url: string) {
  const { pathname, search, searchParams } = new URL(url, 'http://app');
  const st = useStore.getState();
  const chat = pathname.startsWith('/c/') ? decode(pathname.slice(3)) : null;
  const q = searchParams.get('q');
  applying = true;
  try {
    useStore.setState({ settingsOpen: pathname === '/settings' });
    if (pathname === '/settings') {
      // Over the current screen.
    } else if (chat && !chat.includes('/')) {
      if (chat !== st.activeChatId || st.screen !== 'chat') openChat(chat);
    } else if (pathname === '/search' && q) {
      if (q === st.search?.q) st.setScreen('search');
      else runSearch(q.slice(0, 500));
    } else if (pathname === '/search') {
      useStore.setState({ screen: 'search', search: null });
    } else {
      const screen = SCREENS.get(pathname);
      if (screen && screen !== 'chat') st.setScreen(screen);
      else st.setActive(null);
    }
  } finally {
    applying = false;
  }
  const path = pathOf(useStore.getState());
  if (path !== pathname + search) history.replaceState(null, '', path);
}

/**
 * Decision 17: a step that is no history entry of its own. The open chat that the server deleted
 * or did not find gives way to `/`; a chat created on `/` takes that entry.
 */
function replaces(s: State, prev: State) {
  const was = prev.activeChatId;
  const id = s.activeChatId;
  if (was && !id)
    return (
      (was in prev.messages && !(was in s.messages)) ||
      (!s.summaries[was] && !s.chats.some((c) => c.id === was))
    );
  return (
    !was &&
    !!id &&
    location.pathname === '/' &&
    !prev.chats.some((c) => c.id === id) &&
    s.chats.some((c) => c.id === id)
  );
}

/** Decision 16: the store is the source; a new pathname pushes, a new query only replaces. */
function follow(s: State, prev: State) {
  if (applying || backing) return;
  const path = pathOf(s);
  const here = location.pathname + location.search;
  if (path === here) return;
  if (prev.settingsOpen && !s.settingsOpen) {
    // Decision 18: back to the entry under `/settings` when the router pushed it.
    backing = history.state?.back === path;
    if (backing) history.back();
    else history.replaceState(null, '', path);
  } else if (path.split('?')[0] === location.pathname || replaces(s, prev)) {
    history.replaceState(null, '', path);
  } else {
    history.pushState(s.settingsOpen ? { back: here } : null, '', path);
  }
}

/**
 * Reads the path on load (the old `?chat=<id>` becomes `/c/<id>`), then keeps the URL and the
 * store in step; back and forward apply the path. Returns the stop function.
 */
export function startRouter() {
  // A back step of the last session (signed out while it was on its way) is not waited for.
  backing = false;
  const chat = new URLSearchParams(location.search).get('chat');
  if (chat) history.replaceState(null, '', `/c/${encodeURIComponent(chat)}`);
  applyPath(location.href);
  const onPop = () => {
    backing = false;
    applyPath(location.href);
  };
  window.addEventListener('popstate', onPop);
  const stop = useStore.subscribe(follow);
  return () => {
    stop();
    window.removeEventListener('popstate', onPop);
  };
}
