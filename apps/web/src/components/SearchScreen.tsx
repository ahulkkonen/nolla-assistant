import { useStore } from '../store.ts';
import { openChat } from '../ws.ts';
import { UNTITLED } from './Sidebar.tsx';

export const SEARCH_TITLE = 'Hakutulokset';

/** `**match**` markers from the server become `<mark>` in token colours. */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-bg-sunken text-fg underline underline-offset-2">
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
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
        <h1 className="font-semibold max-md:hidden">{SEARCH_TITLE}</h1>
        {!search?.results ? (
          <p className="text-fg-muted">Haetaan…</p>
        ) : !search.results.length ? (
          <p className="text-fg-muted">Ei osumia.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={`Haku: ${search.q}`}>
            {search.results.map((r) => (
              <li key={`${r.chatId}:${r.messageId ?? ''}`}>
                <button
                  type="button"
                  onClick={() => openChat(r.chatId, r.messageId)}
                  className="flex w-full flex-col gap-1 rounded-lg border border-border px-4 py-3 text-left hover:bg-bg-raised"
                >
                  <span className="font-medium">{r.title || UNTITLED}</span>
                  <span className="text-secondary text-fg-muted">
                    <Snippet text={r.snippet} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
