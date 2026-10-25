import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { IconButton } from './IconButton.tsx';

/** One action list renders as an icon row (desktop) or a labelled menu (under 768 px). */
export type Action = {
  label: string;
  Icon: LucideIcon;
  run?: () => void;
  pressed?: boolean;
};

export function ActionRow({ actions }: { actions: Action[] }) {
  return (
    <div className="flex">
      {actions.map(({ label, Icon, run, pressed }) => (
        <IconButton
          key={label}
          label={label}
          {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
          {...(run ? { onClick: run } : { 'aria-disabled': 'true' as const })}
        >
          <Icon size={16} />
        </IconButton>
      ))}
    </div>
  );
}

export const menuItem =
  'flex h-11 cursor-default items-center gap-3 rounded-sm px-3 outline-none data-[disabled]:text-fg-muted data-[highlighted]:bg-bg-sunken';

export function ActionMenu({ label, actions }: { label: string; actions: Action[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label={label}>
          <MoreHorizontal size={20} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 min-w-60 rounded-md border border-border bg-bg-raised p-1"
        >
          {actions.map(({ label, Icon, run }) => (
            <DropdownMenu.Item
              key={label}
              className={menuItem}
              {...(run ? { onSelect: run } : { disabled: true })}
            >
              <Icon size={16} />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
