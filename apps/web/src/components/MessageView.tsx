import { type Annotation, type AttachmentRef, type CallUsage, mermaidMeta } from '@pa/protocol';
import { Check, Copy, Eye, EyeOff, FileText, PanelRight, Pencil, RotateCcw } from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  type ComponentProps,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { touch } from '../media.ts';
import { type SubagentChild, type ToolView, useStore } from '../store.ts';
import { mdBlocks, settleTail } from '../thread.ts';
import { IconButton, Tip } from './IconButton.tsx';
import { MessageMeta, metaText } from './MessageMeta.tsx';
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

const ARTIFACT_KIND = {
  html: 'html',
  jsx: 'react',
  tsx: 'react',
  mermaid: 'mermaid',
  'vega-lite': 'vega-lite',
} as const;
const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};

/**
 * The thread's code block (brief 7.5): --muted, radius 12, a 36 px header (language, actions),
 * body 16, scrolls sideways. `onOpen` adds "Avaa artefaktina"; the file preview has none.
 */
export function CodeBlock({
  lang,
  children,
  onOpen,
}: {
  lang: string;
  children: ReactNode;
  onOpen?: (content: string) => void;
}) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="overflow-hidden rounded-lg bg-muted">
      <div className="flex h-9 items-center gap-1 pr-1 pl-4 max-md:h-12">
        <span className="min-w-0 flex-1 truncate font-sans text-micro text-muted-foreground">
          {lang || 'koodi'}
        </span>
        {onOpen && (
          <IconButton
            label="Avaa artefaktina"
            className="size-7"
            onClick={() => onOpen(ref.current?.textContent ?? '')}
          >
            <PanelRight size={16} />
          </IconButton>
        )}
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

function Pre(props: ComponentProps<'pre'>) {
  const child = props.children;
  const className = isValidElement<{ className?: string; children?: unknown }>(child)
    ? (child.props.className ?? '')
    : '';
  const lang = /language-(\S+)/.exec(className)?.[1]?.toLowerCase() ?? '';
  const source =
    isValidElement<{ children?: unknown }>(child) && typeof child.props.children === 'string'
      ? child.props.children
      : '';
  const kind =
    ARTIFACT_KIND[lang as keyof typeof ARTIFACT_KIND] ??
    (source.split('\n').length > 30 ? 'code' : undefined);
  const open = (shown: string) => {
    const st = useStore.getState();
    const content = shown || source;
    if (!kind || !st.activeChatId) return;
    st.showArtifact(st.activeChatId, {
      id: `local-${hash(content)}`,
      kind,
      title:
        (kind === 'mermaid' && mermaidMeta(content).title) ||
        (lang ? `${lang} (viestistä)` : 'Koodi (viestistä)'),
      ...(lang ? { language: lang } : {}),
      content,
    });
  };
  return (
    <CodeBlock lang={lang} {...(kind ? { onOpen: open } : {})}>
      {props.children}
    </CodeBlock>
  );
}

/** One message's own "what the model saw" switch; the global setting still wins. */
const SawContext = createContext(false);

