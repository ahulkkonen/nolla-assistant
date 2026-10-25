import { clsx } from 'clsx';
import { Menu, SquarePen } from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';
import { useEffect, useSyncExternalStore } from 'react';
import { HttpError, me } from './api.ts';
import { Composer } from './components/Composer.tsx';
import { IconButton } from './components/IconButton.tsx';
import { Login } from './components/Login.tsx';
import { Sidebar, UNTITLED } from './components/Sidebar.tsx';
import { Thread } from './components/Thread.tsx';
import { Toasts } from './components/Toasts.tsx';
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

function Shell() {
  const mobile = useMobile();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const title = useStore((s) => {
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
        <div
          className={clsx('flex min-h-0 flex-1 flex-col', empty && 'justify-end md:justify-center')}
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
