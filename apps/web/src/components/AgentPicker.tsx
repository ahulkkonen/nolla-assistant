import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useMobile } from '../media.ts';
import { useStore } from '../store.ts';
import { Tip } from './IconButton.tsx';

const chip = 'h-8 rounded-full px-3 font-normal text-muted-foreground max-md:h-11';

/** The agent of the open chat, or the pending agent of a new chat. */
export function useAgent() {
  const chatId = useStore((s) => s.activeChatId);
  const chatAgent = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.agentId);
  const pending = useStore((s) => s.pendingAgentId);
  const agents = useStore((s) => s.agents);
  const current = chatId ? (chatAgent ?? 'assistant') : pending;
  return { chatId, agents, current, name: agents.find((a) => a.id === current)?.name ?? current };
}

/** Composer chip: picks the agent for a new chat; an existing chat keeps its agent. */
export function AgentPicker() {
  const { chatId, agents, current, name } = useAgent();
  const mobile = useMobile();
  const label = (
    <>
      <span className="sr-only">Agentti: </span>
      {name}
    </>
  );

  // Phones, started chat: no chip; the model sheet names the agent on its first line.
  // An sr-only name keeps the agent reachable while a run disables the sheet.
  if (chatId && mobile) return <span className="sr-only">Agentti: {name}</span>;
  if (chatId)
    return (
      <Tip label="Agentti valitaan uuden keskustelun alussa">
        <Button
          variant="ghost"
          aria-disabled="true"
          className={`${chip} cursor-not-allowed hover:bg-transparent hover:text-muted-foreground`}
        >
          {label}
        </Button>
      </Tip>
    );
  // Not modal: a modal menu hides the page from assistive technology (axe `aria-hidden-focus`).
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className={`${chip} hover:text-foreground`}>
          {label}
          <ChevronDown size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" collisionPadding={8} className="w-[260px]">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(id) => useStore.getState().setPendingAgentId(id)}
        >
          {agents.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id} className="py-2">
              <span className="flex min-w-0 flex-col">
                {a.name}
                {/* Profiles have no description field; the model and subagents describe it. */}
                <span className="truncate text-meta text-muted-foreground">
                  {a.model} · {a.subagents ? 'aliagentit käytössä' : 'ei aliagentteja'}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
