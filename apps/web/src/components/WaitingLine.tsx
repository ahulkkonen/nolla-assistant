import { Fragment, useEffect, useReducer } from 'react';
import { cn } from '@/lib/utils';
import { useStore } from '../store.ts';
import { duration, receiptSteps, type Step, type Timing, waitSteps } from '../thread.ts';

const cap = (w: string) => (w[0]?.toUpperCase() ?? '') + w.slice(1);

/**
 * Phase 26 ("Vaiheet"): steps joined by arrows in meta 13/18, muted. The active step is in
 * `--foreground` with a slow highlight across its word (1.8 s); with reduced motion only the
 * colour marks it. The first word starts with a capital letter.
 */
function PhaseLine({ steps }: { steps: Step[] }) {
  return (
    <span className="flex items-center gap-1.5 text-meta whitespace-nowrap text-muted-foreground tabular-nums">
      {steps.map((s, i) => (
        <Fragment key={s.k}>
          {i > 0 && (
            <>
              <span className="sr-only">,</span>
              <span aria-hidden="true">→</span>
            </>
          )}
          <span className={cn(s.on && 'text-foreground')}>
            <span className={cn('inline-block', s.on && 'sweep')}>{i ? s.word : cap(s.word)}</span>
            {s.ms !== undefined && ` ${duration(s.ms)}`}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** A re-render every 500 ms while `on`: the counted seconds change once a second. */
function useTick(on: boolean) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [on]);
}

/**
 * The running chat's waiting line, counted on the client: the turn's first line before the first
 * token, or (`row`) the action row's line from the first token on. Visual only: `WaitStatus`
 * tells screen readers the step changes.
 */
export function LiveWait({ chatId, row = false }: { chatId: string; row?: boolean }) {
  const wait = useStore((s) => s.waits[chatId]);
  useTick(!!wait);
  if (!wait) return null;
  return <PhaseLine steps={waitSteps(wait, Date.now(), row)} />;
}

/** The active step's word for screen readers: step changes only, never the seconds. */
export function WaitStatus({ chatId }: { chatId: string }) {
  const word = useStore((s) => {
    const w = s.waits[chatId];
    return w ? waitSteps(w, 0).find((x) => x.on)?.word : undefined;
  });
  return (
    <span role="status" aria-label="Vastaus tulossa" className="sr-only">
      {word && cap(word)}
    </span>
  );
}

/** A finished reply's receipt: "Jonotti 14 s → ajatteli 3 s → kirjoitti 3 s". */
export function Receipt({ timing }: { timing: Timing }) {
  const steps = receiptSteps(timing);
  return steps.length ? <PhaseLine steps={steps} /> : null;
}
