import { Badge } from '@/components/ui/badge';
import { useStore } from '../store.ts';
import { ListSkeleton, Page } from './Page.tsx';

export const AGENTS_TITLE = 'Agentit';

/** Read-only list (phase 7): agents are files in `agents/`. Rows 56 h with dividers (7.5). */
export function AgentsScreen() {
  const agents = useStore((s) => s.agents);
  return (
    <Page title={AGENTS_TITLE}>
      <section className="flex flex-col">
        <ListSkeleton loading={!agents.length} />
        <ul className="flex flex-col divide-y divide-border border-y max-md:border-t-0">
          {agents.map((a) => (
            <li key={a.id} className="flex min-h-14 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.name}</div>
                <div className="truncate text-meta text-muted-foreground">
                  <span className="font-mono">{a.id}</span> · {a.model}
                </div>
              </div>
              <Badge variant={a.subagents ? 'info' : 'secondary'}>
                {a.subagents ? 'aliagentit käytössä' : 'ei aliagentteja'}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="pt-4 text-meta text-muted-foreground">
          Agentit ovat tiedostoja kansiossa <span className="font-mono">agents/</span>. Muokkaa
          niitä siellä.
        </p>
      </section>
    </Page>
  );
}
