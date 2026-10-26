import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { announce } from '../announce.ts';
import { useStore } from '../store.ts';
import { findOffsets } from '../thread.ts';
import { IconButton } from './IconButton.tsx';

/**
 * The hits of `q` in the message bodies under `root`, each inside one text node (phase-13
 * decision 19). Open thinking text counts (`data-find`); collapsed rows are not in the DOM.
 */
export function findRanges(root: HTMLElement, q: string): Range[] {
  const out: Range[] = [];
  if (!q) return out;
  for (const body of root.querySelectorAll(
    '[data-message-id] [data-find], [data-message-id] .md',
  )) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const i of findOffsets(node.nodeValue ?? '', q)) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        out.push(r);
      }
    }
  }
  return out;
}

const highlights = () => globalThis.CSS?.highlights;
/** Typing waits this long before the thread is searched again; so do DOM changes. */
const SETTLE_MS = 150;

/**
 * "Etsi keskustelusta" (phase-13 UI): Ctrl/Cmd+F in an open chat. The DOM does not change: the
 * hits are CSS custom highlights (`::highlight(find)`, tokens.css). Without them the bar still
 * counts and scrolls. A changed thread (stream, "Mitä malli näki", an opened row) is searched
 * again through a MutationObserver.
 */
export function FindBar({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const findQuery = useStore((s) => s.findQuery);
  const chatId = useStore((s) => s.activeChatId);

  /** Opens (or, open, selects the query text); `text` replaces the query. */
  const show = (text?: string) => {
    if (!input.current) back.current = document.activeElement as HTMLElement | null;
    setOpen(true);
    if (text !== undefined) {
      setQ(text);
      setQuery(text);
    }
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  const close = (refocus = true) => {
    setOpen(false);
    setQ('');
    setQuery('');
    // Only to an element that is still on the page.
    if (refocus && back.current?.isConnected) back.current.focus();
    back.current = null;
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

  // Another chat: the bar closes and forgets its query.
  const shownChat = useRef(chatId);
  useEffect(() => {
    if (shownChat.current === chatId) return;
    shownChat.current = chatId;
    close(false);
  }, [chatId]);

  // A global search hit opens its chat with the query here.
  useEffect(() => {
    if (findQuery === null) return;
    useStore.setState({ findQuery: null });
    show(findQuery);
  }, [findQuery]);

  // Keystrokes settle before a search.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), SETTLE_MS);
    return () => clearTimeout(t);
  }, [q]);

  // The thread changes under an open bar: search again once it settles.
  useEffect(() => {
    const el = scroller.current;
    if (!open || !el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    // The bar's own counter and field are no thread change.
    const outside = (r: MutationRecord) =>
      !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest(
        '[role="search"]',
      );
    const mo = new MutationObserver((records) => {
      if (!records.some(outside)) return;
      clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), SETTLE_MS);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, [open, scroller]);

  // A new query starts at its first hit; a changed thread keeps the place.
  const searched = useRef('');
  useEffect(() => {
    const root = scroller.current;
    const found = open && root ? findRanges(root, query) : [];
    setRanges(found);
    const fresh = query !== searched.current;
    searched.current = query;
    setAt((i) => (fresh || i >= found.length ? 0 : i));
    if (fresh && found[0]) center(found[0]);
  }, [open, query, tick]);

  useEffect(() => {
    const hl = highlights();
    if (!hl) return;
    hl.delete('find');
    hl.delete('find-current');
    const current = ranges[at];
    if (!open || !current) return;
    const all = new Highlight();
    for (const r of ranges) all.add(r);
    hl.set('find', all);
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
      // Esc anywhere in the bar closes it, before the global Esc that stops a running reply.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      className="sticky top-2 z-10 flex h-11 items-center gap-1 rounded-lg border bg-card pr-1 pl-3 shadow-sm transition-colors duration-100 focus-within:border-input max-md:-mx-2"
    >
      <Search size={16} className="shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          // Enter right after typing searches first, then moves.
          if (q !== query) setQuery(q);
          else go(e.shiftKey ? -1 : 1);
        }}
        placeholder="Etsi keskustelusta"
        aria-label="Etsi keskustelusta"
        className="h-full min-w-0 flex-1 bg-transparent text-body placeholder:text-muted-foreground focus-visible:outline-none max-md:text-[16px]"
      />
      {query && (
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
      <IconButton label="Sulje haku" className="size-8" onClick={() => close()}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
