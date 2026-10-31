import {
  type Annotation,
  type Artifact,
  type ArtifactKind,
  type AttachmentRef,
  artifactKind,
  artifactTitle,
  type CallUsage,
  CONFIDENCE_MARK,
  stripConfidence,
  type Versions,
} from '@pa/protocol';
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileText,
  LoaderCircle,
  PanelRight,
  Pencil,
  RotateCcw,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  type ComponentProps,
  createContext,
  isValidElement,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { touch } from '../media.ts';
import { type SubagentChild, type ToolView, useStore } from '../store.ts';
import {
  endsInFence,
  mdBlocks,
  nodeText,
  settleTail,
  type TextNode,
  withDefinitions,
} from '../thread.ts';
import { InlineFigure } from './Figure.tsx';
import { IconButton, Tip } from './IconButton.tsx';
import { MessageMeta, MetaLine } from './MessageMeta.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { ToolRow } from './ToolRow.tsx';

export function CopyButton({ text, className }: { text: () => string; className: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Kopioitu' : 'Kopioi'}
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text()).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={16} /> : <Copy size={16} />}
    </IconButton>
  );
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};

/**
 * The thread's code block (brief 7.5): --muted, radius 12, a 36 px header (language, Kopioi),
 * body 16, scrolls sideways. Any code, however long, stays code (phase-20 decision 11).
 */
export function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="overflow-hidden rounded-lg bg-muted">
      <div className="flex h-9 items-center gap-1 pr-1 pl-4 max-md:h-12">
        <span className="min-w-0 flex-1 truncate font-sans text-micro text-muted-foreground">
          {lang || 'koodi'}
        </span>
        <CopyButton text={() => ref.current?.textContent ?? ''} className="size-7" />
      </div>
      <pre
        ref={ref}
        translate="no"
        role="region"
        aria-label={lang ? `Koodi: ${lang}` : 'Koodi'}
        // A scrollable region must be focusable (brief 7.8).
        tabIndex={0}
        className="overflow-x-auto px-4 pb-4 font-mono"
      >
        {children}
      </pre>
    </div>
  );
}

/** The artifact card's frame (brief 7.5); a phone's 44 px button makes it 60 px high. */
const CARD = 'flex min-h-12 items-center gap-3 rounded-lg py-2 pr-2 pl-4 font-sans max-md:min-h-15';

/**
 * Phase-20 decision 8: a whitelisted block that is still being written shows its progress, never
 * its source: the kind, the title once it is known, and the line count.
 */
function WritingCard({ kind, source }: { kind: ArtifactKind; source: string }) {
  const lines = source ? source.replace(/\n$/, '').split('\n').length : 0;
  const title = artifactTitle(kind, source);
  return (
    <div aria-busy="true" className={cn(CARD, 'bg-muted')}>
      <LoaderCircle
        size={16}
        className="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      {/* One row on desktop (the title truncates first); on phones the meta is a second line. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 max-md:flex-col max-md:items-stretch max-md:gap-0">
        {title && <span className="min-w-0 truncate text-ui md:flex-1">{title}</span>}
        {/* The finished card's right padding ("Avattu"). */}
        <span
          className={cn(
            'truncate pr-2.5 text-meta text-muted-foreground',
            title ? 'md:shrink-0' : 'min-w-0 flex-1',
          )}
        >
          {CARD_NAME[kind]} · kirjoittaa… {lines} {lines === 1 ? 'rivi' : 'riviä'}
        </span>
      </div>
    </div>
  );
}

