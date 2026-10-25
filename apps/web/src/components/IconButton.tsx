import { clsx } from 'clsx';
import { Tooltip } from 'radix-ui';
import type { ComponentProps } from 'react';

type Props = ComponentProps<'button'> & { label: string; variant?: 'ghost' | 'primary' };

export function IconButton({ label, variant = 'ghost', className, type, ...rest }: Props) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type={type ?? 'button'}
          aria-label={label}
          className={clsx(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-md transition-colors duration-(--duration) ease-out disabled:opacity-50',
            variant === 'primary'
              ? 'bg-accent text-accent-fg'
              : 'text-fg-muted hover:bg-bg-sunken hover:text-fg',
            className,
          )}
          {...rest}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={4}
          className="z-50 rounded-sm bg-fg px-2 py-1 text-secondary text-bg"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
