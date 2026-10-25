import { AlertCircle, ArrowDown, MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type UiMessage, useStore } from '../store.ts';
import { openChat, sendUserMessage } from '../ws.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { IconButton } from './IconButton.tsx';
import { MemoryChipRow } from './MemoryChipRow.tsx';
import { MessageView } from './MessageView.tsx';
import { UNTITLED } from './Sidebar.tsx';
import { SubagentRow } from './SubagentRow.tsx';
import { STATUS_WORD } from './ToolRow.tsx';

const EMPTY: never[] = [];

/** Screen-reader announcement in the app's live regions (App.tsx; brief 7.8). */
export function announce(text: string, assertive = false) {
  const el = document.getElementById(assertive ? 'live-assertive' : 'live-polite');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, 50);
}

/** The user message before `i`, for "retry". */
const previousUser = (messages: UiMessage[], i: number) =>
  messages.slice(0, i).findLast((m) => m.role === 'user' && m.text);

/** Stream start and end, tool status changes and approvals, never per token. */
function useAnnouncements(chatId: string | null) {
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const tools = useStore((s) => (chatId ? s.streaming[chatId]?.tools : undefined)) ?? EMPTY;
  const approvals = useStore((s) => s.approvals);
  const was = useRef({ running, tools: new Map<string, string>(), approvals: new Set<string>() });
  useEffect(() => {
    if (running !== was.current.running) announce(running ? 'Avustaja vastaa' : 'Vastaus valmis');
    was.current.running = running;
  }, [running]);
  useEffect(() => {
    for (const t of tools) {
      const before = was.current.tools.get(t.callId);
      if (before && before !== t.status) announce(`Työkalu ${t.name} ${STATUS_WORD[t.status]}`);
      was.current.tools.set(t.callId, t.status);
    }
  }, [tools]);
  useEffect(() => {
    for (const a of approvals) {
      if (a.expired || was.current.approvals.has(a.requestId)) continue;
      was.current.approvals.add(a.requestId);
      announce(`Hyväksyntä odottaa: ${a.tool}`, true);
    }
  }, [approvals]);
}