function Pre({ node, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const child = props.children;
  const className = isValidElement<{ className?: string; children?: unknown }>(child)
    ? (child.props.className ?? '')
    : '';
  const lang = /language-(\S+)/.exec(className)?.[1]?.toLowerCase() ?? '';
  // Decision 10: every text below the node; the caret and annotation spans are elements.
  const source = nodeText(node as TextNode | undefined);
  const art = artifactKind(lang);
  // The panel shows this block now (same source): the card says so.
  const shown = useStore((s) => {
    const o = s.openArtifact;
    const a = o && s.artifacts[o.chatId]?.find((x) => x.id === o.id);
    return !!art && !!a && a.content.trimEnd() === source.trimEnd();
  });
  if (!art) return <CodeBlock lang={lang}>{props.children}</CodeBlock>;
  if ((props as Record<string, unknown>)['data-streaming'])
    return <WritingCard kind={art} source={source} />;
  const a: Artifact = {
    id: `local-${hash(source)}`,
    kind: art,
    title: artifactTitle(art, source) ?? CARD_NAME[art],
    ...(lang ? { language: lang } : {}),
    content: source,
  };
  const open = () => {
    const st = useStore.getState();
    if (st.activeChatId) st.showArtifact(st.activeChatId, a);
  };
  // A chart or a diagram shows inline (phase-20 decision 3).
  if (art === 'vega-lite' || art === 'mermaid') return <InlineFigure a={a} onOpen={open} />;
  // A page or a component is a compact card in the thread; its code is in the panel's Koodi tab.
  return (
    <div className={cn(CARD, shown ? 'bg-accent' : 'bg-muted')}>
      <AppWindow size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-sans text-ui">{a.title}</span>
      {shown ? (
        <span className="flex h-8 items-center px-2.5 text-meta text-muted-foreground max-md:h-11">
          Avattu
        </span>
      ) : (
        <Button variant="outline" size="sm" onClick={open}>
          <PanelRight size={16} />
          Avaa paneelissa
        </Button>
      )}
    </div>
  );
}

/** A card's name when its source has no title. */
const CARD_NAME = {
  html: 'HTML-sivu',
  react: 'React-komponentti',
  mermaid: 'Kaavio',
  'vega-lite': 'Kuvaaja',
};

/** One message's own "what the model saw" switch; the global setting still wins. */
const SawContext = createContext(false);

/** A restored real value; the tooltip (or the global toggle) shows the surrogate the model saw. */
function Anno({ real, saw }: { real: string; saw: string }) {
  const local = useContext(SawContext);
  const show = useStore((s) => s.showModelSaw) || local;
  // Phase-28 decision 4: marks off, the real value is plain text with the hint as its title.
  const marks = useStore((s) => s.showPseudonyms) || show;
  const hint = show ? `Alkuperäinen: ${real}` : `Malli näki: ${saw}`;
  if (!marks) return <span title={hint}>{real}</span>;
  const span = (
    <span
      tabIndex={0}
      // On touch it is the trigger of the hint: a button for assistive technology.
      {...(touch ? { role: 'button' } : {})}
      aria-description={hint}
      className="rounded-xs bg-mask px-0.5 underline decoration-mask-line decoration-dotted decoration-1 underline-offset-3 [box-decoration-break:clone]"
    >
      {show ? saw : real}
    </span>
  );
  if (!touch) return <Tip label={hint}>{span}</Tip>;
  // Touch screens have no hover: a tap toggles the hint.
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{span}</Popover.Trigger>
      <Popover.Portal>
        {/* Above the span with an arrow, as the desktop tooltip: the next line stays visible. */}
        <Popover.Content
          aria-label={hint}
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 rounded-sm bg-primary px-2 py-1 text-micro text-primary-foreground"
        >
          {hint}
          <Popover.Arrow className="fill-primary" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Span({ node: _, ...props }: ComponentProps<'span'> & ExtraProps) {
  const saw = (props as Record<string, unknown>)['data-model-saw'];
  return typeof saw === 'string' ? (
    <Anno real={String(props.children)} saw={saw} />
  ) : (
    <span {...props} />
  );
}

/** Plain text with annotated ranges (offsets into `text`). */
export function annotate(text: string, annotations: Annotation[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const a of [...annotations].sort((x, y) => x.start - y.start)) {
    if (a.start < at || a.end > text.length) continue;
    out.push(
      text.slice(at, a.start),
      <Anno key={a.start} real={text.slice(a.start, a.end)} saw={a.modelSaw} />,
    );
    at = a.end;
  }
  out.push(text.slice(at));
  return out;
}

type HNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
};

/**
 * Rehype plugin: wraps each occurrence of an annotated real value in a `data-model-saw` span.
 * Markdown parsing loses source offsets, so it matches the text, longest first.
 */
const rehypeAnnotate = (pairs: [string, string][]) => () => (tree: HNode) => {
  const split = (value: string): HNode[] => {
    const out: HNode[] = [];
    let at = 0;
    for (let i = 0; i < value.length; ) {
      const p = pairs.find(([real]) => value.startsWith(real, i));
      if (!p) {
        i++;
        continue;
      }
      if (i > at) out.push({ type: 'text', value: value.slice(at, i) });
      out.push({
        type: 'element',
        tagName: 'span',
        properties: { dataModelSaw: p[1] },
        children: [{ type: 'text', value: p[0] }],
      });
      at = i += p[0].length;
    }
    if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
    return out;
  };
  const walk = (n: HNode) => {
    if (!n.children) return;
    n.children = n.children.flatMap((c) => {
      if (c.type === 'text') return split(c.value ?? '');
      walk(c);
      return [c];
    });
  };
  walk(tree);
};

const MARKS = new RegExp(CONFIDENCE_MARK, 'g');
/** Phase-28 decision 3: a sentence with N up to this is underlined and shows its N. */
const CONF_LOW = 6;

/**
 * Rehype plugin (phase-21 decision 4, phase-28 decision 3): each confidence marker `⟦N⟧` goes, and
 * the text before it (from the previous marker or the start of the text node) gets a span `conf`,
 * plus `conf-low` for N up to CONF_LOW (a dotted underline, the N always visible), and its N as a
 * last child `sup.conf-n` in a zero-width anchor `span.conf-a`, which CSS shows on hover, on a tap
 * or with "Näytä luvut" (phase-23 decision 9). Code stays as written. An unterminated marker at the
 * end of the last text node (a reply still streaming) is hidden.
 */
export const rehypeConfidence = () => (tree: HNode) => {
  let last: HNode | undefined;
  for (let n: HNode | undefined = tree; n; n = n.children?.at(-1)) if (n.type === 'text') last = n;
  if (last?.value) last.value = last.value.replace(/⟦[1-9]?$/, '');
  const split = (value: string): HNode[] => {
    const out: HNode[] = [];
    let at = 0;
    for (const m of value.matchAll(MARKS)) {
      const n = Number(m[1]);
      if (m.index > at)
        out.push({
          type: 'element',
          tagName: 'span',
          properties: {
            className: n <= CONF_LOW ? ['conf', 'conf-low'] : ['conf'],
            title: `Luottamus ${n}/9`,
          },
          children: [
            { type: 'text', value: value.slice(at, m.index) },
            {
              type: 'element',
              tagName: 'span',
              properties: { className: ['conf-a'] },
              children: [
                {
                  type: 'element',
                  tagName: 'sup',
                  properties: { className: ['conf-n'] },
                  children: [{ type: 'text', value: String(n) }],
                },
              ],
            },
          ],
        });
      at = m.index + m[0].length;
    }
    if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
    return out;
  };
  const walk = (n: HNode) => {
    if (!n.children || n.tagName === 'code') return;
    n.children = n.children.flatMap((c) => {
      if (c.type === 'text') return split(c.value ?? '');
      walk(c);
      return [c];
    });
  };
  walk(tree);
};

/**
 * Rehype plugin: the streaming caret right after the last visible character (brief 7.5; phase
 * 27). Whitespace-only text (the "\n" between list items and table rows) does not count, and the
 * newline at the end of a code block stays after the caret, so the caret never takes a line of
 * its own. An empty code block at the end takes it in its `code`; an empty tree at its end.
 */
export const rehypeCaret = () => (tree: HNode) => {
  let at: { parent: HNode; i?: number } = { parent: tree };
  const walk = (n: HNode) => {
    const code = n.tagName === 'pre' && n.children?.find((c) => c.tagName === 'code');
    if (code) at = { parent: code };
    n.children?.forEach((c, i) => {
      if (c.type === 'text' && /\S/.test(c.value ?? '')) at = { parent: n, i };
      else walk(c);
    });
  };
  walk(tree);
  const caret = {
    type: 'element',
    tagName: 'span',
    properties: { className: ['caret'], ariaHidden: 'true' },
    children: [],
  };
  const kids = (at.parent.children ??= []);
  if (at.i === undefined) return void kids.push(caret);
  const value = kids[at.i]?.value ?? '';
  const end = value.trimEnd().length;
  const rest = value.slice(end);
  kids.splice(
    at.i,
    1,
    { type: 'text', value: value.slice(0, end) },
    caret,
    ...(rest ? [{ type: 'text', value: rest }] : []),
  );
};

/** Rehype plugin: the live tail ends inside a fence; its block is the last `pre` (decision 8). */
const rehypeOpenFence = () => (tree: HNode) => {
  let last: HNode | undefined;
  const walk = (n: HNode) => {
    for (const c of n.children ?? []) {
      if (c.tagName === 'pre') last = c;
      walk(c);
    }
  };
  walk(tree);
  if (last) last.properties = { ...last.properties, dataStreaming: 'true' };
};

/**
 * Touch (phase-23 decision 9): a tap on a marked sentence shows or hides its N; one handler on the
 * Markdown root, so a sentence is no tab stop. A tap on a link or a masked name is theirs.
 */
const toggleN = (e: ReactMouseEvent) => {
  const el = e.target as Element;
  if (!el.closest('a, button, [role="button"]')) el.closest('.conf')?.toggleAttribute('data-show');
};

/**
 * Phase-23 decision 9: the scale under a reply with markers (micro, muted; phase 28: words only, the
 * swatches went with the shading) and "Näytä luvut", which puts every N in the text (`pa.confN`). One 28 px row; phones: "Luottamus" and the scale, then
 * the button (UI review 3). The button's 44 px target reaches 8 px past its 28 px pill, so the gaps
 * stay 8 px.
 */
function ConfidenceLegend() {
  const on = useStore((s) => s.showConfN);
  return (
    <div className="flex h-7 items-center gap-3 text-micro text-muted-foreground max-md:h-auto max-md:flex-wrap max-md:gap-y-2">
      <span>Luottamus</span>
      <span className="flex items-center gap-2 tabular-nums">
        <span>1 arvaus</span>
        <span aria-hidden="true">–</span>
        <span>9 varma</span>
      </span>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => useStore.getState().setShowConfN(!on)}
        // A 28 px pill with a border; on: the fill and a 12 px check before the text (the brief's
        // segmented control). An invisible checked copy shares the grid cell, so the pill keeps
        // its width in both states. The 44 px target is `::after`.
        className="relative grid h-7 items-center rounded-full border border-border px-2.5 text-foreground transition-colors duration-100 after:absolute after:inset-x-0 after:-inset-y-2 hover:bg-accent aria-pressed:bg-accent"
      >
        <span aria-hidden="true" className="invisible col-start-1 row-start-1 flex gap-1">
          <Check size={12} />
          Näytä luvut
        </span>
        <span className="col-start-1 row-start-1 flex items-center justify-center gap-1">
          {on && <Check size={12} className="shrink-0" />}
          Näytä luvut
        </span>
      </button>
    </div>
  );
}

