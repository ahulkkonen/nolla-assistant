import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { type UiMessage, useStore } from '../store.ts';
import { openChat, sendUserMessage } from '../ws.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { MemoryChipRow } from './MemoryChipRow.tsx';
import { MessageView } from './MessageView.tsx';
import { UNTITLED } from './Sidebar.tsx';
import { SubagentRow } from './SubagentRow.tsx';

const EMPTY: never[] = [];
/** Above this many messages only the visible ones are in the DOM (rule 10). */
const VIRTUAL_FROM = 200;

/** The user message before `i`, for "retry". */
const previousUser = (messages: UiMessage[], i: number) =>
  messages.slice(0, i).findLast((m) => m.role === 'user' && m.text);

export function Thread() {
  const chatId = useStore((s) => s.activeChatId);
  const messages = useStore((s) => (chatId ? (s.messages[chatId] ?? EMPTY) : EMPTY));
  const stream = useStore((s) => (chatId ? s.streaming[chatId] : undefined));
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const related = useStore((s) => (chatId ? s.related[chatId] : undefined)) ?? EMPTY;
  const scrollTo = useStore((s) => s.scrollTo);
  const memoryChip = useStore((s) => (chatId ? s.memoryChip[chatId] : undefined));
  const subagents = useStore((s) => (chatId ? s.subagents[chatId] : undefined)) ?? EMPTY;
  // Filtered here, not in the selector: a new array per call would re-render forever.
  const allApprovals = useStore((s) => s.approvals);
  const approvals = allApprovals.filter((a) => a.chatId === chatId);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const virtual = messages.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: virtual ? messages.length : 0,
    getScrollElement: () => scroller.current,
    estimateSize: () => 120,
    overscan: 6,
    // The list starts after the column's 24 px top padding.
    scrollMargin: 24,
  });

  // Follow the bottom while the user has not scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.text, stream?.tools, running, allApprovals, subagents]);

  // A search hit opens at its message once the chat's messages are in.
  useEffect(() => {
    if (!scrollTo) return;
    if (virtual) {
      const i = messages.findIndex((m) => m.id === scrollTo);
      if (i < 0) return;
      virtualizer.scrollToIndex(i, { align: 'center' });
      pinned.current = false;
      return useStore.getState().setScrollTo(null);
    }
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(scrollTo)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    pinned.current = false;
    useStore.getState().setScrollTo(null);
  }, [messages, scrollTo, virtual, virtualizer]);

  const view = (m: UiMessage, i: number) => {
    const prev = m.role === 'assistant' ? previousUser(messages, i) : undefined;
    return (
      <MessageView
        role={m.role}
        text={m.text}
        annotations={m.annotations}
        attachments={m.attachments}
        tools={m.tools}
        {...(m.role === 'user' ? { onEdit: (t: string) => void sendUserMessage(t) } : {})}
        {...(prev ? { onRetry: () => void sendUserMessage(prev.text, prev.attachments) } : {})}
      />
    );
  };

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
        {virtual ? (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const m = messages[v.index] as UiMessage;
              return (
                <div
                  key={m.id}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  data-message-id={m.id}
                  className="absolute inset-x-0 top-0 pb-6"
                  style={{
                    transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  {view(m, v.index)}
                </div>
              );
            })}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={m.id} data-message-id={m.id}>
              {view(m, i)}
            </div>
          ))
        )}
        {memoryChip && <MemoryChipRow chip={memoryChip} />}
        {!stream && !running && related.length > 0 && (
          <nav
            aria-label="Liittyvät keskustelut"
            className="flex flex-wrap items-center gap-2 text-secondary text-fg-muted"
          >
            Liittyvät keskustelut:
            {related.slice(0, 3).map((r) => (
              <button
                key={r.chatId}
                type="button"
                onClick={() => openChat(r.chatId)}
                className="h-8 max-w-60 truncate rounded-md border border-border px-3 hover:bg-bg-sunken hover:text-fg max-md:h-11"
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
          <div className="min-h-6">
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
              <span
                role="status"
                aria-label="Vastaus tulossa"
                className="flex h-6 items-center gap-1"
              >
                {[0, 150, 300].map((d) => (
                  <span
                    key={d}
                    style={{ animationDelay: `${d}ms` }}
                    className="size-2 animate-pulse rounded-full bg-fg-muted"
                  />
                ))}
              </span>
            )}
          </div>
        )}
        {approvals.map((a) => (
          <ApprovalCard key={a.requestId} a={a} />
        ))}
      </div>
    </div>
  );
}
