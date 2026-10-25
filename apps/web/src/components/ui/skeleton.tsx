import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'animate-[pulse_1.5s_ease-in-out_infinite] rounded-full bg-secondary',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
