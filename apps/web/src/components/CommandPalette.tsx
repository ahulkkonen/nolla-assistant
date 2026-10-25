import { Command } from 'cmdk';
import {
  Bot,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Palette,
  Repeat,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useMobile } from '../media.ts';
import { firstUserLine, useStore } from '../store.ts';
import { openChat } from '../ws.ts';
import { SCREENS, THEMES } from './SettingsDialog.tsx';
import { keys, UNTITLED } from './Sidebar.tsx';

type Page = 'root' | 'agents' | 'themes';

/** Items 40 h (44 on phones), radius 8, icon 16 + label + shortcut (brief 7.5). */
const item =
  'flex h-10 cursor-default items-center gap-3 rounded-md px-3 text-ui data-[selected=true]:bg-accent max-md:h-11';
const group =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-muted-foreground';

function Item({
  icon,
  children,
  onSelect,
  keywords,
  shortcut,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  keywords?: string[];
  shortcut?: string;
}) {
  return (
    <Command.Item className={item} onSelect={onSelect} {...(keywords ? { keywords } : {})}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && (
        <kbd className="rounded-xs border px-1.5 font-sans text-micro text-muted-foreground max-md:hidden">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

/**
 * The list ends on a whole row (brief 7.5): its height is the bottom of the last row that fits
 * under min(60dvh, 420px) (50dvh on phones).
 */
function useWholeRows(
  list: React.RefObject<HTMLDivElement | null>,
  mobile: boolean,
  deps: unknown[],
) {
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    el.style.maxHeight = '';
    const limit = Math.min(window.innerHeight * (mobile ? 0.5 : 0.6), mobile ? Infinity : 420);
    const pad = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
    const top = el.getBoundingClientRect().top;
    let fit = 0;
    let all = true;
    for (const row of el.querySelectorAll<HTMLElement>('[cmdk-item], [cmdk-group-heading]')) {
      const bottom = row.getBoundingClientRect().bottom - top + el.scrollTop;
      if (bottom + pad <= limit) fit = Math.max(fit, bottom);
      else all = false;
    }
    if (!all) el.style.maxHeight = `${fit + pad}px`;
  }, deps);
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
  const mobile = useMobile();
  const list = useRef<HTMLDivElement>(null);
  useWholeRows(list, mobile, [open, page, search, mobile, chats.length, topics.length]);

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
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? useStore.setState({ paletteOpen: true }) : close())}
    >
      {/* Brief 7.5: 560 wide, top at 15vh, radius 12, --shadow-md; phones inset 8. */}
      <DialogContent
        showCloseButton={false}
        className="top-[15vh] translate-y-0 gap-0 overflow-hidden rounded-lg p-0 shadow-md sm:max-w-[560px] max-md:top-2 max-md:left-2 max-md:w-[calc(100%-16px)] max-md:max-w-none max-md:translate-x-0"
      >
        <DialogTitle className="sr-only">Komennot</DialogTitle>
        <DialogDescription className="sr-only">Komennot, keskustelut ja aiheet</DialogDescription>
        <Command
          label="Komennot"
          onKeyDown={(e) => {
            // Backspace on an empty field leaves a submenu.
            if (e.key === 'Backspace' && !search && page !== 'root') {
              e.preventDefault();
              setPage('root');
            }
          }}
        >
          <div className="flex h-12 items-center gap-2 border-b px-4">
            <Search size={16} className="shrink-0 text-muted-foreground" />
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
              className="h-full min-w-0 flex-1 bg-transparent text-body placeholder:text-muted-foreground focus-visible:outline-none max-md:text-[16px]"
            />
          </div>
          <Command.List ref={list} className="relative overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-meta text-muted-foreground">
              Ei osumia.
            </Command.Empty>
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
                    shortcut={keys('O', true)}
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
                  <Item icon={<Repeat size={16} />} onSelect={sub('agents')} keywords={['agentti']}>
                    <span className="flex items-center justify-between gap-2">
                      Vaihda agenttia <ChevronRight size={16} className="text-muted-foreground" />
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
                      Teema <ChevronRight size={16} className="text-muted-foreground" />
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
          <p className="flex h-8 items-center border-t px-4 text-micro text-muted-foreground max-md:hidden">
            ↑↓ liiku · ↵ valitse · Esc sulje
          </p>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
