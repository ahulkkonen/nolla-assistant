import * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full py-2 min-w-0 rounded-md border border-border bg-card px-3 text-body text-foreground transition-colors duration-100 outline-none placeholder:text-muted-foreground hover:border-input focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:border-destructive aria-invalid:focus-visible:ring-destructive max-md:text-[16px]',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
