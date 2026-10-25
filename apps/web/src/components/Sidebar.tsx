import type { ChatSummary } from '@pa/protocol';
import { clsx } from 'clsx';
import {
  Archive,
  ArchiveRestore,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { firstUserLine, useStore } from '../store.ts';
import { send } from '../ws.ts';
import { IconButton } from './IconButton.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';

export const UNTITLED = 'Uusi keskustelu';

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
          className="h-9 w-full rounded-md border border-accent bg-bg px-2"
        />
      </li>
    );
  }

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
          'h-9 min-w-0 flex-1 truncate rounded-md px-2 text-left',
          active ? 'text-accent' : label ? 'text-fg' : 'text-fg-muted',
        )}
      >
        {label ?? UNTITLED}
      </button>
      <div className="absolute right-1 hidden rounded-md bg-bg-sunken group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
        <IconButton
          label={chat.pinned ? 'Irrota' : 'Kiinnitä'}
          className="size-8 max-md:size-11"
          onClick={() => send({ type: 'chat.pin', chatId: chat.id, pinned: !chat.pinned })}
        >
          {chat.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </IconButton>
        <IconButton
          label={chat.archived ? 'Palauta' : 'Arkistoi'}
          className="size-8 max-md:size-11"
          onClick={() => send({ type: 'chat.archive', chatId: chat.id, archived: !chat.archived })}
        >
          {chat.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        </IconButton>
        <IconButton label="Nimeä uudelleen" className="size-8 max-md:size-11" onClick={startEdit}>
          <Pencil size={16} />
        </IconButton>
      </div>
    </li>
  );
}

/** Full sidebar (280 px) when `expanded`, else the 56 px icon rail. */
export function Sidebar({ expanded, onNavigate }: { expanded: boolean; onNavigate?: () => void }) {
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const archivedView = useStore((s) => s.archivedView);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const messages = useStore((s) => s.messages);
  const vaultScreen = useStore((s) => s.screen === 'vault');
  const [query, setQuery] = useState('');

  const newChat = () => {
    useStore.getState().setActive(null);
    onNavigate?.();
  };
  const open = (chatId: string) => {
    useStore.getState().setActive(chatId);
    send({ type: 'chat.open', chatId });
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
        <div className="mt-auto pb-[max(env(safe-area-inset-bottom),8px)]">
          <SettingsDialog />
        </div>
      </nav>
    );
  }

  const q = query.trim().toLowerCase();
  const labelled = chats.map((c) => ({ chat: c, label: c.title ?? firstUserLine(messages[c.id]) }));
  const visible = q
    ? labelled.filter((r) => (r.label ?? UNTITLED).toLowerCase().includes(q))
    : labelled;

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
          className="flex h-9 flex-1 items-center gap-2 rounded-md px-2 font-medium hover:bg-bg-sunken"
        >
          <SquarePen size={20} />
          {UNTITLED}
        </button>
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
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hae"
          aria-label="Hae keskusteluja"
          className="h-9 w-full rounded-md border border-border bg-bg pr-2 pl-8 placeholder:text-fg-muted"
        />
      </div>
      {archivedView && <p className="px-4 py-1 text-secondary text-fg-muted">Arkistoidut</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {visible.map(({ chat, label }) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            label={label}
            active={chat.id === activeChatId && !vaultScreen}
            onOpen={() => open(chat.id)}
          />
        ))}
      </ul>
      <div className="flex items-center gap-1 border-t border-border p-2 pb-[max(env(safe-area-inset-bottom),8px)]">
        <button
          type="button"
          onClick={toggleArchived}
          aria-pressed={archivedView}
          className="mr-auto h-9 rounded-md px-2 text-secondary text-fg-muted hover:bg-bg-sunken hover:text-fg"
        >
          {archivedView ? 'Keskustelut' : 'Arkistoidut'}
        </button>
        <SettingsDialog {...(onNavigate ? { onNavigate } : {})} />
      </div>
    </nav>
  );
}
