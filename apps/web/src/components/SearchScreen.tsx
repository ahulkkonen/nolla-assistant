import { ChevronRight, Search, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '../store.ts';
import { openChat, runSearch } from '../ws.ts';
import { EmptyState, ListSkeleton, Page } from './Page.tsx';
import { UNTITLED } from './Sidebar.tsx';

export const SEARCH_TITLE = 'Hakutulokset';

/** `**match**` markers become a `<mark>` (brief 7.5): never highlighted like a PII span. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[2px] bg-warning-subtle px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function SearchScreen() {
  const search = useStore((s) => s.search);
  const clear = () => {
    useStore.setState({ search: null });
    useStore.getState().setScreen('chat');
  };
  return (
    <Page title={SEARCH_TITLE}>
      <form
        role="search"
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          const q = String(new FormData(e.currentTarget).get('q') ?? '').trim();
          if (q) runSearch(q.slice(0, 500));
        }}
      >
        <Search
          size={16}
          className="pointer-events-none absolute inset-y-0 left-3 my-auto text-muted-foreground"
        />
        {/* Keyed by the query so a new search from the sidebar refills it. */}
        <Input
          key={search?.q}
          name="q"
          type="search"
          defaultValue={search?.q ?? ''}
          aria-label="Hakusanat"
          className="pl-9"
        />
      </form>
      <section className="flex flex-col">
        <ListSkeleton loading={!search?.results} rows={3} />
        {search?.results &&
          (!search.results.length ? (
            <EmptyState Icon={SearchX} title={`Ei tuloksia haulle ”${search.q}”`}>
              <Button variant="outline" onClick={clear}>
                Tyhjennä haku
              </Button>
            </EmptyState>
          ) : (
            <ul
              className="flex flex-col divide-y divide-border border-y"
              aria-label={`Haku: ${search.q}`}
            >
              {search.results.map((r) => (
                <li key={`${r.chatId}:${r.messageId ?? ''}`}>
                  <button
                    type="button"
                    onClick={() => openChat(r.chatId, r.messageId)}
                    className="flex min-h-14 w-full items-center gap-3 py-2 text-left transition-colors duration-100 hover:bg-accent/50"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{r.title || UNTITLED}</span>
                      <span className="line-clamp-2 text-meta text-muted-foreground">
                        <Snippet text={r.snippet} />
                      </span>
                    </span>
                    <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </section>
    </Page>
  );
}
