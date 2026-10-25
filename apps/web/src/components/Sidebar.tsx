import type { ChatSummary } from '@pa/protocol';
import { clsx } from 'clsx';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Keyboard,
  Lock,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { firstUserLine, useStore } from '../store.ts';
import { openChat, runSearch, send } from '../ws.ts';
import { type Action, ActionMenu, ActionRow } from './Actions.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { IconButton, Tip } from './IconButton.tsx';
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

function ChatRow({
  chat,
  label,
  active,
  onOpen,
}: {
  chat: ChatSummary;
  label: string | undefined;
  active: boolean;
  onOpen: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Enter and the following blur must not both rename.
  const done = useRef(false);

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
        <input
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
          className="h-9 w-full rounded-md border border-accent bg-bg px-2 max-md:h-11"
        />
      </li>
    );
  }

  const actions: Action[] = [
    {
      label: chat.pinned ? 'Irrota' : 'Kiinnitä',
      Icon: chat.pinned ? PinOff : Pin,
      run: () => send({ type: 'chat.pin', chatId: chat.id, pinned: !chat.pinned }),
    },
    {
      label: chat.archived ? 'Palauta' : 'Arkistoi',
      Icon: chat.archived ? ArchiveRestore : Archive,
      run: () => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived }),
    },
    { label: 'Nimeä uudelleen', Icon: Pencil, run: startEdit },
    { label: 'Poista', Icon: Trash2, run: () => setConfirming(true) },
  ];

  return (
    <li
      className={clsx(
        'group relative mx-2 flex items-center rounded-md hover:bg-bg-sunken',
        active && 'bg-bg-sunken',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'h-9 min-w-0 flex-1 truncate rounded-md px-2 text-left max-md:h-11 max-md:pr-12',
          active ? 'text-accent' : label ? 'text-fg' : 'text-fg-muted',
        )}
      >
        {label ?? UNTITLED}
      </button>
      {chat.titleLocked && (
        <Tip label="Nimi lukittu">
          <span role="img" aria-label="Nimi lukittu" tabIndex={-1} className="mr-2 text-fg-muted">
            <Lock size={12} />
          </span>
        </Tip>
      )}
      <div className="absolute right-1 hidden rounded-md bg-bg-sunken before:pointer-events-none before:absolute before:inset-y-0 before:-left-6 before:w-6 before:bg-linear-to-l before:from-bg-sunken group-focus-within:flex group-hover:flex max-md:flex max-md:bg-transparent max-md:before:hidden">
        {/* Desktop: the quick toggles as icons, rename and delete in the menu (room for the title). */}
        <div className="flex max-md:hidden">
          <ActionRow actions={actions.slice(0, 2)} small />
          <ActionMenu label={`Lisää: ${label ?? UNTITLED}`} actions={actions.slice(2)} small />
        </div>
        <div className="md:hidden">
          <ActionMenu label={`Toiminnot: ${label ?? UNTITLED}`} actions={actions} />
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Poistetaanko keskustelu?"
        action="Poista"
        onConfirm={() => send({ type: 'chat.delete', chatId: chat.id })}
        onClose={() => setConfirming(false)}
      >
        ”{label ?? UNTITLED}” ja sen viestit poistetaan pysyvästi.
      </ConfirmDialog>
    </li>
  );
}

const PaletteButton = () => (
  <IconButton label="Komennot (Ctrl+K)" onClick={() => useStore.setState({ paletteOpen: true })}>
    <Keyboard size={20} />
  </IconButton>
);

