import type { Annotation, AttachmentRef } from '@pa/protocol';
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
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { touch } from '../media.ts';
import { type SubagentChild, type ToolView, useStore } from '../store.ts';
import { IconButton, Tip } from './IconButton.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { ToolRow } from './ToolRow.tsx';

function CopyButton({ text, className }: { text: () => string; className: string }) {
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

const ARTIFACT_KIND = { html: 'html', jsx: 'react', tsx: 'react', mermaid: 'mermaid' } as const;
const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};

function Pre(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
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
  const open = () => {
    const st = useStore.getState();
    const content = ref.current?.textContent ?? source;
    if (!kind || !st.activeChatId) return;
    st.showArtifact(st.activeChatId, {
      id: `local-${hash(content)}`,
      kind,
      title: lang ? `${lang} (viestistä)` : 'Koodi (viestistä)',
      ...(lang ? { language: lang } : {}),
      content,
    });
  };
  // Brief 7.5: --muted, radius 12, a 36 px header (language, actions), body 16, scrolls sideways.
  return (
    <div className="overflow-hidden rounded-lg bg-muted">
      <div className="flex h-9 items-center gap-1 pr-1 pl-4 max-md:h-12">
        <span className="min-w-0 flex-1 truncate font-sans text-micro text-muted-foreground">
          {lang || 'koodi'}
        </span>
        {kind && (
          <IconButton label="Avaa artefaktina" className="size-7" onClick={open}>
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
        {props.children}
      </pre>
    </div>
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
function annotate(text: string, annotations: Annotation[]): ReactNode[] {
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
  const rehype = useMemo(() => {
    const pairs = JSON.parse(key) as [string, string][];
    return [...(pairs.length ? [rehypeAnnotate(pairs)] : []), ...(live ? [rehypeCaret] : [])];
  }, [key, live]);
  return (
    <div className="md break-words">
      <Markdown remarkPlugins={plugins} rehypePlugins={rehype} components={components}>
        {text}
      </Markdown>
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
  /** User message: sends the edited text as a new message. */
  onEdit?: (text: string) => void;
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
  onSend,
  onCancel,
}: {
  text: string;
  onSend: (t: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
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
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && value.trim()) {
            e.stopPropagation();
            onSend(value.trim());
          }
        }}
        className="field-sizing-fixed resize-y rounded-xl px-4"
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Peruuta
        </Button>
        <Button disabled={!value.trim()} onClick={() => onSend(value.trim())}>
          Lähetä muokattuna
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
  onRetry,
}: Props) {
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
          <EditBox
            text={text}
            onCancel={() => setEditing(false)}
            onSend={(t) => {
              setEditing(false);
              onEdit(t);
            }}
          />
        ) : user ? (
          text && (
            <div className="max-w-[80%] rounded-xl bg-secondary px-4 py-2.5 text-body text-pretty whitespace-pre-wrap text-secondary-foreground hyphens-auto [overflow-wrap:anywhere] max-md:max-w-[85%]">
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
              // A user turn's row sits in the 40 px gap below the bubble (Thread.tsx).
              user && 'absolute top-full right-0 mt-1',
              // Hover devices: on hover or focus, except under the latest assistant turn.
              !(latest && !user) &&
                '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100',
              // Touch: only under the latest user and the latest assistant turn.
              !latest && '[@media(hover:none)]:hidden',
            )}
          >
            {actions && (
              <>
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
