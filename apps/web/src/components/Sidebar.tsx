import type { ChatSummary } from '@pa/protocol';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Keyboard,
  Lightbulb,
  Lock,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { firstUserLine, useStore } from '../store.ts';
import { openChat, runSearch, send } from '../ws.ts';
import { type Action, ActionMenu, ActionRow } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { SKELETON_WIDTHS, useSlow } from './Page.tsx';
import { SettingsButton } from './SettingsDialog.tsx';

export const UNTITLED = 'Uusi keskustelu';

const COLLAPSED_KEY = 'pa.collapsedTopics';
function loadCollapsed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
/** A shortcut as the platform writes it: "⌘⇧O" on a Mac, "Ctrl+Shift+O" elsewhere. */
export const keys = (key: string, shift = false) =>
  mac ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;

/** Group label (brief 7.5): 12/16 500 muted, padding 16 12 4. */
const groupLabel = 'mx-2 flex items-center px-3 pt-4 pb-1 text-micro text-muted-foreground';

function ChatRow({
  chat,
  label,
  active,
  drawer,
  onOpen,
}: {
  chat: ChatSummary;
  label: string | undefined;
  active: boolean;
  drawer: boolean;
  onOpen: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  // Enter and the following blur must not both rename.
  const done = useRef(false);
  const press = useRef<ReturnType<typeof setTimeout>>(undefined);

  const startEdit = () => {
    done.current = false;
    setEditing(true);
  };
  const rename = (value: string) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const title = value.trim().slice(0, 120);
    if (title && title !== chat.title) send({ type: 'chat.rename', chatId: chat.id, title });
  };

  if (editing) {
    return (
      <li className="px-2">
        <Input
          autoFocus
          aria-label="Keskustelun nimi"
          defaultValue={chat.title ?? ''}
          maxLength={120}
          onBlur={(e) => rename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') rename(e.currentTarget.value);
            if (e.key === 'Escape') {
              e.preventDefault();
              done.current = true;
              setEditing(false);
            }
          }}
          className={cn('bg-card', drawer && 'h-11')}
        />
      </li>
    );
  }

  const pin: Action = {
    label: chat.pinned ? 'Irrota' : 'Kiinnitä',
    Icon: chat.pinned ? PinOff : Pin,
    run: () => send({ type: 'chat.pin', chatId: chat.id, pinned: !chat.pinned }),
  };
  const actions: Action[] = [
    pin,
    { label: 'Nimeä uudelleen', Icon: Pencil, run: startEdit },
    {
      label: chat.archived ? 'Palauta' : 'Arkistoi',
      Icon: chat.archived ? ArchiveRestore : Archive,
      run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
    },
    { label: 'Poista', Icon: Trash2, run: () => setConfirming(true) },
  ];
  const name = label ?? UNTITLED;

  return (
    <li
      className={cn(
        'group relative mx-2 flex items-center rounded-md hover:bg-sidebar-accent',
        active && 'bg-sidebar-accent',
      )}
      // Long-press on touch opens the row menu (brief 7.7).
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        press.current = setTimeout(() => setMenu(true), 500);
      }}
      onPointerUp={() => clearTimeout(press.current)}
      onPointerCancel={() => clearTimeout(press.current)}
      onPointerMove={() => clearTimeout(press.current)}
      onContextMenu={(e) => drawer && e.preventDefault()}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'h-9 min-w-0 flex-1 truncate rounded-md px-3 text-left text-ui text-sidebar-foreground',
          drawer ? 'h-11 pr-12' : 'group-focus-within:pr-16 group-hover:pr-16',
          active && 'font-medium',
          !label && !active && 'text-muted-foreground',
        )}
      >
        {name}
      </button>
      {chat.titleLocked && (
        <Tip label="Nimi lukittu">
          <span
            role="img"
            aria-label="Nimi lukittu"
            tabIndex={-1}
            className={cn('mr-3 text-muted-foreground', !drawer && 'group-hover:hidden')}
          >
            <Lock size={12} />
          </span>
        </Tip>
      )}
      {drawer ? (
        <div className="absolute right-1">
          <ActionMenu
            label={`Toiminnot: ${name}`}
            actions={actions}
            open={menu}
            onOpenChange={setMenu}
          />
        </div>
      ) : (
        // On hover or focus the row end turns into the pin toggle and the ⋯ menu.
        <div
          className={cn(
            'absolute right-1 hidden items-center group-focus-within:flex group-hover:flex',
            menu && 'flex',
          )}
        >
          <ActionRow actions={[pin]} small />
          <ActionMenu
            label={`Lisää: ${name}`}
            actions={actions.slice(1)}
            small
            open={menu}
            onOpenChange={setMenu}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Poistetaanko keskustelu ”${name}”?`}
        action="Poista"
        destructive
        onConfirm={() => send({ type: 'chat.delete', chatId: chat.id })}
        onClose={() => setConfirming(false)}
      >
        Keskustelu ja sen viestit poistetaan pysyvästi.
      </ConfirmDialog>
    </li>
  );
}

/**
 * The docked sidebar (264 px) when `expanded`, else the 56 px icon rail. `drawer`: the same
 * contents in the phone drawer (44 px rows, the row menu always visible).
 */
export function Sidebar({
  expanded,
  drawer = false,
  onNavigate,
}: {
  expanded: boolean;
  drawer?: boolean;
  onNavigate?: () => void;
}) {
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const archivedView = useStore((s) => s.archivedView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const messages = useStore((s) => s.messages);
  const chatScreen = useStore((s) => s.screen === 'chat');
  const topics = useStore((s) => s.topics);
  const proposals = useStore((s) => s.proposals.length);
  const topicsScreen = useStore((s) => s.screen === 'topics');
  const loaded = useStore((s) => s.chatsLoaded);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // Skeleton rows only after 300 ms of loading (brief 7.5).
  const slow = useSlow(!loaded);
  const searching = useStore((s) => s.screen === 'search');
  // The results page has its own field; two filled fields would read as two searches.
  useEffect(() => {
    if (searching) setQuery('');
  }, [searching]);

  const toggleTopic = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {}
  };
  const leaveSearch = () => {
    if (useStore.getState().screen === 'search') useStore.getState().setScreen('chat');
  };

  const newChat = () => {
    useStore.getState().setActive(null);
    onNavigate?.();
  };
  const open = (chatId: string) => {
    openChat(chatId);
    onNavigate?.();
  };
  const search = () => {
    setSidebarOpen(true);
    requestAnimationFrame(() => document.getElementById('chat-search')?.focus());
  };
  const toggleArchived = () => {
    useStore.getState().setArchivedView(!archivedView);
    send({ type: 'chat.list', archived: !archivedView });
  };
  const shortcuts = () => useStore.setState({ shortcutsOpen: true });

  if (!expanded) {
    // Rail (brief 7.5): 40 px icon buttons, 20 px icons, tooltips on the right.
    const rail = 'size-10';
    return (
      <nav
        aria-label="Keskustelut"
        className="flex h-full w-14 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar pt-2"
      >
        <IconButton
          label="Avaa sivupalkki"
          tipSide="right"
          className={rail}
          onClick={() => {
            // Already open: the side panel holds the sidebar at the rail (1024–1279 px); the
            // sidebar wins and the panel closes, so the thread keeps its 480 px.
            if (useStore.getState().sidebarOpen) useStore.setState({ openArtifact: null });
            setSidebarOpen(true);
          }}
        >
          <PanelLeft size={20} className="size-5" />
        </IconButton>
        <IconButton label={UNTITLED} tipSide="right" className={rail} onClick={newChat}>
          <SquarePen size={20} className="size-5" />
        </IconButton>
        <IconButton label="Hae keskusteluja" tipSide="right" className={rail} onClick={search}>
          <Search size={20} className="size-5" />
        </IconButton>
        <div className="mt-auto pb-[max(env(safe-area-inset-bottom),8px)]">
          <SettingsButton className={rail} tipSide="right" />
        </div>
      </nav>
    );
  }

  const q = query.trim().toLowerCase();
  const labelled = chats.map((c) => ({ chat: c, label: c.title ?? firstUserLine(messages[c.id]) }));
  const visible = q
    ? labelled.filter((r) => (r.label ?? UNTITLED).toLowerCase().includes(q))
    : labelled;
  // Pinned on top, then topic groups (by name), then chats without a known topic. `chats` is
  // already newest first, so every group keeps that order.
  const known = new Set(topics.map((t) => t.id));
  const pinned = visible.filter((r) => r.chat.pinned);
  const groups = [...topics]
    .sort((a, b) => a.name.localeCompare(b.name, 'fi'))
    .map((t) => ({ t, rows: visible.filter((r) => !r.chat.pinned && r.chat.topicId === t.id) }))
    .filter((g) => g.rows.length);
  const loose = visible.filter(
    (r) => !r.chat.pinned && !(r.chat.topicId && known.has(r.chat.topicId)),
  );
  const row = ({ chat, label }: (typeof visible)[number]) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      label={label}
      drawer={drawer}
      active={chat.id === activeChatId && chatScreen}
      onOpen={() => open(chat.id)}
    />
  );
  const rowH = drawer ? 'h-11' : 'h-9';

  return (
    <nav
      aria-label="Keskustelut"
      className={cn(
        'flex h-full w-66 flex-col bg-sidebar text-sidebar-foreground',
        drawer
          ? 'w-full pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)]'
          : 'border-r border-sidebar-border',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <Button
          variant="ghost"
          onClick={newChat}
          className={cn('flex-1 justify-start gap-2 px-3 hover:bg-sidebar-accent', rowH)}
        >
          <SquarePen size={16} />
          {UNTITLED}
        </Button>
        {drawer && (
          <IconButton label="Sulje" className="size-11" onClick={onNavigate}>
            <X size={20} className="size-5" />
          </IconButton>
        )}
        {/* The drawer (phones) has no keyboard to list shortcuts for. */}
        {!drawer && (
          <IconButton label="Pikanäppäimet" className="size-8" onClick={shortcuts}>
            <Keyboard size={16} />
          </IconButton>
        )}
        {!drawer && (
          <IconButton
            label="Sulje sivupalkki"
            className="size-8"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <PanelLeft size={16} />
          </IconButton>
        )}
      </div>
      <div className="relative mx-2 mb-2 shrink-0">
        <Search
          size={16}
          className="pointer-events-none absolute inset-y-0 left-3 my-auto text-muted-foreground"
        />
        <Input
          id="chat-search"
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value) leaveSearch();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              runSearch(query.trim().slice(0, 500));
              onNavigate?.();
            }
            if (e.key === 'Escape' && query) {
              // Clears the field without also closing the drawer.
              e.stopPropagation();
              setQuery('');
              leaveSearch();
            }
          }}
          placeholder="Hae"
          aria-label="Hae keskusteluja"
          className={cn('pl-9 [&::-webkit-search-cancel-button]:hidden', !drawer && 'pr-12')}
        />
        {!drawer && (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-2 my-auto flex h-5 items-center rounded-xs border border-border px-1.5 font-sans text-micro text-muted-foreground"
          >
            {keys('K')}
          </kbd>
        )}
      </div>
      {archivedView && <p className={groupLabel}>Arkistoidut</p>}
      {loaded && !chats.length && (
        <p className="mx-2 px-3 py-2 text-meta text-muted-foreground">
          {archivedView ? 'Ei arkistoituja keskusteluja' : 'Ei vielä keskusteluja'}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {slow &&
          SKELETON_WIDTHS.map((w) => (
            <li key={w} aria-hidden="true" className={cn('mx-2 flex items-center px-3', rowH)}>
              <Skeleton className="h-3" style={{ width: `${w}%` }} />
            </li>
          ))}
        {pinned.length > 0 && (
          <li>
            <h2 className={groupLabel}>Kiinnitetyt</h2>
            <ul>{pinned.map(row)}</ul>
          </li>
        )}
        {groups.map(({ t, rows }) => {
          // A search shows every match, so groups open while filtering.
          const isOpen = !!q || !collapsed.includes(t.id);
          return (
            <li key={t.id}>
              <h2 className="px-2 pt-3">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleTopic(t.id)}
                  className={cn(
                    'flex w-full items-center gap-1 rounded-md px-3 text-micro text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                    drawer ? 'h-11' : 'h-7',
                  )}
                >
                  <ChevronRight
                    size={16}
                    className={cn(
                      'shrink-0 transition-transform duration-150',
                      isOpen && 'rotate-90',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{t.name}</span>
                  <span className="tabular-nums">
                    {rows.length}
                    <span className="sr-only"> keskustelua</span>
                  </span>
                </button>
              </h2>
              {isOpen && <ul>{rows.map(row)}</ul>}
            </li>
          );
        })}
        {/* The label is its own item: rows stay direct items (`nav li` finds one row). */}
        {loose.length > 0 && (
          <li>
            <h2 className={groupLabel}>Viimeisimmät</h2>
          </li>
        )}
        {loose.map(row)}
        {proposals > 0 && (
          <li className="mx-2 mt-2">
            <button
              type="button"
              aria-current={topicsScreen ? 'page' : undefined}
              onClick={() => {
                useStore.getState().setScreen('topics');
                onNavigate?.();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 text-ui hover:bg-sidebar-accent',
                rowH,
                topicsScreen && 'bg-sidebar-accent font-medium',
              )}
            >
              <Lightbulb size={16} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left">Aihe-ehdotukset</span>
              <Badge className="tabular-nums">
                {proposals}
                <span className="sr-only"> uutta</span>
              </Badge>
            </button>
          </li>
        )}
      </ul>
      <div className="flex min-h-13 shrink-0 items-center gap-1 border-t border-sidebar-border px-2 pb-[env(safe-area-inset-bottom)]">
        <Button
          variant="ghost"
          onClick={toggleArchived}
          aria-pressed={archivedView}
          className={cn(
            'mr-auto gap-2 px-3 font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-foreground aria-pressed:bg-transparent',
            rowH,
          )}
        >
          <Archive size={16} />
          {archivedView ? 'Keskustelut' : 'Arkistoidut'}
        </Button>
        <SettingsButton className={drawer ? 'size-11' : 'size-8'} iconSize={16} />
      </div>
    </nav>
  );
}
