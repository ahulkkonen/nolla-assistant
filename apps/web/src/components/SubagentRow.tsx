import { Check, ChevronRight, Clock, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import type { SubagentChild } from '../store.ts';

const STATUS = {
  queued: { Icon: Clock, text: 'jonossa' },
  running: { Icon: LoaderCircle, text: 'käynnissä' },
  done: { Icon: Check, text: 'valmis' },
  error: { Icon: X, text: 'virhe' },
} as const;

/** One collapsed line for a subagent run, styled like a tool row; expands to each child. */
export function SubagentRow({ items }: { items: SubagentChild[] }) {
  const [open, setOpen] = useState(false);
  const count = (status: SubagentChild['status']) =>
    items.filter((c) => c.status === status).length;
  const [running, queued] = [count('running'), count('queued')];
  const active = running + queued;
  const failed = count('error') > 0;
  const { Icon } = STATUS[active ? 'running' : failed ? 'error' : 'done'];
  const noun = (n: number) => (n === 1 ? 'aliagentti' : 'aliagenttia');
  // The noun goes with the first count only: "1 aliagentti käynnissä, 2 jonossa".
  const text = active
    ? [
        running && `${running} ${noun(running)} käynnissä`,
        queued && (running ? `${queued} jonossa` : `${queued} ${noun(queued)} jonossa`),
      ]
        .filter(Boolean)
        .join(', ')
    : `${items.length} aliagenttia valmiina${failed ? ', virheitä' : ''}`;
  return (
    <div className="text-meta text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-full items-center gap-2 rounded-sm py-1 hover:text-foreground max-md:min-h-11"
      >
        <Icon size={16} className={active ? 'animate-spin' : undefined} />
        <span>{text}</span>
        <ChevronRight
          size={16}
          className={`transition-transform duration-(--duration) ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <ul className="mt-1 mb-2 flex flex-col gap-1 rounded-md bg-muted p-3">
          {items.map((c) => {
            const s = STATUS[c.status];
            return (
              <li key={c.id} className="flex items-center gap-2">
                <s.Icon size={16} className={c.status === 'running' ? 'animate-spin' : undefined} />
                <span className="min-w-0 flex-1 truncate text-foreground">{c.label}</span>
                <span>{s.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