/** Full sidebar (280 px) when `expanded`, else the 56 px icon rail. */
export function Sidebar({ expanded, onNavigate }: { expanded: boolean; onNavigate?: () => void }) {
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const archivedView = useStore((s) => s.archivedView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const messages = useStore((s) => s.messages);
  const chatScreen = useStore((s) => s.screen === 'chat');
  const topics = useStore((s) => s.topics);
  const proposals = useStore((s) => s.proposals.length);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
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

  if (!expanded) {
    return (
      <nav className="flex h-full w-14 flex-col items-center gap-1 border-r border-border bg-bg-raised pt-2">
        <IconButton label="Avaa sivupalkki" onClick={() => setSidebarOpen(true)}>
          <PanelLeft size={20} />
        </IconButton>
        <IconButton label={UNTITLED} onClick={newChat}>
          <SquarePen size={20} />
        </IconButton>
        <IconButton label="Hae keskusteluja" onClick={search}>
          <Search size={20} />
        </IconButton>
        <PaletteButton />
        <div className="mt-auto pb-[max(env(safe-area-inset-bottom),8px)]">
          <SettingsButton />
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
      active={chat.id === activeChatId && chatScreen}
      onOpen={() => open(chat.id)}
    />
  );

  return (
    <nav
      className={clsx(
        'flex h-full w-70 flex-col border-r border-border bg-bg-raised pt-[env(safe-area-inset-top)]',
        onNavigate && 'pl-[env(safe-area-inset-left)]',
      )}
    >
      <div className="flex items-center gap-1 p-2">
        <button
          type="button"
          onClick={newChat}
          className="flex h-9 flex-1 items-center gap-2 rounded-md px-2 font-medium hover:bg-bg-sunken max-md:h-11"
        >
          <SquarePen size={20} />
          {UNTITLED}
        </button>
        {/* The drawer (phones) has no keyboard shortcut to advertise. */}
        {!onNavigate && <PaletteButton />}
        {!onNavigate && (
          <IconButton label="Sulje sivupalkki" onClick={() => setSidebarOpen(!sidebarOpen)}>
            <PanelLeft size={20} />
          </IconButton>
        )}
      </div>
      <div className="relative mx-2 mb-2">
        <Search
          size={16}
          className="pointer-events-none absolute inset-y-0 left-3 my-auto text-fg-muted"
        />
        <input
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
          className="h-9 w-full rounded-md border border-border bg-bg pr-2 pl-8 placeholder:text-fg-muted max-md:h-11"
        />
      </div>
      {archivedView && <p className="px-4 py-1 text-secondary text-fg-muted">Arkistoidut</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {pinned.length > 0 && (
          <li>
            <h3 className="flex h-9 items-center px-4 text-secondary text-fg-muted max-md:h-11">
              Kiinnitetyt
            </h3>
            <ul>{pinned.map(row)}</ul>
          </li>
        )}
        {groups.map(({ t, rows }) => {
          // A search shows every match, so groups open while filtering.
          const isOpen = !!q || !collapsed.includes(t.id);
          return (
            <li key={t.id}>
              <h3 className="px-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleTopic(t.id)}
                  className="flex h-9 w-full items-center gap-1 rounded-md px-2 text-secondary text-fg-muted hover:bg-bg-sunken hover:text-fg max-md:h-11"
                >
                  <ChevronRight
                    size={16}
                    className={clsx(
                      'shrink-0 transition-transform duration-(--duration)',
                      isOpen && 'rotate-90',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{t.name}</span>
                  <span className="tabular-nums">
                    {rows.length}
                    <span className="sr-only"> keskustelua</span>
                  </span>
                </button>
              </h3>
              {isOpen && <ul>{rows.map(row)}</ul>}
            </li>
          );
        })}
        {loose.map(row)}
        {proposals > 0 && (
          <li className="px-2 pt-2">
            <button
              type="button"
              onClick={() => {
                useStore.getState().setScreen('topics');
                onNavigate?.();
              }}
              className="flex h-9 w-full items-center rounded-md px-2 text-secondary text-fg-muted hover:bg-bg-sunken hover:text-fg max-md:h-11"
            >
              Aihe-ehdotuksia: {proposals}
            </button>
          </li>
        )}
      </ul>
      <div className="flex items-center gap-1 border-t border-border p-2 pb-[max(env(safe-area-inset-bottom),8px)]">
        <button
          type="button"
          onClick={toggleArchived}
          aria-pressed={archivedView}
          className="mr-auto h-9 rounded-md px-2 text-secondary text-fg-muted hover:bg-bg-sunken hover:text-fg max-md:h-11"
        >
          {archivedView ? 'Keskustelut' : 'Arkistoidut'}
        </button>
        <SettingsButton />
      </div>
    </nav>
  );
}