const components = { pre: Pre, span: Span };
const plugins = [remarkGfm];
const NONE: Annotation[] = [];

/** One Markdown block; a finished block keeps its text and plugins, so it never re-renders. */
const Block = memo(function Block({
  text,
  rehype,
}: {
  text: string;
  rehype: Options['rehypePlugins'];
}) {
  return (
    <Markdown remarkPlugins={plugins} rehypePlugins={rehype} components={components}>
      {text}
    </Markdown>
  );
});

export const MarkdownText = memo(function MarkdownText({
  text,
  annotations = NONE,
  live = false,
}: {
  text: string;
  annotations?: Annotation[];
  live?: boolean;
}) {
  const key = JSON.stringify(
    annotations
      .map((a): [string, string] => [text.slice(a.start, a.end), a.modelSaw])
      .filter(([real]) => real)
      .sort((x, y) => y[0].length - x[0].length),
  );
  // Blocks render as siblings in one `.md`, so the DOM is the same as one parse would give.
  const { blocks, definitions } = mdBlocks(text, !live);
  if (live) {
    // A tail held back whole: the caret stays on the block before it.
    const tail = settleTail(blocks.at(-1) ?? '');
    if (tail) blocks[blocks.length - 1] = tail;
    else blocks.pop();
  }
  const open = live && endsInFence(blocks.at(-1) ?? '');
  // The base plugins depend on the annotations only: finished blocks keep the same array.
  // Confidence first: an annotated name inside a marked sentence keeps the sentence's colour.
  const rehype = useMemo(() => {
    const pairs = JSON.parse(key) as [string, string][];
    return [rehypeConfidence, ...(pairs.length ? [rehypeAnnotate(pairs)] : [])];
  }, [key]);
  const rehypeLast = useMemo(
    () => (live ? [...rehype, ...(open ? [rehypeOpenFence] : []), rehypeCaret] : rehype),
    [rehype, live, open],
  );
  const confN = useStore((s) => s.showConfN);
  // Phase 27: new text flips it, which restarts the caret's wait before it breathes (tokens.css).
  // A ref, not state: one render per change.
  const tick = useRef({ text, n: 0 });
  if (tick.current.text !== text) tick.current = { text, n: tick.current.n ^ 1 };
  return (
    <div
      className="md break-words"
      data-tick={live ? tick.current.n : undefined}
      {...(confN ? { 'data-conf-n': '' } : {})}
      {...(touch ? { onClick: toggleN } : {})}
    >
      {blocks.map((b, i) => (
        <Block
          key={i}
          text={withDefinitions(b, definitions)}
          rehype={i === blocks.length - 1 ? rehypeLast : rehype}
        />
      ))}
    </div>
  );
});

