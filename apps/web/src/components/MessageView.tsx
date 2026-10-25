import type { Annotation, AttachmentRef } from '@pa/protocol';
import { clsx } from 'clsx';
import { Check, Copy, FileText } from 'lucide-react';
import { type ComponentProps, memo, type ReactNode, useMemo, useRef, useState } from 'react';
import Markdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type ToolView, useStore } from '../store.ts';
import { IconButton, Tip } from './IconButton.tsx';
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

function Pre(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="relative">
      <pre
        ref={ref}
        className="overflow-x-auto rounded-md bg-bg-sunken p-3 pr-12 font-mono text-secondary"
      >
        {props.children}
      </pre>
      <CopyButton
        text={() => ref.current?.textContent ?? ''}
        className="absolute top-1 right-1 size-8 max-md:size-11"
      />
    </div>
  );
}

/** A restored real value; the tooltip (or the global toggle) shows the surrogate the model saw. */
function Anno({ real, saw }: { real: string; saw: string }) {
  const show = useStore((s) => s.showModelSaw);
  return (
    <Tip label={`Malli näki: ${saw}`}>
      <span
        tabIndex={0}
        className="rounded-sm bg-bg-sunken underline decoration-fg-muted decoration-dotted underline-offset-2"
      >
        {show ? saw : real}
      </span>
    </Tip>
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
};

export function MessageView({
  role,
  text,
  annotations = NONE,
  attachments = [],
  tools = [],
  live,
}: Props) {
  const user = role === 'user';
  return (
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
          {tools.map((t) => (
            <ToolRow key={t.callId} tool={t} />
          ))}
        </div>
      )}
      {user ? (
        text && (
          <div className="max-w-xl rounded-lg bg-user-bubble px-4 py-2 break-words whitespace-pre-wrap">
            {annotate(text, annotations)}
          </div>
        )
      ) : (
        <MarkdownText text={text} annotations={annotations} />
      )}
      {/* Out of flow: the 24 px row sits in the thread gap. User copy waits for phase 7 edit. */}
      {!user && !live && text && (
        <div className="absolute top-full left-0 opacity-0 transition-opacity duration-(--duration) group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton text={() => text} className="relative size-6 after:absolute after:-inset-2" />
        </div>
      )}
    </div>
  );
}
