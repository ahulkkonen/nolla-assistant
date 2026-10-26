import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Segmented control (brief 7.5): track --muted, the selected item a raised card. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: T; label: string; Icon?: LucideIcon }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex h-9 gap-1 rounded-md bg-muted p-0.5 max-md:h-11', className)}
    >
      {options.map(({ value: v, label: text, Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 text-ui transition-colors duration-100',
            value === v
              ? 'bg-card font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {Icon && <Icon size={16} />}
          {text}
        </button>
      ))}
    </div>
  );
}
