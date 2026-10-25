import { Ban, Check, ChevronRight, Clock, Loader2, X } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { type ToolView, useStore } from '../store.ts';

export const STATUS_WORD = {
  running: 'käynnissä',
  ok: 'valmis',
  error: 'virhe',
  denied: 'estetty',
} as const;

/** Status icons (brief 7.5): spinner muted, done success, error destructive, waiting warning. */
const ICON = {
  running: { Icon: Loader2, className: 'animate-spin text-muted-foreground' },
  ok: { Icon: Check, className: 'text-success' },
  error: { Icon: X, className: 'text-destructive' },
  denied: { Icon: Ban, className: 'text-destructive' },
  waiting: { Icon: Clock, className: 'text-warning' },
} as const;

const toolTrigger =
  'group flex max-w-full items-center gap-2 rounded-md text-meta text-muted-foreground hover:text-foreground h-8 max-md:min-h-11 [@media(pointer:coarse)]:min-h-11';

/**
 * The collapsed row of a tool call (brief 7.5): status icon, label, a chevron that turns 90°;
 * the content opens 8 px below. The subagents row is a variant.
 */
export function CollapsibleRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className={toolTrigger}>
        {icon}
        {label}
        <ChevronRight
          size={16}
          className="shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden data-closed:animate-collapsible-up data-open:animate-collapsible-down">
        <div className="pt-2">{children}</div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export function ToolRow({ tool }: { tool: ToolView }) {
  // A gated call waits for the user, not the tool (no spinner). After a decision the approval
  // card is gone and this row carries it: "hylätty" or "vanhentunut" (brief 7.5).
  const gate = useStore((s) => {
    const a = s.approvals.find(
      (x) =>
        x.chatId === s.activeChatId &&
        (x.callId ? x.callId === tool.callId : x.tool === tool.name) &&
        (tool.status === 'running'
          ? !x.expired && !x.denied
          : tool.status === 'denied' && (x.expired || x.denied)),
    );
    return a ? (a.expired ? 'expired' : a.denied ? 'rejected' : 'waiting') : null;
  });
  const { Icon, className } =
    gate === 'rejected' ? ICON.error : gate ? ICON.waiting : ICON[tool.status];
  const word =
    gate === 'waiting'
      ? 'odottaa hyväksyntää'
      : gate === 'expired'
        ? 'vanhentunut'
        : gate === 'rejected'
          ? 'hylätty'
          : STATUS_WORD[tool.status];
  // Live output while running; the final summary replaces it.
  const detail = [tool.argsPreview, tool.summary || tool.output].filter(Boolean);
  return (
    <CollapsibleRow
      icon={<Icon size={16} className={cn('shrink-0', className)} />}
      label={
        <>
          <span className="truncate font-mono">{tool.name}</span> <span aria-hidden="true">·</span>{' '}
          <span className="shrink-0">{word}</span>
        </>
      }
    >
      <div
        role="region"
        aria-label={`${tool.name}: tuloste`}
        // A scrollable region must be focusable (brief 7.8).
        tabIndex={0}
        className="max-h-80 space-y-2 overflow-auto rounded-md bg-muted p-3 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground"
      >
        {detail.length ? detail.map((d) => <div key={d}>{d}</div>) : <div>—</div>}
      </div>
    </CollapsibleRow>
  );
}
