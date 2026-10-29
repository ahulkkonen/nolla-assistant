import {
  type CallUsage,
  type ChatUsage,
  type FxRate,
  formatCost,
  formatTokens,
} from '@pa/protocol';
import { useStore } from '../store.ts';
import { cacheRate, fullTime, messageTime, SEP, tokensOf, withRate } from '../thread.ts';
import { modelLabel } from '../useModel.ts';
import { Tip } from './IconButton.tsx';

const count = new Intl.NumberFormat('fi');

/** "3,4 k tokenia · välimuisti 82 %"; the rate only when the call had prompt tokens. */
const tokenText = (u: CallUsage) => withRate(formatTokens(tokensOf(u)), u);

/** The meta as one line of text, for the touch sheet (no tooltips there). */
export function metaText(createdAt: string, usage: CallUsage | undefined, fx: FxRate | null) {
  const time = messageTime(createdAt);
  if (!usage) return time;
  const cost = formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated });
  return [time, cost, tokenText(usage)].join(SEP);
}

/**
 * The action row meta (phase-13 UI): "klo 17.20 · 0,012 € · 3,4 k tokenia · välimuisti 82 %" (the
 * cache hit rate is phase 16; phones leave it to the long-press sheet). The row ends on a whole
 * item: each item keeps its "·" and wraps whole to a second line that the one-line box hides; its
 * 4 px padding keeps the focus ring. The time's tooltip gives the full date; the cost's gives the
 * model, the token parts and an estimate's note.
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
  const rate = cacheRate(usage);
  return (
    <span className="-my-1 ml-1 flex h-[26px] min-w-0 flex-wrap items-center gap-x-1 gap-y-2 overflow-hidden p-1 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
      <Tip label={fullTime(createdAt)}>
        {/* Focus shows the full date too. */}
        <time dateTime={createdAt} {...tab} className="rounded-xs">
          {messageTime(createdAt)}
        </time>
      </Tip>
      {usage && (
        <>
          <span className="flex gap-1">
            <span aria-hidden="true">·</span>
            <Tip
              // Lines as text and <br>: an element inside the tooltip's hidden copy would sit
              // outside every landmark (axe `region`). One token part per line, in a block box (the
              // kit's tooltip is a flex row): no orphan word.
              className="block"
              // Latest reply: below the action row, not over the reply text (UI review 3).
              {...(focusable ? { side: 'bottom' as const, sideOffset: 8 } : {})}
              label={
                <>
                  Malli: {modelLabel(catalog, usage.model)}
                  <br />
                  Syöte: {count.format(usage.input)}
                  {cache > 0 && (
                    <>
                      <br />
                      Välimuisti: {count.format(cache)}
                    </>
                  )}
                  <br />
                  Tuloste: {count.format(usage.output)}
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
              <span {...tab} className="rounded-xs">
                {formatCost(usage.costUsd, fx, { reply: true, estimated: usage.estimated })}
              </span>
            </Tip>
          </span>
          <span className="flex gap-1">
            <span aria-hidden="true">·</span>
            {formatTokens(tokensOf(usage))}
          </span>
          {rate && (
            <span className="flex gap-1 max-md:hidden">
              <span aria-hidden="true">·</span>
              {`välimuisti\u00a0${rate}`}
            </span>
          )}
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
  // The opened chat's own summary first: it exists also for a chat outside the loaded list.
  const usage = useStore((s) =>
    s.activeChatId
      ? (s.summaries[s.activeChatId] ?? s.chats.find((c) => c.id === s.activeChatId))?.usage
      : undefined,
  );
  const fx = useStore((s) => s.fx);
  if (!usage?.tokens) return null;
  const rate = cacheRate(usage);
  // Label, value, unit: the units get their own column.
  const rows: [string, string, string][] = [
    ...(usage.input !== undefined
      ? ([
          ['Syöte', count.format(usage.input), 'tokenia'],
          ['Välimuistista luettu', count.format(usage.cacheRead ?? 0), 'tokenia'],
          ['Välimuistiin kirjoitettu', count.format(usage.cacheWrite ?? 0), 'tokenia'],
          ['Tuloste', count.format(usage.output ?? 0), 'tokenia'],
        ] as [string, string, string][])
      : []),
    ...(rate
      ? ([['Osumaosuus', rate.replace(/\s%$/, ''), '%']] as [string, string, string][])
      : []),
    // The cost with its currency in the unit column.
    [
      'Hinta',
      formatCost(usage.costUsd, fx, { reply: true }).replace(/\s*[€$]$/, ''),
      fx ? '€' : '$',
    ],
  ];
  // Only dollars need a word: no ECB rate yet.
  const note = fx ? undefined : 'Dollareina: euromuunnos ei ole saatavilla';
  return (
    <Tip
      // Below the header, aligned to its right edge.
      side="bottom"
      align="end"
      // Screen readers get the same rows as one text (the grid lives in the visible copy only).
      ariaLabel={[...rows.map(([k, v, u]) => `${k} ${v} ${u}`), ...(note ? [note] : [])].join(', ')}
      className="px-3 py-2"
      label={
        // The visible layout only; the tooltip's text for screen readers is `ariaLabel`.
        <span aria-hidden="true" className="grid grid-cols-[auto_auto_auto] gap-x-2 tabular-nums">
          {rows.map(([k, v, u]) => (
            <span key={k} className="contents">
              <span className="pr-2">{k}</span>
              <span className="text-right">{v}</span>
              <span>{u}</span>
            </span>
          ))}
          {note && <span className="col-span-3 pt-2">{note}</span>}
        </span>
      }
    >
      <span
        tabIndex={0}
        className="ml-auto shrink-0 rounded-xs text-meta whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {chatTotal(usage, fx)}
      </span>
    </Tip>
  );
}
