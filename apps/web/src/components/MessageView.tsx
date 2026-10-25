import type { Annotation, AttachmentRef } from '@pa/protocol';
import { clsx } from 'clsx';
import { Check, Copy, Eye, EyeOff, FileText, PanelRight, Pencil, RotateCcw } from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  type ComponentProps,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  return (
    <div className="relative">
      <pre
        ref={ref}
        className={clsx(
          'overflow-x-auto rounded-md bg-bg-sunken p-3 font-mono text-secondary',
          kind ? 'pr-20 max-md:pr-24' : 'pr-12',
        )}
      >
        {props.children}
      </pre>
      <div className="absolute top-1 right-1 flex">
        {kind && (
          <IconButton label="Avaa artefaktina" className="size-8 max-md:size-11" onClick={open}>
            <PanelRight size={16} />
          </IconButton>
        )}
        <CopyButton text={() => ref.current?.textContent ?? ''} className="size-8 max-md:size-11" />
      </div>
    </div>
  );
}

/** One message's own "what the model saw" switch; the global setting still wins. */
const SawContext = createContext(false);

// Touch screens have no hover, so the hint opens on tap there.
const touch = globalThis.matchMedia?.('(hover: none)').matches ?? false;

/** A restored real value; the tooltip (or the global toggle) shows the surrogate the model saw. */
function Anno({ real, saw }: { real: string; saw: string }) {
  const local = useContext(SawContext);
  const show = useStore((s) => s.showModelSaw) || local;
  const hint = show ? `Alkuperäinen: ${real}` : `Malli näki: ${saw}`;
  const span = (
    <span
      tabIndex={0}
      aria-description={hint}
      className="rounded-sm bg-bg-sunken underline decoration-fg-muted decoration-dotted underline-offset-2"
    >
      {show ? saw : real}
    </span>
  );
  if (!touch) return <Tip label={hint}>{span}</Tip>;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{span}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          collisionPadding={8}
          className="z-50 rounded-sm bg-fg px-2 py-1 text-secondary text-bg"
        >
          {hint}
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

const components = { pre: Pre, span: Span };
const plugins = [remarkGfm];
const NONE: Annotation[] = [];

export const MarkdownText = memo(function MarkdownText({
  text,
  annotations = NONE,
}: {
  text: string;
  annotations?: Annotation[];
}) {
  const key = JSON.stringify(
    annotations
      .map((a): [string, string] => [text.slice(a.start, a.end), a.modelSaw])
      .filter(([real]) => real)
      .sort((x, y) => y[0].length - x[0].length),
  );
  const rehype = useMemo(() => {
    const pairs = JSON.parse(key) as [string, string][];
    return pairs.length ? [rehypeAnnotate(pairs)] : [];
  }, [key]);
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
      <img src={src} alt={a.name} className="h-32 rounded-md border border-border object-cover" />
    </a>
  ) : (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="flex max-w-60 items-center gap-2 rounded-md border border-border px-3 py-2 text-secondary"
    >
      <FileText size={16} className="shrink-0 text-fg-muted" />
      <span className="truncate">{a.name}</span>
    </a>
  );
}

type Props = {
  role: 'user' | 'assistant';
  text: string;
  annotations?: Annotation[];
  attachments?: AttachmentRef[];
  tools?: ToolView[];
  /** Still streaming: no hover actions yet. */
  live?: boolean;
  /** Live children of a `subagent` call: that tool's row becomes the subagent row. */
  subagents?: SubagentChild[];
  /** User message: sends the edited text as a new message. */
  onEdit?: (text: string) => void;
  /** Assistant message: resends the previous user message. */
  onRetry?: () => void;
};

const small = 'relative size-6 after:absolute after:-inset-2';

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
    <div className="flex w-full max-w-xl flex-col gap-2">
      <textarea
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
        className="w-full resize-y rounded-lg border border-border bg-bg px-4 py-2"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border border-border px-3 hover:bg-bg-sunken"
        >
          Peruuta
        </button>
        <button
          type="button"
          disabled={!value.trim()}
          onClick={() => onSend(value.trim())}
          className="h-9 rounded-md bg-accent px-3 font-medium text-accent-fg disabled:bg-bg-sunken disabled:text-fg-muted"
        >
          Lähetä muokattuna
        </button>
      </div>
    </div>
  );
}

export function MessageView({
  role,
  text,
  annotations = NONE,
  attachments = [],
  tools = [],
  live,
  subagents = [],
  onEdit,
  onRetry,
}: Props) {
  const user = role === 'user';
  const [saw, setSaw] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <SawContext.Provider value={saw}>
      <div className={clsx('group relative flex flex-col gap-2', user && 'items-end')}>
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {attachments.map((a) => (
              <Attachment key={a.id} a={a} />
            ))}
          </div>
        )}
        {tools.length > 0 && (
          <div className="flex flex-col">
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
            <div className="max-w-xl rounded-lg bg-user-bubble px-4 py-2 break-words whitespace-pre-wrap">
              {annotate(text, annotations)}
            </div>
          )
        ) : (
          <MarkdownText text={text} annotations={annotations} />
        )}
        {/* Out of flow: the 24 px row sits in the thread gap. */}
        {!live && !editing && text && (
          <div
            className={clsx(
              'absolute top-full flex gap-2 opacity-0 transition-opacity duration-(--duration) group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100',
              user ? 'right-0' : 'left-0',
            )}
          >
            <CopyButton text={() => text} className={small} />
            {user && onEdit && (
              <IconButton
                label="Muokkaa ja lähetä uutena"
                className={small}
                onClick={() => setEditing(true)}
              >
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
                label={saw ? 'Näytä alkuperäiset' : 'Mitä malli näki'}
                aria-pressed={saw}
                className={small}
                onClick={() => setSaw(!saw)}
              >
                {saw ? <EyeOff size={16} /> : <Eye size={16} />}
              </IconButton>
            )}
          </div>
        )}
      </div>
    </SawContext.Provider>
  );
}