function Attachment({ a }: { a: AttachmentRef }) {
  const src = `/api/files/${encodeURIComponent(a.id)}`;
  return a.kind === 'image' ? (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt={a.name} className="h-32 rounded-lg border border-border object-cover" />
    </a>
  ) : (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="flex h-10 max-w-60 items-center gap-2 rounded-md border border-border pr-3 pl-1 text-meta"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xs bg-muted">
        <FileText size={16} className="text-muted-foreground" />
      </span>
      <span className="truncate">{a.name}</span>
    </a>
  );
}

type Props = {
  /** Message id: ↑ in an empty composer opens this message in edit mode. */
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  annotations?: Annotation[];
  attachments?: AttachmentRef[];
  tools?: ToolView[];
  /**
   * Still streaming: the chat whose stream gives the text and the caret; the action row is only
   * reserved. Phase 27: this view reads the stream itself, so the thread does not render per delta.
   */
  live?: string | undefined;
  /** While live, keep the empty action row (default); off when an approval card follows. */
  reserve?: boolean;
  /** Rendered after the text and before the action row, at the 8 px in-turn gap. */
  footer?: ReactNode;
  /** The latest turn of its role: its actions show without hover (brief 7.5). */
  latest?: boolean;
  /** Live children of a `subagent` call: that tool's row becomes the subagent row. */
  subagents?: SubagentChild[];
  /** User message: "Lähetä" makes the edited text a new version in this chat (phase 24). */
  onEdit?: (text: string) => void;
  /** User message: "Haarauta" starts a new chat from the edited text (phase 13). */
  onFork?: (text: string) => void;
  /** An edit or a fork is on its way: both wait for its answer. */
  busy?: boolean;
  /** False while the message has no entry id yet: the edit box asks for a reopen. */
  canSend?: boolean;
  /** Asks the server for the chat's entry ids (an edit of a message without one). */
  onNeedIds?: () => void;
  /** User message with versions: the switcher, first in its action row, which then always shows. */
  switcher?: ReactNode;
  /** The thinking row, above the tool rows and the text (phase 13). */
  thinking?: ReactNode;
  /** The action row meta: the time, and a reply's cost and tokens (phase 13). */
  meta?: { createdAt: string; usage?: CallUsage | undefined };
  /** Phase 26, while live: the waiting line in the first line until the text takes its place. */
  waiting?: ReactNode;
  /**
   * Phase 26: at the action row's end, the live line from the first token on, then the receipt.
   * Phones keep the receipt in the long-press sheet: the row has no room beside the meta.
   */
  receipt?: ReactNode;
  /**
   * Assistant message: sends the previous user message again as a new turn. A failed turn has no
   * message here; the thread's alert retries it in place (`user.retry`).
   */
  onRetry?: () => void;
};

