import { clsx } from 'clsx';
import { useState } from 'react';
import { type MemoryChip, useStore } from '../store.ts';

function Line({ line }: { line: string }) {
  const removed = line.startsWith('-');
  return (
    <span className={clsx('min-w-0', removed && 'line-through')}>
      <span className="sr-only">{removed ? 'poistettu: ' : 'lisätty: '}</span>
      <span aria-hidden>{removed ? '− ' : '+ '}</span>
      {line.slice(1)}
    </span>
  );
}

/** Under the last message after an agent memory write: what changed, inline, plus a link. */
export function MemoryChipRow({ chip }: { chip: MemoryChip }) {
  const [open, setOpen] = useState(false);
  const [first, ...rest] = chip.lines;
  return (
    <div className="flex flex-col gap-1 text-secondary text-fg-muted">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span>
          {chip.kind === 'pending' ? 'Muistikirjoitus odottaa hyväksyntää' : 'Muisti päivitetty'}
        </span>
        {first && (
          <span className="flex min-w-0 max-w-full items-baseline truncate rounded-sm bg-bg-sunken px-1 font-mono">
            <Line line={first} />
          </span>
        )}
        {rest.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="underline underline-offset-2 hover:text-fg"
          >
            {open ? 'Näytä vähemmän' : `+${rest.length} muuta`}
          </button>
        )}
        <button
          type="button"
          onClick={() => useStore.getState().setScreen('memory')}
          className="underline underline-offset-2 hover:text-fg"
        >
          Muisti
        </button>
      </p>
      {open && (
        <ul className="flex flex-col gap-1 font-mono">
          {rest.map((l) => (
            <li key={l} className="break-words">
              <Line line={l} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
