import { type CallUsage, type FxRate, formatCost, formatTokens } from '@pa/protocol';
import { useStore } from '../store.ts';
import { fullTime, messageTime, tokensOf } from '../thread.ts';
import { modelLabel } from '../useModel.ts';
import { Tip } from './IconButton.tsx';

const count = new Intl.NumberFormat('fi');

/** The meta as one line of text, for the touch sheet (no tooltips there). */
export function metaText(createdAt: string, usage: CallUsage | undefined, fx: FxRate | null) {
  const time = messageTime(createdAt);
  if (!usage) return time;
  const cost = formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated });
  return `${time} · ${cost} · ${formatTokens(tokensOf(usage))}`;
}

/**
 * The action row meta (phase-13 UI): "klo 17.20 · 0,012 € · 3,4 k tokenia". The time's tooltip
 * gives the full date; the cost's gives the model, the token parts and an estimate's note.
 */
export function MessageMeta({
  createdAt,
  usage,
}: {
  createdAt: string;
  usage?: CallUsage | undefined;
}) {
  const fx = useStore((s) => s.fx);
  const catalog = useStore((s) => s.models?.catalog);
  const cache = usage ? usage.cacheRead + usage.cacheWrite : 0;
  return (
    <span className="ml-2 flex min-w-0 items-center gap-1 text-meta text-muted-foreground tabular-nums">
      <Tip label={fullTime(createdAt)}>
        {/* Focus shows the full date too. */}
        <time dateTime={createdAt} tabIndex={0} className="rounded-xs whitespace-nowrap">
          {messageTime(createdAt)}
        </time>
      </Tip>
      {usage && (
        <>
          <span aria-hidden="true">·</span>
          <Tip
            // Lines as text and <br>: an element inside the tooltip's hidden copy would sit
            // outside every landmark (axe `region`).
            label={
              <>
                Malli: {modelLabel(catalog, usage.model)}
                <br />
                Syöte {count.format(usage.input)}
                {cache > 0 && ` · välimuisti ${count.format(cache)}`} · tuloste{' '}
                {count.format(usage.output)}
                {usage.reasoning > 0 && ` (ajattelu ${count.format(usage.reasoning)})`}
                {usage.estimated && (
                  <>
                    <br />
                    Arvio hinnaston mukaan
                  </>
                )}
              </>
            }
          >
            <span tabIndex={0} className="rounded-xs whitespace-nowrap">
              {formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated })}
            </span>
          </Tip>
          <span aria-hidden="true">·</span>
          <span className="truncate">{formatTokens(tokensOf(usage))}</span>
        </>
      )}
    </span>
  );
}
