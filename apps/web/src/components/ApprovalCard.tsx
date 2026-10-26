import { SEARCH_ENTITY_REASON, WEB_SEARCH_TOOL } from '@pa/protocol';
import { Clock, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type Approval, useStore } from '../store.ts';
import { respondApproval } from '../ws.ts';

/** An argument value: mono, clamped at 6 lines with a fade and "Näytä lisää" (brief 7.5). */
function Value({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !more) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, more]);
  return (
    <dd className="min-w-0">
      <div
        ref={ref}
        className={cn(
          'font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-foreground',
          !more && 'line-clamp-6',
          !more && clamped && '[mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
        )}
      >
        {text}
      </div>
      {(clamped || more) && (
        <Button variant="link" className="text-meta max-md:min-h-11" onClick={() => setMore(!more)}>
          {more ? 'Näytä vähemmän' : 'Näytä lisää'}
        </Button>
      )}
    </dd>
  );
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });

/**
 * The real (unmasked) arguments of a gated tool call, inline in the thread. Focus stays where it
 * is, so a typed Enter never approves; the thread announces the request (Thread.tsx). After a
 * decision the card goes and its tool row shows the outcome.
 */
export function ApprovalCard({ a }: { a: Approval }) {
  const titleId = useId();
  // The server denies at `expiresAt`; the tool row turns "vanhentunut" at the same moment.
  useEffect(() => {
    const t = setTimeout(
      () => useStore.getState().expireApproval(a.requestId),
      Math.max(0, Date.parse(a.expiresAt) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [a.requestId, a.expiresAt]);

  const args =
    a.args && typeof a.args === 'object' && !Array.isArray(a.args)
      ? Object.entries(a.args)
      : [['', a.args] as const];
  const reason = a.reason !== `Työkalu ${a.tool} vaatii hyväksynnän.` ? a.reason : '';
  // Phase 14: a search whose query names a vault entity; the reason is the title.
  const query = args.find(([k]) => k === 'query')?.[1];
  // Only the entity guard's card; anything else (`approval.always`) keeps the generic list.
  const search =
    a.tool === WEB_SEARCH_TOOL &&
    a.reason === SEARCH_ENTITY_REASON &&
    String(query ?? '').trim() !== '';

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-warning-line bg-card p-4"
    >
      <h2 id={titleId} className="flex items-center gap-2 text-heading">
        <ShieldAlert size={16} className="shrink-0 text-warning" />
        {search ? (
          <span>{a.reason}</span>
        ) : (
          <span>
            Hyväksytäänkö työkalu <span className="font-mono">{a.tool}</span>?
          </span>
        )}
      </h2>
      {reason && !search && <p className="text-meta text-muted-foreground">{reason}</p>}
      {search ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-2">
          <dt className="font-mono text-[13px] leading-5 text-muted-foreground">Haku:</dt>
          <Value text={show(query ?? '')} />
        </dl>
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          {args.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="max-w-32 truncate font-mono text-[13px] leading-5 text-muted-foreground">
                {k}
              </dt>
              <Value text={show(v)} />
            </div>
          ))}
        </dl>
      )}
      {search && (
        <p className="text-meta text-pretty text-muted-foreground">
          Kysely lähtee hakupalveluun sellaisenaan. Hylkää, niin avustaja hakee ilman henkilöä.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-2">
        <p className="mr-auto flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums max-md:col-span-2">
          <Clock size={16} />
          Vanhenee klo {clock(a.expiresAt)}
        </p>
        <Button variant="outline" onClick={() => respondApproval(a.requestId, false)}>
          Hylkää
        </Button>
        <Button onClick={() => respondApproval(a.requestId, true)}>Hyväksy</Button>
      </div>
    </section>
  );
}
