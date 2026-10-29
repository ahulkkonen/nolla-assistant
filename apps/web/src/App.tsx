import { Menu, SquarePen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { HttpError, me } from './api.ts';
import { AGENTS_TITLE, AgentsScreen } from './components/AgentsScreen.tsx';
import { ArtifactPanel } from './components/ArtifactPanel.tsx';
import { AUTOMATIONS_TITLE, AutomationsScreen } from './components/AutomationsScreen.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { Composer } from './components/Composer.tsx';
import { DEVICES_TITLE, DevicesScreen } from './components/DevicesScreen.tsx';
import { ExportAllDialog } from './components/ExportAllDialog.tsx';
import { ExportDialog } from './components/ExportDialog.tsx';
import { FILES_TITLE, FilesScreen } from './components/FilesScreen.tsx';
import { IconButton, Tip } from './components/IconButton.tsx';
import { Login } from './components/Login.tsx';
import { MEMORY_TITLE, MemoryScreen } from './components/MemoryScreen.tsx';
import { ChatCost } from './components/MessageMeta.tsx';
import { SEARCH_TITLE, SearchScreen } from './components/SearchScreen.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { ShortcutsDialog } from './components/ShortcutsDialog.tsx';
import { Sidebar, UNTITLED } from './components/Sidebar.tsx';
import { Thread } from './components/Thread.tsx';
import { TOPICS_TITLE, TopicsScreen } from './components/TopicsScreen.tsx';
import { USAGE_TITLE, UsageScreen } from './components/UsageScreen.tsx';
import { VAULT_TITLE, VaultScreen } from './components/VaultScreen.tsx';
import { useMedia, useMobile } from './media.ts';
import { resyncPush } from './push.ts';
import { startRouter } from './router.ts';
import { failedText, firstUserLine, shownArtifact, useStore } from './store.ts';
import { connect, openChat, reportFocus } from './ws.ts';

const SCREEN_TITLE = {
  vault: VAULT_TITLE,
  search: SEARCH_TITLE,
  topics: TOPICS_TITLE,
  agents: AGENTS_TITLE,
  automations: AUTOMATIONS_TITLE,
  memory: MEMORY_TITLE,
  files: FILES_TITLE,
  usage: USAGE_TITLE,
  devices: DEVICES_TITLE,
};

/**
 * The desktop header's title: the chat's title, or its first user line until it has one (an
 * empty new chat shows none); a tooltip when it is cut.
 */
function ChatTitle({ title }: { title: string }) {
  const titled = useStore((s) => {
    const id = s.activeChatId;
    return (
      !!id &&
      !!(
        s.chats.find((c) => c.id === id)?.title ??
        s.summaries[id]?.title ??
        s.messages[id]?.length
      )
    );
  });
  const [cut, setCut] = useState(false);
  if (!titled) return <h1 className="sr-only">{title}</h1>;
  return (
    <Tip label={title} {...(cut ? {} : { open: false })}>
      <h1
        onPointerEnter={(e) => setCut(e.currentTarget.scrollWidth > e.currentTarget.clientWidth)}
        className="min-w-0 flex-1 truncate text-ui font-medium"
      >
        {title}
      </h1>
    </Tip>
  );
}

/** "Näytä tiedot" of a failed model call (phase-22 decision 1): the provider's own message. */
function ErrorDetailDialog() {
  const failure = useStore((s) => s.errorDetail);
  // The text stays while the dialog fades out.
  const shown = useRef(failure);
  if (failure) shown.current = failure;
  const f = shown.current;
  return (
    <Dialog open={!!failure} onOpenChange={(o) => !o && useStore.setState({ errorDetail: null })}>
      <DialogContent showCloseButton={false} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{f && failedText(f)}</DialogTitle>
          <DialogDescription>Palveluntarjoajan vastaus:</DialogDescription>
        </DialogHeader>
        <pre
          translate="no"
          className="rounded-md bg-muted p-3 font-mono text-[13px]/5 whitespace-pre-wrap select-text [overflow-wrap:anywhere]"
        >
          {f?.detail}
        </pre>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Sulje</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `--background` of each scheme (tokens.css), for the browser chrome (brief 7.7). */
const THEME_COLOR = { light: '#faf9f5', dark: '#262624' } as const;
const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

/** Edge swipe (first 20 px) opens the drawer on phones (brief 7.7). */
function useEdgeSwipe(enabled: boolean, open: () => void) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && t.clientX <= 20 ? { x: t.clientX, y: t.clientY } : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      if (t.clientX - start.x > 48 && Math.abs(t.clientY - start.y) < 32) {
        start = null;
        open();
      }
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
    };
  }, [enabled, open]);
}