// 32 px icons in the action row; 44 px touch targets on phones.
const small = 'size-8';

/**
 * Phase-24 decision 10: "‹ 1/2 ›". The ends and a running reply (`wait`) disable the buttons;
 * `busy` while the switch is on its way.
 */
export function VersionSwitcher({
  versions: { index, count },
  wait,
  busy,
  onPick,
}: {
  versions: Versions;
  wait: boolean;
  busy: boolean;
  onPick: (index: number) => void;
}) {
  const step = (to: number, label: string, icon: ReactNode) => (
    <IconButton
      label={label}
      tip={wait ? 'Odota, että vastaus valmistuu' : undefined}
      className={small}
      // `aria-disabled`, not `disabled`: focus stays on the button at the end, the tooltip works.
      {...(wait || to < 1 || to > count
        ? { 'aria-disabled': true }
        : { onClick: () => onPick(to) })}
    >
      {icon}
    </IconButton>
  );
  return (
    <div
      role="group"
      aria-label={`Versio ${index}/${count}`}
      aria-busy={busy || undefined}
      className="flex items-center gap-1 max-md:gap-2"
    >
      {step(index - 1, 'Edellinen versio', <ChevronLeft size={16} />)}
      <span aria-hidden="true" className="text-meta text-muted-foreground tabular-nums">
        {index}/{count}
      </span>
      {step(index + 1, 'Seuraava versio', <ChevronRight size={16} />)}
    </div>
  );
}

