import { Command } from 'cmdk';
import {
  Bot,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Palette,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { firstUserLine, useStore } from '../store.ts';
import { openChat } from '../ws.ts';
import { SCREENS, THEMES } from './SettingsDialog.tsx';
import { UNTITLED } from './Sidebar.tsx';

type Page = 'root' | 'agents' | 'themes';

const item =
  'flex h-11 cursor-default items-center gap-3 rounded-md px-3 data-[selected=true]:bg-bg-sunken';
const group =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-secondary [&_[cmdk-group-heading]]:text-fg-muted';

function Item({
  icon,
  children,
  onSelect,
  keywords,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  keywords?: string[];
}) {
  return (
    <Command.Item className={item} onSelect={onSelect} {...(keywords ? { keywords } : {})}>
      <span className="text-fg-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Command.Item>
  );
}

/** Cmd/Ctrl+K: commands, chats and topics by fuzzy title. Every command also has a mouse path. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const chats = useStore((s) => s.chats);
  const messages = useStore((s) => s.messages);
  const topics = useStore((s) => s.topics);
  const agents = useStore((s) => s.agents);
  const [page, setPage] = useState<Page>('root');
  const [search, setSearch] = useState('');

  const close = () => {
    useStore.setState({ paletteOpen: false });
    setPage('root');
    setSearch('');
  };
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const go = (screen: Parameters<ReturnType<typeof useStore.getState>['setScreen']>[0]) =>
    run(() => useStore.getState().setScreen(screen));
  const sub = (p: Page) => () => {
    setPage(p);
    setSearch('');
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(o) => (o ? useStore.setState({ paletteOpen: true }) : close())}
      label="Komennot"
      overlayClassName="fixed inset-0 z-40 bg-fg/30"
      contentClassName="fixed inset-x-4 top-16 z-50 mx-auto max-w-xl overflow-hidden rounded-lg border border-border bg-bg-raised max-md:top-4"
      onKeyDown={(e) => {
        // Backspace on an empty field leaves a submenu.
        if (e.key === 'Backspace' && !search && page !== 'root') {
          e.preventDefault();
          setPage('root');
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search size={16} className="shrink-0 text-fg-muted" />
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder={
            page === 'agents'
              ? 'Valitse agentti'
              : page === 'themes'
                ? 'Valitse teema'
                : 'Hae komentoa tai keskustelua'
          }
          className="h-12 min-w-0 flex-1 bg-transparent placeholder:text-fg-muted focus-visible:outline-none"
        />
      </div>
      {/* Ends on a half row, so the list visibly continues. */}
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-2 text-fg-muted">Ei osumia.</Command.Empty>
        {page === 'agents' &&
          agents.map((a) => (
            <Item
              key={a.id}
              icon={<Bot size={16} />}
              onSelect={run(() => {
                const st = useStore.getState();
                st.setActive(null);
                st.setPendingAgentId(a.id);
              })}
            >
              {a.name}
            </Item>
          ))}
        {page === 'themes' &&
          THEMES.map(({ value, label, Icon }) => (
            <Item
              key={value}
              icon={<Icon size={16} />}
              onSelect={run(() => useStore.getState().setTheme(value))}
            >
              {label}
            </Item>
          ))}
        {page === 'root' && (
          <>
            <Command.Group heading="Komennot" className={group}>
              <Item
                icon={<SquarePen size={16} />}
                onSelect={run(() => useStore.getState().setActive(null))}
              >
                Uusi keskustelu
              </Item>
              <Item
                icon={<Search size={16} />}
                onSelect={run(() => {
                  const st = useStore.getState();
                  st.setScreen('chat');
                  st.setSidebarOpen(true);
                  requestAnimationFrame(() => document.getElementById('chat-search')?.focus());
                })}
              >
                Haku
              </Item>
              <Item icon={<Bot size={16} />} onSelect={sub('agents')} keywords={['agentti']}>
                <span className="flex items-center justify-between gap-2">
                  Vaihda agenttia <ChevronRight size={16} className="text-fg-muted" />
                </span>
              </Item>
              {SCREENS.map(([screen, Icon, label]) => (
                <Item key={screen} icon={<Icon size={16} />} onSelect={go(screen)}>
                  {label}
                </Item>
              ))}
              <Item
                icon={<Settings size={16} />}
                onSelect={run(() => useStore.setState({ settingsOpen: true }))}
              >
                Asetukset
              </Item>
              <Item icon={<Palette size={16} />} onSelect={sub('themes')} keywords={['teema']}>
                <span className="flex items-center justify-between gap-2">
                  Teema <ChevronRight size={16} className="text-fg-muted" />
                </span>
              </Item>
            </Command.Group>
            {chats.length > 0 && (
              <Command.Group heading="Keskustelut" className={group}>
                {chats.map((c) => (
                  <Item
                    key={c.id}
                    icon={<MessageSquare size={16} />}
                    onSelect={run(() => openChat(c.id))}
                  >
                    {c.title ?? firstUserLine(messages[c.id]) ?? UNTITLED}
                  </Item>
                ))}
              </Command.Group>
            )}
            {topics.length > 0 && (
              <Command.Group heading="Aiheet" className={group}>
                {topics.map((t) => (
                  <Item
                    key={t.id}
                    icon={<FolderOpen size={16} />}
                    keywords={['aihe']}
                    onSelect={run(() => {
                      // A topic opens its newest chat; the topics screen when it has none.
                      const newest = chats.find((c) => c.topicId === t.id);
                      if (newest) openChat(newest.id);
                      else useStore.getState().setScreen('topics');
                    })}
                  >
                    {t.name}
                  </Item>
                ))}
              </Command.Group>
            )}
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
