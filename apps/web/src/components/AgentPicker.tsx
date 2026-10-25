import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '../store.ts';
import { Tip } from './IconButton.tsx';

const chip = 'h-8 rounded-full px-3 font-normal text-muted-foreground max-md:h-11';

/** Composer chip: picks the agent for a new chat; an existing chat keeps its agent. */
export function AgentPicker() {
  const chatId = useStore((s) => s.activeChatId);
  const chatAgent = useStore((s) => s.chats.find((c) => c.id === s.activeChatId)?.agentId);
  const pending = useStore((s) => s.pendingAgentId);
  const agents = useStore((s) => s.agents);
  const current = chatId ? (chatAgent ?? 'assistant') : pending;
  const name = agents.find((a) => a.id === current)?.name ?? current;
  const label = (
    <>
      <span className="sr-only">Agentti: </span>
      {name}
    </>
  );

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
      <DropdownMenuContent
        side="top"
        align="start"
        collisionPadding={8}
        className="w-auto min-w-48"
      >
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(id) => useStore.getState().setPendingAgentId(id)}
        >
          {agents.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id}>
              {a.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