function EditBox({
  text,
  busy,
  canSend,
  onSend,
  onFork,
  onCancel,
}: {
  text: string;
  busy: boolean;
  canSend: boolean;
  onSend: (t: string) => void;
  onFork: (t: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
  const ready = !!value.trim() && !busy && canSend;
  const hint = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  // Grows with its text (wrapped lines too) up to 320 px, then scrolls; the border is outside
  // `scrollHeight`.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
  return (
    <div className="flex w-full max-w-[80%] flex-col gap-2 max-md:max-w-full">
      <Textarea
        ref={area}
        autoFocus
        aria-label="Muokattava viesti"
        value={value}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // The edit only: the global Esc must not also stop a run. While the edit or the fork
            // is on its way, the box stays.
            e.preventDefault();
            if (!busy) onCancel();
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
            e.stopPropagation();
            onSend(value.trim());
          }
        }}
        aria-describedby={`${hint}`}
        className="field-sizing-fixed max-h-80 resize-none rounded-xl px-4"
      />
      <p id={hint} className="text-meta text-pretty text-muted-foreground">
        {canSend
          ? 'Lähetä tekee viestistä uuden version tähän keskusteluun. Haarauta aloittaa uuden keskustelun.'
          : 'Avaa keskustelu uudelleen, niin voit muokata tätä viestiä.'}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Peruuta
        </Button>
        <Button variant="outline" disabled={!ready} onClick={() => onFork(value.trim())}>
          Haarauta
        </Button>
        <Button disabled={!ready} onClick={() => onSend(value.trim())}>
          Lähetä
        </Button>
      </div>
    </div>
  );
}

