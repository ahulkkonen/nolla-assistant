import { useStore } from '../store.ts';

export const AGENTS_TITLE = 'Agentit';

/** Read-only list; profiles are edited as files until phase 7. */
export function AgentsScreen() {
  const agents = useStore((s) => s.agents);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-6">
        <h1 className="font-semibold max-md:hidden">{AGENTS_TITLE}</h1>
        <ul className="flex flex-col">
          {agents.map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-t border-border py-2">
              <div className="min-w-0 flex-1">
                <div>{a.name}</div>
                <div className="truncate text-meta text-muted-foreground">
                  <span className="font-mono">{a.id}</span> · {a.model} · aliagentit{' '}
                  {a.subagents ? 'käytössä' : 'ei käytössä'}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-meta text-muted-foreground">Muokkaa tiedostoja kansiossa agents/.</p>
      </div>
    </div>
  );
}
