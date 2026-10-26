import {
  type CallUsage,
  type ChatUsage,
  type FxRate,
  formatCost,
  formatTokens,
} from '@pa/protocol';
import { useStore } from '../store.ts';
import { cacheRate, fullTime, messageTime, tokensOf } from '../thread.ts';
import { modelLabel } from '../useModel.ts';
import { Tip } from './IconButton.tsx';

const count = new Intl.NumberFormat('fi');

/** "3,4 k tokenia · välimuisti 82 %"; the rate only when the call had prompt tokens. */
const tokenText = (u: CallUsage) => {
  const rate = cacheRate(u);
  return `${formatTokens(tokensOf(u))}${rate ? ` · välimuisti ${rate}` : ''}`;
};

/** The meta as one line of text, for the touch sheet (no tooltips there). */
export function metaText(createdAt: string, usage: CallUsage | undefined, fx: FxRate | null) {
  const time = messageTime(createdAt);
  if (!usage) return time;
  const cost = formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated });
  return `${time} · ${cost} · ${tokenText(usage)}`;
}

/**
 * The action row meta (phase-13 UI): "klo 17.20 · 0,012 € · 3,4 k tokenia · välimuisti 82 %" (the
 * cache hit rate is phase 16). The time's tooltip
 * gives the full date; the cost's gives the model, the token parts and an estimate's note.
 */
export function MessageMeta({
  createdAt,
  usage,
  focusable = false,
}: {
  createdAt: string;
  usage?: CallUsage | undefined;
  /** Tab stops only under the latest reply; others show their tooltips on hover. */
  focusable?: boolean;
}) {
  const tab = focusable ? { tabIndex: 0 } : {};
  const fx = useStore((s) => s.fx);
  const catalog = useStore((s) => s.models?.catalog);
  const cache = usage ? usage.cacheRead + usage.cacheWrite : 0;
  return (
    <span className="ml-2 flex min-w-0 items-center gap-1 text-meta text-muted-foreground tabular-nums">
      <Tip label={fullTime(createdAt)}>
        {/* Focus shows the full date too. */}
        <time dateTime={createdAt} {...tab} className="rounded-xs whitespace-nowrap">
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
            <span {...tab} className="rounded-xs whitespace-nowrap">
              {formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated })}
            </span>
          </Tip>
          <span aria-hidden="true">·</span>
          <span className="truncate">{tokenText(usage)}</span>
        </>
      )}
    </span>
  );
}

/** A chat's totals, "0,42 € · 18 k tokenia": the chat menu line and the desktop header. */
export const chatTotal = (u: ChatUsage, fx: FxRate | null) =>
  `${formatCost(u.costUsd, fx, { reply: true })} · ${formatTokens(u.tokens)}`;

/**
 * The open chat's cost in the desktop header (phase 16), from `ChatSummary.usage`, which
 * `chat.state` and `chat.updated` refresh. The tooltip gives the token parts and the cache rate.
 */
export function ChatCost() {
  const usage = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.usage);
  const fx = useStore((s) => s.fx);
  if (!usage?.tokens) return null;
  const rate = cacheRate(usage);
  return (
    <Tip
      label={
        <>
          {usage.input !== undefined && (
            <>
              Syöte {count.format(usage.input)} · välimuistista {count.format(usage.cacheRead ?? 0)}{' '}
              · välimuistiin {count.format(usage.cacheWrite ?? 0)} · tuloste{' '}
              {count.format(usage.output ?? 0)}
              <br />
            </>
          )}
          {rate && (
            <>
              Välimuisti {rate}
              <br />
            </>
          )}
          {fx ? 'Euroina EKP:n kurssilla' : 'Dollareina: euromuunnos ei ole saatavilla'}
        </>
      }
    >
      <span
        tabIndex={0}
        className="shrink-0 rounded-xs text-meta whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {chatTotal(usage, fx)}
      </span>
    </Tip>
  );
}
