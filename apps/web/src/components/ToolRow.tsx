import { Ban, Check, ChevronRight, Clock, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import { type ToolView, useStore } from '../store.ts';

const STATUS = {
  running: { Icon: LoaderCircle, text: 'käynnissä' },
  ok: { Icon: Check, text: 'valmis' },
  error: { Icon: X, text: 'virhe' },
  denied: { Icon: Ban, text: 'estetty' },
} as const;

export function ToolRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(false);
  // A gated call waits for the user, not the tool: no spinner.
  const waiting = useStore(
    (s) =>
      tool.status === 'running' &&
      s.approvals.some(
        (a) =>
          !a.expired &&
          a.chatId === s.activeChatId &&
          (a.callId ? a.callId === tool.callId : a.tool === tool.name),
      ),
  );
  const { Icon, text } = waiting
    ? { Icon: Clock, text: 'odottaa hyväksyntää' }
    : STATUS[tool.status];
  // Live output while running; the final summary replaces it.
  const detail = [tool.argsPreview, tool.summary || tool.output].filter(Boolean);
  return (
    <div className="text-secondary text-fg-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-full items-center gap-2 rounded-sm py-1 hover:text-fg"
      >
        <Icon
          size={16}
          className={tool.status === 'running' && !waiting ? 'animate-spin' : undefined}
        />
        <span className="truncate font-mono">{tool.name}</span>
        <span>{text}</span>
        <ChevronRight
          size={16}
          className={
            open
              ? 'rotate-90 transition-transform duration-(--duration)'
              : 'transition-transform duration-(--duration)'
          }
        />
      </button>
      {open && (
        <div className="mt-1 mb-2 space-y-2 rounded-md bg-bg-sunken p-3 font-mono break-words whitespace-pre-wrap">
          {detail.length ? detail.map((d) => <div key={d}>{d}</div>) : <div>—</div>}
        </div>
      )}
    </div>
  );
}
