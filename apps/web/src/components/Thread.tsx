import { useEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { MessageView } from './MessageView.tsx';

const EMPTY: never[] = [];

export function Thread() {
  const chatId = useStore((s) => s.activeChatId);
  const messages = useStore((s) => (chatId ? (s.messages[chatId] ?? EMPTY) : EMPTY));
  const stream = useStore((s) => (chatId ? s.streaming[chatId] : undefined));
  const running = useStore((s) => (chatId ? s.agentStatus[chatId] === 'running' : false));
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the bottom while the user has not scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream?.text, stream?.tools, running]);

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
          <MessageView
            key={m.id}
            role={m.role}
            text={m.text}
            attachments={m.attachments}
            tools={m.tools}
          />
        ))}
        {(stream || running) && (
          <div className="min-h-6">
            {stream?.text || stream?.tools.length ? (
              <MessageView role="assistant" text={stream.text} tools={stream.tools} live />
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
