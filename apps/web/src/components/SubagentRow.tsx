import { Check, Clock, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SubagentChild } from '../store.ts';
import { CollapsibleRow } from './ToolRow.tsx';

/**
 * Status per child (brief 7.5): icon and badge, the badge's word in sentence case. Queued is an
 * outline: a `secondary` fill on the `--muted` list is 1.05:1 (light), 1.44:1 (dark).
 */
const STATUS = {
  queued: { Icon: Clock, icon: 'text-muted-foreground', text: 'Jonossa', badge: 'outline' },
  running: {
    Icon: Loader2,
    icon: 'animate-spin text-muted-foreground',
    text: 'Käynnissä',
    badge: 'info',
  },
  done: { Icon: Check, icon: 'text-success', text: 'Valmis', badge: 'success' },
  error: { Icon: X, icon: 'text-destructive', text: 'Virhe', badge: 'destructive' },
} as const;

/** A subagent run as a tool-row variant; expands to one 32 px row per child. */
export function SubagentRow({ items }: { items: SubagentChild[] }) {
  const count = (status: SubagentChild['status']) =>
    items.filter((c) => c.status === status).length;
  const [running, queued] = [count('running'), count('queued')];
  const active = running + queued;
  const failed = count('error') > 0;
  const head = STATUS[active ? 'running' : failed ? 'error' : 'done'];
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
    <CollapsibleRow
      icon={<head.Icon size={16} className={cn('shrink-0', head.icon)} />}
      label={<span>{text}</span>}
    >
      <ul className="flex flex-col rounded-md bg-muted p-1">
        {items.map((c) => {
          const s = STATUS[c.status];
          return (
            <li key={c.id} className="flex h-8 items-center gap-2 px-2 max-md:h-11">
              <s.Icon size={16} className={cn('shrink-0', s.icon)} />
              <span className="min-w-0 flex-1 truncate text-ui">{c.label}</span>
              <Badge variant={s.badge}>{s.text}</Badge>
            </li>
          );
        })}
      </ul>
    </CollapsibleRow>
  );
}
