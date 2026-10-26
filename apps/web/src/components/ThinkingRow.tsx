import { Lightbulb, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { duration, thoughtFor } from '../thread.ts';
import { loadThinking } from '../ws.ts';
import { annotate } from './MessageView.tsx';
import { useSlow } from './Page.tsx';
import { CollapsibleRow } from './ToolRow.tsx';

const line =
  'flex h-8 items-center gap-2 text-meta text-muted-foreground tabular-nums max-md:min-h-11 [@media(pointer:coarse)]:min-h-11';

/**
 * The thinking row while the reply streams (phase-13 UI): "Ajattelee… 8 s" with a turning
 * spinner, counted here; once the thinking stops, "Ajatteli 12 s" until the message is final.
 * A status line, not a button: the text loads only from the final message.
 */
export function ThinkingLive({ startedAt, endedAt }: { startedAt: number; endedAt?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endedAt]);
  if (endedAt)
    return (
      <div className={line}>
        <Lightbulb size={16} className="shrink-0" />
        {thoughtFor(endedAt - startedAt)}
      </div>
    );
  return (
    <div className={line}>
      {/* Reduced motion: no turning, the text carries the state. */}
      <Loader2 size={16} className="shrink-0 animate-spin motion-reduce:animate-none" />
      Ajattelee… {duration(Math.max(0, now - startedAt))}
    </div>
  );
}

/**
 * "Ajatteli 12 s" (phase-13 UI): the tool row's trigger; the text loads on the first open and
 * stays, an error asks again on the next open. Masked spans as in the reply.
 */
export function ThinkingRow({
  chatId,
  messageId,
  ms,
}: {
  chatId: string;
  messageId: string;
  ms: number | null;
}) {
  const got = useStore((s) => s.thinkingText[messageId]);
  const [open, setOpen] = useState(false);
  const slow = useSlow(open && got?.state === 'loading');
  return (
    <CollapsibleRow
      icon={<Lightbulb size={16} className="shrink-0" />}
      label={<span className="tabular-nums">{thoughtFor(ms)}</span>}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && got?.state !== 'ok' && got?.state !== 'loading') loadThinking(chatId, messageId);
      }}
    >
      {got?.state === 'ok' ? (
        <div
          role="region"
          aria-label="Mallin ajattelu"
          // A scrollable region must be focusable (brief 7.8).
          tabIndex={0}
          className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-sans text-[14px] leading-[22px] break-words whitespace-pre-wrap text-muted-foreground"
        >
          {annotate(got.text, got.annotations)}
        </div>
      ) : got?.state === 'error' ? (
        <p className="text-meta text-muted-foreground">Ajattelua ei voitu näyttää.</p>
      ) : slow ? (
        <p className="text-meta text-muted-foreground">Ladataan…</p>
      ) : null}
    </CollapsibleRow>
  );
}
