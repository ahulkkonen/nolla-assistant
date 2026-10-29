import { Lightbulb } from 'lucide-react';
import { useMemo, useState } from 'react';
import { thinkingKey, useStore } from '../store.ts';
import { messageTime, thoughtFor } from '../thread.ts';
import { loadThinking } from '../ws.ts';
import { annotate } from './MessageView.tsx';
import { useSlow } from './Page.tsx';
import { CollapsibleRow } from './ToolRow.tsx';

const line =
  'flex h-8 items-center gap-2 text-meta text-muted-foreground tabular-nums max-md:min-h-11 [@media(pointer:coarse)]:min-h-11';

/**
 * The thinking row of a streaming reply once its thinking stopped (phase-13 UI): "Ajatteli 12 s"
 * until the message is final. A status line, not a button: the text loads only from the final
 * message. Phase 26: while the model thinks, the waiting line says so ("ajattelee 8 s").
 */
export function ThoughtRow({ ms }: { ms: number }) {
  return (
    <div className={line}>
      <Lightbulb size={16} className="shrink-0" />
      {thoughtFor(ms)}
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
  createdAt,
}: {
  chatId: string;
  messageId: string;
  ms: number | null;
  /** The reply's time: it names the open region, so two open rows differ. */
  createdAt: string;
}) {
  const got = useStore((s) => s.thinkingText[thinkingKey(chatId, messageId)]);
  const [open, setOpen] = useState(false);
  const slow = useSlow(open && got?.state === 'loading');
  const shown = useMemo(
    () => (got?.state === 'ok' ? annotate(got.text, got.annotations) : null),
    [got],
  );
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
          aria-label={`Mallin ajattelu, ${messageTime(createdAt)}`}
          // A scrollable region must be focusable (brief 7.8); the find bar searches it open.
          tabIndex={0}
          data-find
          className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-sans text-[14px] leading-[22px] break-words whitespace-pre-wrap text-muted-foreground"
        >
          {shown}
        </div>
      ) : got?.state === 'error' ? (
        <p className="text-meta text-muted-foreground">Ajattelua ei voitu näyttää.</p>
      ) : slow ? (
        <p className="text-meta text-muted-foreground">Ladataan…</p>
      ) : null}
    </CollapsibleRow>
  );
}
