import { clsx } from 'clsx';
import { Menu, SquarePen } from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';
import { useEffect, useSyncExternalStore } from 'react';
import { HttpError, me } from './api.ts';
import { AGENTS_TITLE, AgentsScreen } from './components/AgentsScreen.tsx';
import { AUTOMATIONS_TITLE, AutomationsScreen } from './components/AutomationsScreen.tsx';
import { Composer } from './components/Composer.tsx';
import { IconButton } from './components/IconButton.tsx';
import { Login } from './components/Login.tsx';
import { MEMORY_TITLE, MemoryScreen } from './components/MemoryScreen.tsx';
import { SEARCH_TITLE, SearchScreen } from './components/SearchScreen.tsx';
import { Sidebar, UNTITLED } from './components/Sidebar.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TOPICS_TITLE, TopicsScreen } from './components/TopicsScreen.tsx';
import { VAULT_TITLE, VaultScreen } from './components/VaultScreen.tsx';
import { firstUserLine, useStore } from './store.ts';
import { connect } from './ws.ts';

const mobileQuery = globalThis.matchMedia?.('(max-width: 767.98px)');
const useMobile = () =>
  useSyncExternalStore(
    (fn) => {
      mobileQuery?.addEventListener('change', fn);
      return () => mobileQuery?.removeEventListener('change', fn);
    },
    () => mobileQuery?.matches ?? false,
  );

const SCREEN_TITLE = {
  vault: VAULT_TITLE,
  search: SEARCH_TITLE,
  topics: TOPICS_TITLE,
  agents: AGENTS_TITLE,
  automations: AUTOMATIONS_TITLE,
  memory: MEMORY_TITLE,
};

function Shell() {
  const mobile = useMobile();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const screen = useStore((s) => s.screen);
  const title = useStore((s) => {
    if (s.screen === 'search' && s.search) return `Haku: ${s.search.q}`;
    if (s.screen !== 'chat') return SCREEN_TITLE[s.screen];
    const id = s.activeChatId;
    if (!id) return UNTITLED;
    return s.chats.find((c) => c.id === id)?.title ?? firstUserLine(s.messages[id]) ?? UNTITLED;
  });
  // Empty chat: the composer sits in the vertical centre until the first send.
  const empty = useStore((s) => {
    const id = s.activeChatId;
    return !id || (!s.messages[id]?.length && !s.streaming[id] && s.agentStatus[id] !== 'running');
  });

  return (
    <div className="flex h-dvh overflow-hidden">
      {mobile ? (
        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-fg/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
            <Dialog.Content className="fixed inset-y-0 left-0 z-50 max-w-xs data-[state=closed]:animate-slide-out data-[state=open]:animate-slide-in">
              <Dialog.Title className="sr-only">Keskustelut</Dialog.Title>
              <Dialog.Description className="sr-only">Keskustelulista</Dialog.Description>
              <Sidebar expanded onNavigate={() => setSidebarOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <div
          className={clsx(
            'shrink-0 overflow-hidden transition-[width] duration-(--duration) ease-out',
            sidebarOpen ? 'w-70' : 'w-14',
          )}
        >
          <Sidebar expanded={sidebarOpen} />
        </div>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {mobile && (
          <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
            <IconButton label="Valikko" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} />
            </IconButton>
            <h1 className="min-w-0 flex-1 truncate py-3 text-center font-medium">{title}</h1>
            <IconButton label={UNTITLED} onClick={() => useStore.getState().setActive(null)}>
              <SquarePen size={20} />
            </IconButton>
          </header>
        )}
        {screen === 'vault' && <VaultScreen />}
        {screen === 'search' && <SearchScreen />}
        {screen === 'topics' && <TopicsScreen />}
        {screen === 'agents' && <AgentsScreen />}
        {screen === 'automations' && <AutomationsScreen />}
        {screen === 'memory' && <MemoryScreen />}
        {/* Hidden, not unmounted, on the vault screen: the composer owns the global shortcuts. */}
        <div
          className={clsx(
            'flex min-h-0 flex-1 flex-col',
            screen !== 'chat' && 'hidden',
            empty && 'justify-end md:justify-center',
          )}
        >
          {!empty && <Thread />}
          <Composer />
        </div>
        <Toasts />
      </main>
    </div>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    me()
      .then(() => {
        useStore.getState().setAuth('in');
        connect();
      })
      .catch((err: unknown) => {
        useStore.getState().setAuth('out');
        if (!(err instanceof HttpError))
          useStore.getState().pushError('Palvelimeen ei saada yhteyttä.');
      });
  }, []);

  return (
    <Tooltip.Provider delayDuration={400}>
      {auth === 'in' ? <Shell /> : auth === 'out' ? <Login /> : null}
      {auth !== 'in' && <Toasts />}
    </Tooltip.Provider>
  );
}
