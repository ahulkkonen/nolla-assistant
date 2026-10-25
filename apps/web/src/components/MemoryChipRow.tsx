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
    <div className="flex flex-col gap-1 text-meta text-muted-foreground">
      {/* Phones: status and link on the first line, the change below; one line on wider screens. */}
      <p className="flex flex-wrap items-center gap-x-2">
        <span>
          {chip.kind === 'pending' ? 'Muistikirjoitus odottaa hyväksyntää' : 'Muisti päivitetty'}
        </span>
        {(first || rest.length > 0) && (
          <span className="flex min-w-0 items-baseline gap-2 max-md:order-last max-md:basis-full">
            {first && (
              <span className="flex min-w-0 max-w-full items-baseline truncate rounded-sm bg-muted px-1 font-mono">
                <Line line={first} />
              </span>
            )}
            {rest.length > 0 && (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="shrink-0 underline underline-offset-2 hover:text-foreground max-md:min-h-11"
              >
                {open ? 'Näytä vähemmän' : `+${rest.length} muuta`}
              </button>
            )}
          </span>
        )}
        <button
          type="button"
          onClick={() => useStore.getState().setScreen('memory')}
          className="inline-flex items-center underline underline-offset-2 hover:text-foreground max-md:min-h-11"
        >
          Avaa muisti
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
