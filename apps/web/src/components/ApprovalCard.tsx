import { useEffect, useState } from 'react';
import { type Approval, useStore } from '../store.ts';
import { respondApproval } from '../ws.ts';

const LONG = 160;

function Value({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > LONG;
  return (
    <dd className="min-w-0 font-mono text-secondary break-words whitespace-pre-wrap">
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

/** The real (unmasked) arguments of a gated tool call, with approve and deny. */
export function ApprovalCard({ a }: { a: Approval }) {
  // Expired requests are denied by the server; drop the card at the same moment.
  useEffect(() => {
    const t = setTimeout(
      () => useStore.getState().dropApproval(a.requestId),
      Math.max(0, Date.parse(a.expiresAt) - Date.now()),
    );
    return () => clearTimeout(t);
  }, [a.requestId, a.expiresAt]);
  const args =
    a.args && typeof a.args === 'object' && !Array.isArray(a.args)
      ? Object.entries(a.args)
      : [['', a.args] as const];

  return (
    <section
      aria-label={`Hyväksyntä: ${a.tool}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-bg-raised p-4"
    >
      <h2 className="font-medium">
        Hyväksytäänkö työkalu <span className="font-mono">{a.tool}</span>?
      </h2>
      {a.reason && <p className="text-secondary text-fg-muted">{a.reason}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {args.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-secondary text-fg-muted">{k}</dt>
            <Value text={show(v)} />
          </div>
        ))}
      </dl>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => respondApproval(a.requestId, false)}
          className="h-10 rounded-md border border-border px-4 font-medium hover:bg-bg-sunken"
        >
          Hylkää
        </button>
        <button
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