/** `--kb`: the height the on-screen keyboard covers; the shell lifts the composer by it. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = globalThis.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty('--kb', `${kb}px`);
      root.toggleAttribute('data-kb', kb > 0);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
}

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
  // Empty chat: the greeting and the composer sit at 40 % height until the first send.
  const empty = useStore((s) => {
    const id = s.activeChatId;
    return !id || (!s.messages[id]?.length && !s.streaming[id] && s.agentStatus[id] !== 'running');
  });
  // 768–1023 px: the rail stays and the sidebar opens over the content (brief 7.4).
  const overlay = useRef(globalThis.matchMedia?.('(max-width: 1023.98px)'));
  const drawer = mobile || !!overlay.current?.matches;
  // 1024–1279 px: the sidebar steps down to the rail while the side panel is open (brief 7.4).
  const wide = useMedia('(min-width: 1280px)');
  const panel = useStore((s) => !!shownArtifact(s) || (s.screen === 'files' && !!s.filePreview));
  const docked = sidebarOpen && !drawer && (wide || !panel);
  const openDrawer = useRef(() => setSidebarOpen(true)).current;
  useEdgeSwipe(mobile && !sidebarOpen, openDrawer);
  const swipe = useRef<number | null>(null);
  useKeyboardInset();

  // `?integrations=` from the Google callback; the router drops the query and reads the path.
  useEffect(() => {
    const integration = new URLSearchParams(location.search).get('integrations');
    if (integration === 'google') useStore.getState().notify('Google yhdistetty.');
    else if (integration) useStore.getState().pushError('Yhdistäminen epäonnistui.');
    const stopRouter = startRouter();
    // A notification click on an open window: the service worker posts the chat id.
    const onMessage = (e: MessageEvent<{ type?: string; chatId?: unknown }>) => {
      if (e.data?.type === 'open-chat' && typeof e.data.chatId === 'string')
        openChat(e.data.chatId);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    void resyncPush();
    return () => {
      stopRouter();
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, []);
  // The browser's history menu names each entry (phase-23 decision 19); signed out, no chat title.
  useEffect(() => {
    document.title = `${title} · Avustaja`;
    return () => {
      document.title = 'Avustaja';
    };
  }, [title]);

  // The server skips a push for the chat in the foreground.
  const focused = useStore((s) => (s.screen === 'chat' ? s.activeChatId : null));
  useEffect(() => {
    reportFocus();
  }, [focused]);
  useEffect(() => {
    const onHide = () => reportFocus(true);
    const onVisibility = () => reportFocus();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  return (
    <div className="relative flex h-dvh overflow-hidden px-[env(safe-area-inset-left)_env(safe-area-inset-right)] pb-(--kb)">
      {drawer && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            // Swipe left closes the drawer (brief 7.7).
            onTouchStart={(e) => {
              swipe.current = e.touches[0]?.clientX ?? null;
            }}
            onTouchMove={(e) => {
              const x = e.touches[0]?.clientX;
              if (swipe.current !== null && x !== undefined && swipe.current - x > 48) {
                swipe.current = null;
                setSidebarOpen(false);
              }
            }}
            className="w-[min(85vw,320px)] gap-0 border-sidebar-border bg-sidebar p-0 shadow-lg data-[side=left]:w-[min(85vw,320px)] data-[side=left]:sm:max-w-none"
          >
            <SheetTitle className="sr-only">Keskustelut</SheetTitle>
            <SheetDescription className="sr-only">Keskustelulista</SheetDescription>
            <Sidebar expanded drawer onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>
      )}
      {!mobile && (
        <div
          className={cn(
            'z-(--z-sidebar) shrink-0 overflow-hidden transition-[width] duration-200 ease-drawer',
            docked ? 'w-66' : 'w-14',
          )}
        >
          <Sidebar expanded={docked} />
        </div>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {mobile ? (
          <header className="z-(--z-header) box-content flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-1 pt-[env(safe-area-inset-top)]">
            <IconButton label="Valikko" onClick={() => setSidebarOpen(true)}>
              <Menu size={20} className="size-5" />
            </IconButton>
            <h1 className="min-w-0 flex-1 truncate text-center text-heading">{title}</h1>
            <IconButton label={UNTITLED} onClick={() => useStore.getState().setActive(null)}>
              <SquarePen size={20} className="size-5" />
            </IconButton>
          </header>
        ) : (
          screen === 'chat' && (
            // Desktop chat header (phase 16), also in a new chat (no shift on the first send): the
            // title and the chat's cost, on the thread column's edges (672, or the narrower column
            // beside the side panel); the bottom border meets the artifact panel's header.
            <header className="z-(--z-header) h-12 shrink-0 border-b border-border px-4">
              <div className="mx-auto flex h-full w-full max-w-(--thread-max) items-center gap-4">
                <ChatTitle title={title} />
                <ChatCost />
              </div>
            </header>
          )
        )}
        {screen === 'vault' && <VaultScreen />}
        {screen === 'search' && <SearchScreen />}
        {screen === 'topics' && <TopicsScreen />}
        {screen === 'agents' && <AgentsScreen />}
        {screen === 'automations' && <AutomationsScreen />}
        {screen === 'memory' && <MemoryScreen />}
        {screen === 'files' && <FilesScreen />}
        {screen === 'usage' && <UsageScreen />}
        {screen === 'devices' && <DevicesScreen />}
        {/* Hidden, not unmounted, on other screens: the composer owns the global shortcuts. */}
        <div className={cn('flex min-h-0 flex-1 flex-col', screen !== 'chat' && 'hidden')}>
          {empty ? (
            <>
              <div className="flex-[2]" />
              <h2 className="mx-auto mb-6 w-full max-w-(--thread-max) px-4 text-center font-serif text-display">
                Mitä tänään tehdään?
              </h2>
            </>
          ) : (
            <Thread />
          )}
          <Composer />
          {empty && <div className="flex-[3]" />}
        </div>
      </main>
      <ArtifactPanel />
      <SettingsDialog />
      <ShortcutsDialog />
      <CommandPalette />
      <ExportDialog />
      <ExportAllDialog />
      <ErrorDetailDialog />
    </div>
  );
}

export function App() {
  const auth = useStore((s) => s.auth);
  const theme = useStore((s) => s.theme);

  // data-theme overrides the OS; both theme-color metas then carry the active canvas.
  useEffect(() => {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    const sync = () => {
      if (theme === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.dataset.theme = theme;
      for (const m of metas) {
        const own = m.media.includes('dark') ? 'dark' : 'light';
        m.content = THEME_COLOR[theme === 'system' ? own : theme];
      }
    };
    // No transitions for the one frame of a theme switch (brief 7.6).
    const root = document.documentElement;
    root.classList.add('[&_*]:transition-none!');
    sync();
    requestAnimationFrame(() => root.classList.remove('[&_*]:transition-none!'));
    darkQuery?.addEventListener('change', sync);
    return () => darkQuery?.removeEventListener('change', sync);
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
    <TooltipProvider>
      {auth === 'in' ? <Shell /> : auth === 'out' ? <Login /> : null}
      <Toaster />
      {/* Screen-reader announcements (brief 7.8): stream start and end, tool status. */}
      <div id="live-polite" aria-live="polite" className="sr-only" />
      <div id="live-assertive" aria-live="assertive" className="sr-only" />
    </TooltipProvider>
  );
}
