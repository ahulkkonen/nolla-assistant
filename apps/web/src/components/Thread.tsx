import { AlertCircle, ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
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
  const approvals = allApprovals.filter((a) => a.chatId === chatId);
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
  const lastAssistant =
    stream || running ? -1 : messages.findLastIndex((m) => m.role === 'assistant');
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
          {messages.map((m, i) => {
            const prev = m.role === 'assistant' ? previousUser(messages, i) : undefined;
            return (
              <article key={m.id} data-message-id={m.id} className="animate-fade-in">
                <h2 className="sr-only">{m.role === 'user' ? 'Sinä sanoit' : 'Avustaja sanoi'}</h2>
                <MessageView
                  id={m.id}
                  role={m.role}
                  text={m.text}
                  annotations={m.annotations}
                  attachments={m.attachments}
                  tools={m.tools}
                  latest={i === lastUser || i === lastAssistant}
                  {...(m.role === 'user' ? { onEdit: (t: string) => void sendUserMessage(t) } : {})}
                  {...(prev
                    ? { onRetry: () => void sendUserMessage(prev.text, prev.attachments) }
                    : {})}
                />
              </article>
            );
          })}
          {memoryChip && <MemoryChipRow chip={memoryChip} />}
          {!stream && !running && related.length > 0 && (
            <nav
              aria-label="Liittyvät keskustelut"
              className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground"
            >
              Liittyvät keskustelut:
              {related.slice(0, 3).map((r) => (
                <button
                  key={r.chatId}
                  type="button"
                  onClick={() => openChat(r.chatId)}
                  className="h-8 max-w-60 truncate rounded-md border border-border px-3 hover:bg-accent hover:text-foreground max-md:h-11"
                >
                  {r.title || UNTITLED}
                </button>
              ))}
            </nav>
          )}
          {/* Normally the `subagent` tool row carries it; standalone only before that row exists. */}
          {subagents.length > 0 && !stream?.tools.some((t) => t.name === 'subagent') && (
            <SubagentRow items={subagents} />
          )}
          {(stream || running) && (
            <article>
              <h2 className="sr-only">Avustaja sanoi</h2>
              {stream?.text || stream?.tools.length ? (
                <MessageView
                  role="assistant"
                  text={stream.text}
                  annotations={stream.annotations}
                  tools={stream.tools}
                  subagents={subagents}
                  live
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
          {approvals.map((a) => (
            <ApprovalCard key={a.requestId} a={a} />
          ))}
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
