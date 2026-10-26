import { type LucideIcon, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from './IconButton.tsx';

/** One action list renders as an icon row (desktop) or a labelled menu (under 768 px). */
export type Action = {
  label: string;
  Icon: LucideIcon;
  run?: () => void;
  pressed?: boolean;
};

/** `small`: 28 px buttons for dense rows (sidebar, tables). */
export function ActionRow({ actions, small }: { actions: Action[]; small?: boolean }) {
  return (
    <div className="flex">
      {actions.map(({ label, Icon, run, pressed }) => (
        <IconButton
          key={label}
          label={label}
          {...(small ? { className: 'size-7' } : {})}
          {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
          {...(run ? { onClick: run } : { 'aria-disabled': 'true' as const })}
        >
          <Icon size={16} />
        </IconButton>
      ))}
    </div>
  );
}

/**
 * The ⋯ menu. Not modal: a modal menu hides the rest of the page from assistive technology
 * while its trigger keeps focus (axe `aria-hidden-focus`).
 */
export function ActionMenu({
  label,
  actions,
  small,
  open,
  onOpenChange,
  note,
}: {
  label: string;
  actions: Action[];
  small?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A non-interactive line at the end (the chat menu's cost, phase 13). */
  note?: string | undefined;
}) {
  return (
    <DropdownMenu
      modal={false}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <DropdownMenuTrigger asChild>
        <IconButton label={label} {...(small ? { className: 'size-7' } : {})}>
          <MoreHorizontal size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-auto min-w-48">
        {actions.map(({ label, Icon, run }) => (
          <DropdownMenuItem key={label} {...(run ? { onSelect: run } : { disabled: true })}>
            <Icon size={16} className="text-muted-foreground" />
            {label}
          </DropdownMenuItem>
        ))}
        {note && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-micro font-normal text-muted-foreground tabular-nums">
              {note}
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
