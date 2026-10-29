import { FETCH_URL_TOOL, TOOL_STATUS_WORD, type ToolSearch, WEB_SEARCH_TOOL } from '@pa/protocol';
import {
  Ban,
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  FilePen,
  FileText,
  Globe,
  Loader2,
  type LucideIcon,
  MessageSquareText,
  Plug,
  SlidersHorizontal,
  Terminal,
  TimerOff,
  Wrench,
  X,
} from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { type ToolView, useStore } from '../store.ts';

/** Status icons (brief 7.5): spinner muted, done success, error destructive, waiting warning. */
const ICON = {
  running: { Icon: Loader2, className: 'animate-spin text-muted-foreground' },
  ok: { Icon: Check, className: 'text-success' },
  error: { Icon: X, className: 'text-destructive' },
  denied: { Icon: Ban, className: 'text-destructive' },
  waiting: { Icon: Clock, className: 'text-warning' },
  // Decided by time, not by anyone: quiet, unlike the waiting clock.
  expired: { Icon: TimerOff, className: 'text-muted-foreground' },
} as const;

/** What the tool does, before its name (phase-21 decision 5); MCP tools `Plug`, others `Wrench`. */
const TOOL_ICON = new Map<string, LucideIcon>([
  ['recall', Brain],
  ['memory', Brain],
  ['read', FileText],
  ['write', FilePen],
  ['edit', FilePen],
  ['bash', Terminal],
  [WEB_SEARCH_TOOL, Globe],
  [FETCH_URL_TOOL, Globe],
  ['profile_edit', SlidersHorizontal],
  ['automation_edit', CalendarClock],
  ['chat_read', MessageSquareText],
]);

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
  onOpenChange,
}: {
  icon: ReactNode;
  label: ReactNode;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root {...(onOpenChange ? { onOpenChange } : {})}>
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

/**
 * A `web_search` row's word (phase-14 UI): "5 tulosta", "1 tulos", "ei tuloksia", "haetaan…";
 * a blocked call (deny, timeout, automation) is "estetty".
 */
function searchWord(status: ToolView['status'], gate: string | null, s?: ToolSearch) {
  if (status === 'denied' || gate === 'rejected' || gate === 'expired') return 'estetty';
  if (status === 'running') return 'haetaan…';
  if (status === 'error') return TOOL_STATUS_WORD.error;
  const n = s?.results.length ?? 0;
  return n === 0 ? 'ei tuloksia' : n === 1 ? '1 tulos' : `${n} tulosta`;
}

/**
 * The word of a finished harness or fetch call (phase 25), from its answer: "tallennettu" for the
 * server's `SAVED`, "haettu" for a page (the `UNTRUSTED_NOTE` block), and for `chat_read`
 * "luettu", "3 osumaa" or "ei osumia". Any other answer, and a row from history (no summary),
 * is "valmis".
 */
function doneWord(name: string, summary: string) {
  const edit = name === 'profile_edit' || name === 'automation_edit';
  if (edit && summary.startsWith('Tallennettu.')) return 'tallennettu';
  if (name === FETCH_URL_TOOL && summary.startsWith('Seuraava teksti on ulkoista')) return 'haettu';
  if (name !== 'chat_read' || !summary) return TOOL_STATUS_WORD.ok;
  const hits = /^(\d+) osumaa/.exec(summary)?.[1];
  return hits ? `${hits} osumaa` : summary.startsWith('Ei osumia') ? 'ei osumia' : 'luettu';
}

/** "www.yle.fi" → "yle.fi"; null for a URL that is not http(s). */
const hostOf = (url: string) => {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/** The query that ran and its links, each opening in a new tab (phase-14 UI). */
function SearchResults({ search }: { search: ToolSearch }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
      <p className="text-ui text-foreground">
        <span className="text-muted-foreground">Haku:</span> ”{search.query}”
      </p>
      {search.results.length > 0 && (
        <ul aria-label="Hakutulokset" className="flex flex-col">
          {search.results.map((r, i) => {
            // The protocol allows http(s) only; the client checks again before an href.
            const host = hostOf(r.url);
            const body = (
              <>
                <span className="text-ui [overflow-wrap:anywhere] group-hover/link:underline">
                  {r.title}
                </span>
                {host && (
                  // The title alone names the link.
                  <span aria-hidden="true" className="text-meta text-muted-foreground">
                    {host}
                  </span>
                )}
              </>
            );
            return (
              <li key={`${i}:${r.url}`} className="min-w-0">
                {host ? (
                  // One block link over the title and the host (44 px on touch).
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group/link flex min-h-11 flex-col justify-center rounded-sm py-1.5 text-link underline-offset-4"
                  >
                    {body}
                  </a>
                ) : (
                  <div className="flex min-h-11 flex-col justify-center py-1.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
    gate === 'rejected'
      ? ICON.error
      : gate === 'expired'
        ? ICON.expired
        : gate
          ? ICON.waiting
          : ICON[tool.status];
  const ToolIcon = TOOL_ICON.get(tool.name) ?? (tool.name.startsWith('mcp__') ? Plug : Wrench);
  const search = tool.name === WEB_SEARCH_TOOL;
  const word =
    gate === 'waiting'
      ? 'odottaa hyväksyntää'
      : search
        ? searchWord(tool.status, gate, tool.search)
        : gate === 'expired'
          ? 'vanhentunut'
          : gate === 'rejected'
            ? 'hylätty'
            : tool.status === 'ok'
              ? doneWord(tool.name, tool.summary)
              : tool.status === 'running' && tool.name === FETCH_URL_TOOL
                ? 'haetaan…'
                : TOOL_STATUS_WORD[tool.status];
  // Live output while running; the final summary replaces it.
  const result = tool.summary || tool.output;
  const part = (label: string, text: string) => (
    <div className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="font-sans text-micro text-muted-foreground">{label}</div>
      <div>{text}</div>
    </div>
  );
  return (
    <CollapsibleRow
      icon={<Icon size={16} className={cn('shrink-0', className)} />}
      label={
        <>
          <ToolIcon size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <span className="truncate font-mono">{tool.name}</span> <span aria-hidden="true">·</span>{' '}
          <span className="shrink-0">{word}</span>
        </>
      }
    >
      {search && tool.search ? (
        <SearchResults search={tool.search} />
      ) : (
        <div
          role="region"
          aria-label={`${tool.name}: tuloste`}
          // A scrollable region must be focusable (brief 7.8).
          tabIndex={0}
          className="flex max-h-80 flex-col gap-2 overflow-auto rounded-md bg-muted p-3 font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground"
        >
          {/* Arguments and result, each labelled (brief 7.5 tool output). */}
          {tool.argsPreview && part('Syöte', tool.argsPreview)}
          {result && part('Tulos', result)}
          {!tool.argsPreview && !result && <div>—</div>}
        </div>
      )}
    </CollapsibleRow>
  );
}