export function MessageView({
  id,
  role,
  text: given,
  annotations: givenAnnotations = NONE,
  attachments = [],
  tools = [],
  live,
  reserve = true,
  footer,
  latest,
  subagents = [],
  onEdit,
  onFork,
  busy = false,
  canSend = true,
  onNeedIds,
  switcher,
  thinking,
  meta,
  waiting,
  receipt,
  onRetry,
}: Props) {
  const streamed = useStore((s) => (live ? s.streaming[live] : undefined));
  const text = live ? (streamed?.text ?? '') : given;
  const annotations = live ? (streamed?.annotations ?? NONE) : givenAnnotations;
  const fx = useStore((s) => s.fx);
  const user = role === 'user';
  const [saw, setSaw] = useState(false);
  const globalSaw = useStore((s) => s.showModelSaw);
  const pressed = saw || globalSaw;
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editRequested = useStore((s) => !!id && s.editMessageId === id);
  useEffect(() => {
    if (!editRequested) return;
    setEditing(true);
    useStore.setState({ editMessageId: null });
  }, [editRequested]);

  // An edit of a message without its entry id: the chat's ids come first (`chat.open`).
  useEffect(() => {
    if (editing && !canSend) onNeedIds?.();
  }, [editing]);

  const copy = () => void navigator.clipboard.writeText(stripConfidence(text));
  const actions = !live && !editing && text;
  return (
    <SawContext.Provider value={saw}>
      <div
        className={cn('group relative flex flex-col gap-2', user && 'items-end')}
        // Long-press 500 ms on touch opens the action sheet (brief 7.7).
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch' || !actions) return;
          press.current = setTimeout(() => setSheet(true), 500);
        }}
        onPointerUp={() => clearTimeout(press.current)}
        onPointerCancel={() => clearTimeout(press.current)}
        onPointerMove={() => clearTimeout(press.current)}
      >
        {thinking}
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {attachments.map((a) => (
              <Attachment key={a.id} a={a} />
            ))}
          </div>
        )}
        {tools.length > 0 && (
          <div className="flex flex-col gap-1">
            {tools.map((t) =>
              t.name === 'subagent' && subagents.length ? (
                <SubagentRow key={t.callId} items={subagents} />
              ) : (
                <ToolRow key={t.callId} tool={t} />
              ),
            )}
          </div>
        )}
        {user && editing && onEdit && onFork ? (
          // Stays open while the edit or the fork is on its way: a failure keeps the text.
          <EditBox
            text={text}
            busy={busy}
            canSend={canSend}
            onCancel={() => setEditing(false)}
            onSend={onEdit}
            onFork={onFork}
          />
        ) : user ? (
          text && (
            <div
              data-find
              className="max-w-[80%] rounded-xl bg-secondary px-4 py-2.5 text-body text-pretty whitespace-pre-wrap text-secondary-foreground hyphens-auto [overflow-wrap:anywhere] max-md:max-w-[85%]"
            >
              {annotate(text, annotations)}
            </div>
          )
        ) : (
          // Phase 26: while live, the waiting line holds the first line (one line of prose: 28 px,
          // 26 on phones); the first token fades in at its place while the line fades out, so
          // nothing moves. Phase 27: one tree for the live and the final reply: the final swaps
          // the text in place.
          (text || (live && waiting)) && (
            <div className="relative min-h-(--text-prose--line-height)">
              {text && (
                <div className={cn(live && 'animate-fade-in')}>
                  <MarkdownText text={text} annotations={annotations} live={!!live} />
                </div>
              )}
              {live && (
                <div
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-x-0 top-0 flex h-(--text-prose--line-height) items-center overflow-hidden transition-[opacity,visibility] duration-150 ease-out',
                    text && 'invisible opacity-0',
                  )}
                >
                  {waiting}
                </div>
              )}
            </div>
          )
        )}
        {!user && CONFIDENCE_MARK.test(text) && <ConfidenceLegend />}
        {/* Turn extras (the memory chip) sit in the turn, above its action row. */}
        {footer}
        {/* 32 px, reserved while streaming so nothing jumps. */}
        {((live && reserve) || actions) && (
          <div
            className={cn(
              // ≥ 768 a column under 620 px (Thread's `col` container) puts the receipt on its own
              // line; phones keep the receipt in the long-press sheet, so the meta keeps its line.
              // Phones: 44 px targets 8 px apart (brief 7.7).
              'flex min-h-8 items-center gap-1 transition-opacity duration-100 [-webkit-touch-callout:none] max-md:min-h-11 max-md:gap-2 md:@max-[620px]/col:flex-wrap',
              // A user turn's row, and an older reply's, sits in the 40 px gap below it (Thread.tsx).
              (user || (!latest && !live)) && 'absolute top-full mt-1',
              // A reply's row spans the column: its receipt sits at the end. Phones: the outer
              // 44 px target moves out by its 14 px inset, so its glyph meets the text edge.
              user ? 'right-0 max-md:-mr-3.5' : 'inset-x-0 max-md:-ml-3.5',
              // Hover devices: on hover or focus, except under the latest assistant turn and with
              // the version switcher (phase-24 decision 10).
              !(latest && !user) &&
                !switcher &&
                '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100',
              // Touch: under the latest user and the latest assistant turn, or with the switcher.
              !latest && !switcher && '[@media(hover:none)]:hidden',
            )}
          >
            {actions && (
              <>
                {switcher}
                {user && meta && <MessageMeta createdAt={meta.createdAt} />}
                <CopyButton text={() => stripConfidence(text)} className={small} />
                {user && onEdit && (
                  <IconButton label="Muokkaa" className={small} onClick={() => setEditing(true)}>
                    <Pencil size={16} />
                  </IconButton>
                )}
                {!user && onRetry && (
                  <IconButton label="Yritä uudelleen" className={small} onClick={onRetry}>
                    <RotateCcw size={16} />
                  </IconButton>
                )}
                {annotations.length > 0 && (
                  <IconButton
                    label={pressed ? 'Näytä alkuperäiset' : 'Mitä malli näki'}
                    aria-pressed={pressed}
                    className={small}
                    onClick={() => {
                      // The global setting also counts as on; turning off clears both.
                      if (pressed) useStore.getState().setShowModelSaw(false);
                      setSaw(!pressed);
                    }}
                  >
                    {pressed ? <EyeOff size={16} /> : <Eye size={16} />}
                  </IconButton>
                )}
                {!user && meta && (
                  <MessageMeta createdAt={meta.createdAt} usage={meta.usage} focusable={!!latest} />
                )}
              </>
            )}
            {receipt && (
              <span
                className={cn(
                  'ml-auto flex shrink-0 pl-2 transition-opacity duration-150 ease-out md:@max-[620px]/col:basis-full md:@max-[620px]/col:justify-end md:@max-[620px]/col:pl-0',
                  live ? !text && 'opacity-0' : 'max-md:hidden',
                )}
              >
                {receipt}
              </span>
            )}
          </div>
        )}
      </div>
      {touch && actions && (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="gap-1 rounded-t-xl px-2 pt-4 pb-[max(env(safe-area-inset-bottom),8px)]"
          >
            <SheetTitle className="sr-only">Viestin toiminnot</SheetTitle>
            <SheetDescription className="sr-only">
              {stripConfidence(text).slice(0, 80)}
            </SheetDescription>
            {/* Sulje's 44 px target centred on the first meta line (−13 px = (44 − 18) / 2). The
                meta may run up to its edge, so it keeps one line (UI review 4). */}
            <div className="flex items-start pl-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1 pb-1">
                {meta && (
                  <MetaLine
                    createdAt={meta.createdAt}
                    usage={user ? undefined : meta.usage}
                    fx={fx}
                  />
                )}
                {receipt}
              </div>
              <SheetCloseButton className="-my-[13px]" />
            </div>
            {[
              { label: 'Kopioi', Icon: Copy, run: copy },
              ...(user && onEdit
                ? [{ label: 'Muokkaa', Icon: Pencil, run: () => setEditing(true) }]
                : []),
              ...(!user && onRetry
                ? [{ label: 'Yritä uudelleen', Icon: RotateCcw, run: onRetry }]
                : []),
            ].map(({ label, Icon, run }) => (
              <Button
                key={label}
                variant="ghost"
                className="h-11 justify-start gap-3 font-normal"
                onClick={() => {
                  setSheet(false);
                  run();
                }}
              >
                <Icon size={16} className="text-muted-foreground" />
                {label}
              </Button>
            ))}
          </SheetContent>
        </Sheet>
      )}
    </SawContext.Provider>
  );
}
