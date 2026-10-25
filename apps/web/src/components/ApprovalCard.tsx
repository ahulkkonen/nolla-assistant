import { Clock } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { type Approval, useStore } from '../store.ts';
import { respondApproval } from '../ws.ts';

const LONG = 160;

function Value({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > LONG;
  return (
    <dd className="min-w-0 flex-1 font-mono text-secondary break-words whitespace-pre-wrap">
      {long && !more ? `${text.slice(0, LONG)}…` : text}
      {long && (
        <button
          type="button"
          onClick={() => setMore(!more)}
          className="ml-2 font-sans text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          {more ? 'Näytä vähemmän' : 'Näytä lisää'}
        </button>
      )}
    </dd>
  );
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });

/** The real (unmasked) arguments of a gated tool call, with approve and deny. */
export function ApprovalCard({ a }: { a: Approval }) {
  const titleId = useId();
  const approve = useRef<HTMLButtonElement>(null);
  // The server denies at `expiresAt`; the card turns into the expired row at the same moment.
  useEffect(() => {
    if (a.expired) return;
    const t = setTimeout(
      () => useStore.getState().expireApproval(a.requestId),
      Math.max(0, Date.parse(a.expiresAt) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [a.requestId, a.expiresAt, a.expired]);
  useEffect(() => {
    if (!a.expired) approve.current?.focus();
  }, [a.expired]);

  if (a.expired)
    return (
      <p className="flex items-center gap-2 text-secondary text-fg-muted">
        <Clock size={16} />
        Hyväksyntä vanheni: <span className="font-mono">{a.tool}</span>
      </p>
    );

  const args =
    a.args && typeof a.args === 'object' && !Array.isArray(a.args)
      ? Object.entries(a.args)
      : [['', a.args] as const];
  const reason = a.reason !== `Työkalu ${a.tool} vaatii hyväksynnän.` ? a.reason : '';

  return (
    <section
      role="alertdialog"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-raised p-4"
    >
      <h2 id={titleId} aria-live="assertive" className="font-medium">
        Hyväksytäänkö työkalu <span className="font-mono">{a.tool}</span>?
      </h2>
      {reason && <p className="text-secondary text-fg-muted">{reason}</p>}
      <dl className="flex flex-col gap-1">
        {args.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-24 shrink-0 truncate font-mono text-secondary text-fg-muted">{k}</dt>
            <Value text={show(v)} />
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto text-secondary text-fg-muted">Vanhenee klo {clock(a.expiresAt)}</p>
        <button
          type="button"
          onClick={() => respondApproval(a.requestId, false)}
          className="h-10 rounded-md border border-border px-4 font-medium hover:bg-bg-sunken"
        >
          Hylkää
        </button>
        <button
          ref={approve}
          type="button"
          onClick={() => respondApproval(a.requestId, true)}
          className="h-10 rounded-md bg-accent px-4 font-medium text-accent-fg"
        >
          Hyväksy
        </button>
      </div>
    </section>
  );
}