export function Thread() {
  const chatId = useStore((s) => s.activeChatId);
  const messages = useStore((s) => (chatId ? (s.messages[chatId] ?? EMPTY) : EMPTY));
  const stream = useStore((s) => (chatId ? s.streaming[chatId] : undefined));
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const related = useStore((s) => (chatId ? s.related[chatId] : undefined)) ?? EMPTY;
  const scrollTo = useStore((s) => s.scrollTo);
  const memoryChip = useStore((s) => (chatId ? s.memoryChip[chatId] : undefined));
  const subagents = useStore((s) => (chatId ? s.subagents[chatId] : undefined)) ?? EMPTY;
  const failed = useStore((s) => (chatId ? s.failed[chatId] : undefined));
  // Filtered here, not in the selector: a new array per call would re-render forever.
  const allApprovals = useStore((s) => s.approvals);
  // Open requests only: a decided one is shown by its tool row.
  const approvals = allApprovals.filter((a) => a.chatId === chatId && !a.expired && !a.denied);
  const scroller = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  useAnnouncements(chatId);

  // Follow the bottom while the user has not scrolled up (a jump, not a smooth scroll).
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.text, stream?.tools, running, allApprovals, subagents, failed]);

  // A search hit opens at its message once the chat's messages are in.
  useEffect(() => {
    if (!scrollTo) return;
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(scrollTo)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    pinned.current = false;
    useStore.getState().setScrollTo(null);
  }, [messages, scrollTo]);

  const lastUser = messages.findLastIndex((m) => m.role === 'user');
  // The memory chip belongs to the turn that wrote memory: the live one, else the last reply.
  const chip = memoryChip && <MemoryChipRow chip={memoryChip} />;
  const chipAt = stream || running ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  const lastAssistant =
    stream || running ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
  // A tool-only assistant message and the reply after it are one turn (8 px in-turn gap).
  const turns: { role: UiMessage['role']; items: { m: UiMessage; i: number }[] }[] = [];
  messages.forEach((m, i) => {
    const turn = turns.at(-1);
    const prev = turn?.items.at(-1)?.m;
    if (turn && m.role === 'assistant' && turn.role === 'assistant' && prev && !prev.text)
      turn.items.push({ m, i });
    else turns.push({ role: m.role, items: [{ m, i }] });
  });
  const lastTurn = turns.at(-1);
  const joinLive =
    !!(stream || running) && lastTurn?.role === 'assistant' && !lastTurn.items.at(-1)?.m.text;
  const cards = approvals.map((a) => <ApprovalCard key={a.requestId} a={a} />);
  const liveView = (stream || running) && (
    <>
      {stream?.text || stream?.tools.length ? (
        <MessageView
          role="assistant"
          text={stream.text}
          annotations={stream.annotations}
          tools={stream.tools}
          subagents={subagents}
          live
          // A pending approval card follows in the same turn; no reserved row in between.
          reserve={!approvals.length}
          footer={chip}
        />
      ) : (
        // Before the first token: three 6 px dots; the action row's 32 px is kept.
        <div className="flex flex-col gap-2">
          <span
            role="status"
            aria-label="Vastaus tulossa"
            className="flex h-7 items-center gap-1.5"
          >
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                style={{ animationDelay: `${d}ms` }}
                className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
              />
            ))}
          </span>
          <div className="h-8" />
        </div>
      )}
      {/* The approval card sits in the turn of its tool row (8 px gap), never as a modal. */}
      {cards}
    </>
  );

  const retryLast = () => {
    const prev = previousUser(messages, messages.length);
    if (prev) void sendUserMessage(prev.text, prev.attachments);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section
        ref={scroller}
        aria-label="Keskustelu"
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          pinned.current = gap < 48;
          setAway(gap > 80);
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max) flex-col gap-6 py-6">
          {turns.map((t, n) => {
            const last = n === turns.length - 1;
            return (
              <article
                key={t.items[0]?.m.id}
                // After a user turn 40 px (48 on phones): its action row sits in the gap.
                className={cn(
                  'flex flex-col gap-2 animate-fade-in',
                  t.role === 'user' && 'mb-4 max-md:mb-6',
                )}
              >
                <h2 className="sr-only">{t.role === 'user' ? 'Sinä sanoit' : 'Avustaja sanoi'}</h2>
                {t.items.map(({ m, i }) => {
                  const prev = m.role === 'assistant' ? previousUser(messages, i) : undefined;
                  return (
                    <div key={m.id} data-message-id={m.id}>
                      <MessageView
                        id={m.id}
                        role={m.role}
                        text={m.text}
                        annotations={m.annotations}
                        attachments={m.attachments}
                        tools={m.tools}
                        latest={i === lastUser || i === lastAssistant}
                        {...(i === chipAt ? { footer: chip } : {})}
                        {...(m.role === 'user'
                          ? { onEdit: (text: string) => void sendUserMessage(text) }
                          : {})}
                        {...(prev
                          ? { onRetry: () => void sendUserMessage(prev.text, prev.attachments) }
                          : {})}
                      />
                    </div>
                  );
                })}
                {last && joinLive && liveView}
              </article>
            );
          })}
          {/* No reply to hold it (the turn failed before any text): on its own. */}
          {!(stream || running) && chipAt < 0 && chip}
          {!stream && !running && related.length > 0 && (
            <nav aria-label="Liittyvät keskustelut" className="flex flex-col gap-2">
              <h2 className="text-micro text-muted-foreground">Liittyvät keskustelut</h2>
              {/* Not a list: the sidebar owns `nav li > button` (e2e counts chat rows by it). */}
              <div className="flex flex-wrap gap-2">
                {related.slice(0, 3).map((r) => (
                  <Button
                    key={r.chatId}
                    variant="outline"
                    size="sm"
                    onClick={() => openChat(r.chatId)}
                    className="max-w-60 justify-start font-normal"
                  >
                    <MessageSquare size={16} className="text-muted-foreground" />
                    <span className="truncate">{r.title || UNTITLED}</span>
                  </Button>
                ))}
              </div>
            </nav>
          )}
          {/* Normally the `subagent` tool row carries it; standalone only before that row exists. */}
          {subagents.length > 0 && !stream?.tools.some((t) => t.name === 'subagent') && (
            <SubagentRow items={subagents} />
          )}
          {(stream || running) && !joinLive && (
            <article className="flex flex-col gap-2">
              <h2 className="sr-only">Avustaja sanoi</h2>
              {liveView}
            </article>
          )}
          {failed && !stream && !running && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive-subtle px-4 py-3 text-body text-foreground"
            >
              <AlertCircle size={16} className="shrink-0 text-destructive" />
              <span className="min-w-0 flex-1">{failed}</span>
              <Button variant="outline" size="sm" onClick={retryLast}>
                Yritä uudelleen
              </Button>
            </div>
          )}
          {!(stream || running) && cards}
        </div>
      </section>
      {away && (
        <IconButton
          label="Siirry loppuun"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card shadow-md"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDown size={16} />
        </IconButton>
      )}
    </div>
  );
}
