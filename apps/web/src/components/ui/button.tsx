import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // Brief 7.5: focus is the global 2 px ring outline; under 768 px every target is 44 px.
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent bg-clip-padding text-ui font-medium whitespace-nowrap transition-colors duration-100 ease-out select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline:
          'border-border bg-transparent hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-pressed:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost:
          'hover:bg-accent hover:text-accent-foreground aria-expanded:bg-accent aria-pressed:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive-hover',
        link: 'h-auto! px-0! text-link underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 max-md:h-11',
        sm: 'h-8 px-2.5 max-md:h-11',
        lg: 'h-11 px-4',
        icon: 'size-9 max-md:size-11',
        'icon-sm': 'size-8 max-md:size-11',
        'icon-xs': 'size-7 max-md:size-11',
        'icon-lg': 'size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
