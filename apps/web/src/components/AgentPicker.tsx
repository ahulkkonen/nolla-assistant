import { Check, ChevronDown } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useStore } from '../store.ts';
import { menuItem } from './Actions.tsx';
import { Tip } from './IconButton.tsx';

const chip = 'flex h-8 items-center gap-1 rounded-md px-2 text-secondary text-fg-muted max-md:h-11';

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
        <button type="button" aria-disabled="true" className={`${chip} cursor-not-allowed`}>
          {label}
        </button>
      </Tip>
    );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`${chip} hover:bg-bg-sunken hover:text-fg`}>
          {label}
          <ChevronDown size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 min-w-48 rounded-md border border-border bg-bg-raised p-1"
        >
          <DropdownMenu.RadioGroup
            value={current}
            onValueChange={(id) => useStore.getState().setPendingAgentId(id)}
          >
            {agents.map((a) => (
              <DropdownMenu.RadioItem key={a.id} value={a.id} className={menuItem}>
                <span className="flex-1">{a.name}</span>
                <DropdownMenu.ItemIndicator>
                  <Check size={16} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
