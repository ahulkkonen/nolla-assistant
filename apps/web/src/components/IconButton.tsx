import { clsx } from 'clsx';
import { Tooltip } from 'radix-ui';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

type Props = ComponentProps<'button'> & { label: string; variant?: 'ghost' | 'primary' };

/** Radix tooltip around one trigger element. */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={4}
          collisionPadding={8}
          className="z-50 rounded-sm bg-fg px-2 py-1 text-secondary text-bg"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function IconButton({ label, variant = 'ghost', className, type, ...rest }: Props) {
  return (
    <Tip label={label}>
      <button
        type={type ?? 'button'}
        aria-label={label}
        className={clsx(
          'inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-(--duration) ease-out',
          // Tailwind cannot order two size utilities, so the default applies only without one.
          !className?.includes('size-') && 'size-9 max-md:size-11',
          variant === 'primary'
            ? 'bg-accent text-accent-fg disabled:bg-bg-sunken disabled:text-fg-muted'
            : rest['aria-disabled']
              ? 'cursor-not-allowed text-fg-muted'
              : 'text-fg-muted hover:bg-bg-sunken hover:text-fg',
          className,
        )}
        {...rest}
      />
    </Tip>
  );
}
