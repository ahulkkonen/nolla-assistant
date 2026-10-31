import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  // Brief 7.5: 22 h, padding 0 8, radius full, --text-micro; semantic variants are tints.
  'inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 text-micro whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        success: 'bg-success-subtle text-success',
        warning: 'bg-warning-subtle text-warning',
        info: 'bg-info-subtle text-info',
        destructive: 'bg-destructive-subtle text-destructive',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
);

function Badge({
  className,
  variant = 'secondary',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
