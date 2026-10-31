import type * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-ui file:font-medium min-w-0 rounded-md border border-border bg-card px-3 text-body text-foreground transition-colors duration-100 outline-none placeholder:text-muted-foreground hover:border-input focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive max-md:h-11 max-md:text-[16px]',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
