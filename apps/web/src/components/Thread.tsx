import { useEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { openChat } from '../ws.ts';
import { MessageView } from './MessageView.tsx';

const EMPTY: never[] = [];

export function Thread() {
  const chatId = useStore((s) => s.activeChatId);
  const messages = useStore((s) => (chatId ? (s.messages[chatId] ?? EMPTY) : EMPTY));
  const stream = useStore((s) => (chatId ? s.streaming[chatId] : undefined));
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const related = useStore((s) => (chatId ? s.related[chatId] : undefined)) ?? EMPTY;
  const scrollTo = useStore((s) => s.scrollTo);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the bottom while the user has not scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.text, stream?.tools, running]);

  // A search hit opens at its message once the chat's messages are in.
  useEffect(() => {
    if (!scrollTo) return;
    const el = scroller.current?.querySelector(`[data-message-id="${CSS.escape(scrollTo)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    pinned.current = false;
    useStore.getState().setScrollTo(null);
  }, [messages, scrollTo]);

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
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id}>
            <MessageView
              role={m.role}
              text={m.text}
              annotations={m.annotations}
              attachments={m.attachments}
              tools={m.tools}
            />
          </div>
        ))}
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
                className="h-8 max-w-60 truncate rounded-md border border-border px-3 hover:bg-bg-sunken hover:text-fg"
              >
                {r.title || 'Nimetön keskustelu'}
              </button>
            ))}
          </nav>
        )}
        {(stream || running) && (
          <div className="min-h-6">
            {stream?.text || stream?.tools.length ? (
              <MessageView
                role="assistant"
                text={stream.text}
                annotations={stream.annotations}
                tools={stream.tools}
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
      </div>
    </div>
  );
}
