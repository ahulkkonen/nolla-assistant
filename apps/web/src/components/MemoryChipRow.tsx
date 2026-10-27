import { Brain } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { type ClaimChip, type MemoryChip, useStore } from '../store.ts';
import { send } from '../ws.ts';
import { DiffLine } from './MemoryScreen.tsx';

const SHOWN = 3;

/**
 * Under the last message after an agent memory write (brief 7.5): a 32 px row with the status
 * and "Avaa muisti", the changed lines below in the diff style.
 */
export function MemoryChipRow({ chip }: { chip: MemoryChip }) {
  const [open, setOpen] = useState(false);
  const lines = open ? chip.lines : chip.lines.slice(0, SHOWN);
  const hidden = chip.lines.length - SHOWN;
  return (
    <div className="flex flex-col gap-1">
      <p className="flex min-h-8 flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
        <Brain size={16} className="shrink-0" />
        <span>
          {chip.kind === 'pending' ? 'Muistikirjoitus odottaa hyväksyntää' : 'Muisti päivitetty'}
        </span>
        <Button
          variant="link"
          className="text-meta max-md:min-h-11"
          onClick={() => useStore.getState().setScreen('memory')}
        >
          Avaa muisti
        </Button>
      </p>
      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 font-mono text-[13px] leading-5">
          {lines.map((l) => (
            <DiffLine key={l} sign={l[0] ?? ' '} text={l.slice(1)} />
          ))}
        </div>
      )}
      {hidden > 0 && (
        <Button
          variant="link"
          aria-expanded={open}
          className="self-start text-meta max-md:min-h-11"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Näytä vähemmän' : `+${hidden} muuta`}
        </Button>
      )}
    </div>
  );
}

/**
 * The same row for claims extraction activated at once (phase 17): "Muisti: <text>" with
 * "Kumoa" per claim (`claims.review` reject, the undo of an `auto` claim) and "Avaa muisti".
 */
export function ClaimChipRow({ chatId, claims }: { chatId: string; claims: ClaimChip[] }) {
  const undo = (id: number) => {
    send({ type: 'claims.review', id, action: 'reject' });
    useStore.setState((st) => ({
      claimChips: {
        ...st.claimChips,
        [chatId]: (st.claimChips[chatId] ?? []).filter((c) => c.id !== id),
      },
    }));
  };
  return (
    <ul className="flex flex-col" aria-label="Uudet havainnot">
      {claims.map((c, i) => (
        <li
          key={c.id}
          className="flex min-h-8 flex-wrap items-center gap-x-2 text-meta text-muted-foreground"
        >
          <Brain size={16} className="shrink-0" />
          <span className="min-w-0">
            Muisti: <span className="text-foreground">{c.text}</span>
          </span>
          <Button
            variant="link"
            aria-label={`Kumoa: ${c.text}`}
            className="text-meta max-md:min-h-11"
            onClick={() => undo(c.id)}
          >
            Kumoa
          </Button>
          {i === claims.length - 1 && (
            <Button
              variant="link"
              className="text-meta max-md:min-h-11"
              onClick={() => useStore.getState().setScreen('memory')}
            >
              Avaa muisti
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
