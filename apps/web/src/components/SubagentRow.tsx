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
  const active = items.filter((c) => c.status === 'queued' || c.status === 'running').length;
  const failed = items.some((c) => c.status === 'error');
  const { Icon } = STATUS[active ? 'running' : failed ? 'error' : 'done'];
  const text = active
    ? `${active} aliagenttia käynnissä`
    : `${items.length} aliagenttia valmis${failed ? ', virheitä' : ''}`;
  return (
    <div className="text-secondary text-fg-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex max-w-full items-center gap-2 rounded-sm py-1 hover:text-fg"
      >
        <Icon size={16} className={active ? 'animate-spin' : undefined} />
        <span>{text}</span>
        <ChevronRight
          size={16}
          className={`transition-transform duration-(--duration) ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <ul className="mt-1 mb-2 flex flex-col gap-1 rounded-md bg-bg-sunken p-3">
          {items.map((c) => {
            const s = STATUS[c.status];
            return (
              <li key={c.id} className="flex items-center gap-2">
                <s.Icon size={16} className={c.status === 'running' ? 'animate-spin' : undefined} />
                <span className="min-w-0 flex-1 truncate text-fg">{c.label}</span>
                <span>{s.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
