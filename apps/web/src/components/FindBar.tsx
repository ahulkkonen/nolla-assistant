import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';
import { announce } from './Thread.tsx';

/**
 * The hits of `q` in the message bodies under `root`: case-insensitive (`fi`), each inside one
 * text node (phase-13 decision 19). Collapsed tool and thinking rows are not in the DOM.
 */
export function findRanges(root: HTMLElement, q: string): Range[] {
  const needle = q.toLocaleLowerCase('fi');
  if (!needle) return [];
  const out: Range[] = [];
  for (const body of root.querySelectorAll(
    '[data-message-id] [data-find], [data-message-id] .md',
  )) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const hay = (node.nodeValue ?? '').toLocaleLowerCase('fi');
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, Math.min(i + needle.length, node.nodeValue?.length ?? 0));
        out.push(r);
      }
    }
  }
  return out;
}

const highlights = () => globalThis.CSS?.highlights;

/**
 * "Etsi keskustelusta" (phase-13 UI): Ctrl/Cmd+F in an open chat. The DOM does not change: the
 * hits are CSS custom highlights (`::highlight(find)`, tokens.css). Without them the bar still
 * counts and scrolls. `watch` changes when the thread does.
 */
export function FindBar({
  scroller,
  watch,
}: {
  scroller: RefObject<HTMLElement | null>;
  watch: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const findQuery = useStore((s) => s.findQuery);

  /** Opens (or, open, selects the query text); `query` replaces the text. */
  const show = (query?: string) => {
    if (!input.current) back.current = document.activeElement as HTMLElement | null;
    setOpen(true);
    if (query !== undefined) setQ(query);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  const close = () => {
    setOpen(false);
    setQ('');
    back.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f')
        return;
      const st = useStore.getState();
      // Only in an open chat, and never over a dialog or the palette.
      if (st.screen !== 'chat' || st.paletteOpen) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A global search hit opens its chat with the query here.
  useEffect(() => {
    if (findQuery === null) return;
    useStore.setState({ findQuery: null });
    show(findQuery);
  }, [findQuery]);

  // The hits again on each change of the query or the thread; a new query starts at the first.
  const last = useRef('');
  useEffect(() => {
    const root = scroller.current;
    const found = open && root ? findRanges(root, q) : [];
    setRanges(found);
    const fresh = q !== last.current;
    last.current = q;
    setAt((i) => (fresh || i >= found.length ? 0 : i));
    if (fresh && found[0]) center(found[0]);
  }, [open, q, watch]);

  useEffect(() => {
    const hl = highlights();
    if (!hl) return;
    hl.delete('find');
    hl.delete('find-current');
    const current = ranges[at];
    if (!open || !current) return;
    hl.set('find', new Highlight(...ranges));
    hl.set('find-current', new Highlight(current));
    return () => {
      hl.delete('find');
      hl.delete('find-current');
    };
  }, [open, ranges, at]);

  /** The hit to the centre of the thread, without a smooth scroll. */
  const center = (r: Range) => {
    const el = scroller.current;
    if (!el) return;
    const rect = r.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    el.scrollTop += rect.top - box.top - box.height / 2;
  };
  const go = (step: number) => {
    const n = ranges.length;
    if (!n) return;
    const next = (at + step + n) % n;
    setAt(next);
    const r = ranges[next];
    if (r) center(r);
    announce(`Osuma ${next + 1}/${n}`);
  };

  if (!open) return null;
  const n = ranges.length;
  return (
    <div
      role="search"
      className="sticky top-2 z-10 flex h-11 items-center gap-1 rounded-lg border bg-card pr-1 pl-3 shadow-sm max-md:-mx-2"
    >
      <Search size={16} className="shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            // Before the global Esc (it would stop a running reply).
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Etsi keskustelusta"
        aria-label="Etsi keskustelusta"
        className="h-full min-w-0 flex-1 bg-transparent text-body placeholder:text-muted-foreground focus-visible:outline-none max-md:text-[16px]"
      />
      {q && (
        <span className="px-1 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
          {n ? `${at + 1}/${n}` : 'Ei osumia'}
        </span>
      )}
      <IconButton label="Edellinen osuma" className="size-8" disabled={!n} onClick={() => go(-1)}>
        <ChevronUp size={16} />
      </IconButton>
      <IconButton label="Seuraava osuma" className="size-8" disabled={!n} onClick={() => go(1)}>
        <ChevronDown size={16} />
      </IconButton>
      <IconButton label="Sulje haku" className="size-8" onClick={close}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
