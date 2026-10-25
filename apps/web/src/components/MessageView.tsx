import type { AttachmentRef } from '@pa/protocol';
import { clsx } from 'clsx';
import { Check, Copy, FileText } from 'lucide-react';
import { type ComponentProps, memo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ToolView } from '../store.ts';
import { IconButton } from './IconButton.tsx';
import { ToolRow } from './ToolRow.tsx';

function CopyButton({ text, className }: { text: () => string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Kopioitu' : 'Kopioi'}
      className={clsx('size-8', className)}
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
      <CopyButton text={() => ref.current?.textContent ?? ''} className="absolute top-1 right-1" />
    </div>
  );
}

const components = { pre: Pre };
const plugins = [remarkGfm];

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="md break-words">
      <Markdown remarkPlugins={plugins} components={components}>
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
  attachments?: AttachmentRef[];
  tools?: ToolView[];
  /** Still streaming: no hover actions yet. */
  live?: boolean;
};

export function MessageView({ role, text, attachments = [], tools = [], live }: Props) {
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
            {text}
          </div>
        )
      ) : (
        <MarkdownText text={text} />
      )}
      {/* Out of flow: the 24 px row sits in the thread gap. User copy waits for phase 7 edit. */}
      {!user && !live && text && (
        <div className="absolute top-full left-0 opacity-0 transition-opacity duration-(--duration) group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <CopyButton text={() => text} className="size-6!" />
        </div>
      )}
    </div>
  );
}
