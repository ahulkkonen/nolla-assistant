import { X } from 'lucide-react';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';

export function Toasts() {
  const errors = useStore((s) => s.errors);
  const dismiss = useStore((s) => s.dismissError);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-4 pt-[calc(env(safe-area-inset-top)+16px)] max-md:pt-[calc(env(safe-area-inset-top)+60px)]"
    >
      {errors.map((e) => (
        <div
          key={e.id}
          className="pointer-events-auto flex max-w-md items-center gap-2 rounded-md border border-border bg-bg-raised py-1 pr-1 pl-3 text-secondary"
        >
          <span className="flex-1">{e.message}</span>
          <IconButton label="Sulje" className="size-7 max-md:size-11" onClick={() => dismiss(e.id)}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