/** A restored real value; the tooltip (or the global toggle) shows the surrogate the model saw. */
function Anno({ real, saw }: { real: string; saw: string }) {
  const local = useContext(SawContext);
  const show = useStore((s) => s.showModelSaw) || local;
  const hint = show ? `Alkuperäinen: ${real}` : `Malli näki: ${saw}`;
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

/** Rehype plugin: the streaming caret after the last character (brief 7.5). */
const rehypeCaret = () => (tree: HNode) => {
  let parent: HNode | undefined;
  const walk = (n: HNode) => {
    const last = n.children?.at(-1);
    if (!last) return;
    if (last.type === 'text') parent = n;
    else walk(last);
  };
  walk(tree);
  (parent ?? tree).children?.push({
    type: 'element',
    tagName: 'span',
    properties: { className: ['caret'], ariaHidden: 'true' },
    children: [],
  });
};

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
  // The base plugins depend on the annotations only: finished blocks keep the same array.
  const rehype = useMemo(() => {
    const pairs = JSON.parse(key) as [string, string][];
    return pairs.length ? [rehypeAnnotate(pairs)] : [];
  }, [key]);
  const rehypeLast = useMemo(() => (live ? [...rehype, rehypeCaret] : rehype), [rehype, live]);
  // Blocks render as siblings in one `.md`, so the DOM is the same as one parse would give.
  const { blocks, definitions } = mdBlocks(text, !live);
  if (live) {
    // A tail held back whole: the caret stays on the block before it.
    const tail = settleTail(blocks.at(-1) ?? '');
    if (tail) blocks[blocks.length - 1] = tail;
    else blocks.pop();
  }
  // Each block gets the reference definitions it uses (`[label]`); they render nothing.
  const withDefinitions = (b: string) => {
    const low = b.toLowerCase();
    const used = definitions.filter((d) => low.includes(`[${d.label}]`) && !b.includes(d.line));
    return used.length ? `${b}\n\n${used.map((d) => d.line).join('\n')}` : b;
  };
  return (
    <div className="md break-words">
      {blocks.map((b, i) => (
        <Block
          key={i}
          text={withDefinitions(b)}
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
  /** Still streaming: the caret shows and the action row is only reserved. */
  live?: boolean;
  /** While live, keep the empty action row (default); off when an approval card follows. */
  reserve?: boolean;
  /** Rendered after the text and before the action row, at the 8 px in-turn gap. */
  footer?: ReactNode;
  /** The latest turn of its role: its actions show without hover (brief 7.5). */
  latest?: boolean;
  /** Live children of a `subagent` call: that tool's row becomes the subagent row. */
  subagents?: SubagentChild[];
  /** User message: "Haarauta" starts a new chat from the edited text (phase 13). */
  onEdit?: (text: string) => void;
  /** A fork is on its way: "Haarauta" waits for its answer. */
  forking?: boolean;
  /** False while the message has no entry id yet: "Haarauta" asks for a reopen. */
  canFork?: boolean;
  /** Asks the server for the chat's entry ids (an edit of a message without one). */
  onNeedIds?: () => void;
  /** The thinking row, above the tool rows and the text (phase 13). */
  thinking?: ReactNode;
  /** The action row meta: the time, and a reply's cost and tokens (phase 13). */
  meta?: { createdAt: string; usage?: CallUsage | undefined };
  /**
   * Assistant message: sends the previous user message again as a new turn. A failed turn has no
   * message here; the thread's alert retries it in place (`user.retry`).
   */
  onRetry?: () => void;
};

// 32 px icons in the action row; 44 px touch targets on phones.
const small = 'size-8';

function EditBox({
  text,
  busy,
  canFork,
  onSend,
  onCancel,
}: {
  text: string;
  busy: boolean;
  canFork: boolean;
  onSend: (t: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
  const ready = !!value.trim() && !busy && canFork;
  const hint = useId();
  return (
    <div className="flex w-full max-w-[80%] flex-col gap-2 max-md:max-w-full">
      <Textarea
        autoFocus
        aria-label="Muokattava viesti"
        value={value}
        rows={Math.min(8, value.split('\n').length + 1)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) {
            e.stopPropagation();
            onSend(value.trim());
          }
        }}
        aria-describedby={`${hint}`}
        className="field-sizing-fixed resize-y rounded-xl px-4"
      />
      <p id={hint} className="text-meta text-muted-foreground">
        {canFork
          ? 'Muokattu viesti aloittaa uuden keskustelun. Tämä keskustelu ei muutu.'
          : 'Avaa keskustelu uudelleen, niin voit haarauttaa tämän viestin.'}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Peruuta
        </Button>
        <Button disabled={!ready} onClick={() => onSend(value.trim())}>
          Haarauta
        </Button>
      </div>
    </div>
  );
}

export function MessageView({
  id,
  role,
  text,
  annotations = NONE,
  attachments = [],
  tools = [],
  live,
  reserve = true,
  footer,
  latest,
  subagents = [],
  onEdit,
  forking = false,
  canFork = true,
  onNeedIds,
  thinking,
  meta,
  onRetry,
}: Props) {
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
    if (editing && !canFork) onNeedIds?.();
  }, [editing]);

  const copy = () => void navigator.clipboard.writeText(text);
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
        {user && editing && onEdit ? (
          // Stays open while the fork is on its way: a failure keeps the text for a retry.
          <EditBox
            text={text}
            busy={forking}
            canFork={canFork}
            onCancel={() => setEditing(false)}
            onSend={onEdit}
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
          // Before the first token nothing shows here: the tool row or the dots carry it.
          text && <MarkdownText text={text} annotations={annotations} live={!!live} />
        )}
        {/* Turn extras (the memory chip) sit in the turn, above its action row. */}
        {footer}
        {/* 32 px, reserved while streaming so nothing jumps. */}
        {((live && reserve) || actions) && (
          <div
            className={cn(
              'flex h-8 items-center gap-1 transition-opacity duration-100 [-webkit-touch-callout:none] max-md:h-11',
              // A user turn's row, and an older reply's, sits in the 40 px gap below it (Thread.tsx).
              (user || (!latest && !live)) && 'absolute top-full mt-1',
              user ? 'right-0' : 'left-0',
              // Hover devices: on hover or focus, except under the latest assistant turn.
              !(latest && !user) &&
                '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100',
              // Touch: only under the latest user and the latest assistant turn.
              !latest && '[@media(hover:none)]:hidden',
            )}
          >
            {actions && (
              <>
                {user && meta && <MessageMeta createdAt={meta.createdAt} />}
                <CopyButton text={() => text} className={small} />
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
          </div>
        )}
      </div>
      {touch && actions && (
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent
            side="bottom"
            className="gap-1 rounded-t-xl px-2 pt-2 pb-[max(env(safe-area-inset-bottom),8px)]"
          >
            <SheetTitle className="sr-only">Viestin toiminnot</SheetTitle>
            <SheetDescription className="sr-only">{text.slice(0, 80)}</SheetDescription>
            {meta && (
              <p className="px-3 pb-1 text-meta text-muted-foreground tabular-nums">
                {metaText(meta.createdAt, user ? undefined : meta.usage, fx)}
              </p>
            )}
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
