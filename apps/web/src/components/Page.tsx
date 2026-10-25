import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A management screen (brief 7.4): `--thread-max` (672) or, `wide`, `--page-max` (960); title
 * 20/600 (the phone top bar carries it), 24 to the content, 32 between sections.
 */
export function Page({
  title,
  wide = false,
  action,
  children,
}: {
  title: string;
  wide?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-6 py-6 md:py-8',
          wide ? 'max-w-(--page-max)' : 'max-w-(--thread-max)',
        )}
      >
        {/* Phones: the top bar carries the title; only an action keeps this row. */}
        <div className={cn('flex items-center gap-4', !action && 'max-md:hidden')}>
          <h1 className="min-w-0 flex-1 text-title max-md:hidden">{title}</h1>
          {action && <div className="ml-auto">{action}</div>}
        </div>
        <div className="flex flex-col gap-8">{children}</div>
      </div>
    </div>
  );
}

/** Empty state (brief 7.5): centred, max 360, icon in a 40 px circle, title, one line. */
export function EmptyState({
  Icon,
  title,
  line,
  children,
}: {
  Icon?: LucideIcon;
  title: string;
  line?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-[360px] flex-col items-center gap-2 py-12 text-center">
      {Icon && (
        <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon size={20} className="size-5 text-muted-foreground" />
        </span>
      )}
      <h2 className="text-heading">{title}</h2>
      {line && <p className="text-meta text-muted-foreground">{line}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** True once `loading` has lasted 300 ms: skeletons never flash (brief 7.5). */
export function useSlow(loading: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, [loading]);
  return loading && slow;
}

export const SKELETON_WIDTHS = [80, 65, 85, 60, 75, 70];

/** Skeleton list rows (12 px bars at 60–85 % width) after 300 ms of loading. */
export function ListSkeleton({
  loading,
  rows = 5,
  className,
}: {
  loading: boolean;
  rows?: number;
  className?: string;
}) {
  if (!useSlow(loading)) return null;
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {SKELETON_WIDTHS.slice(0, rows).map((w) => (
        <li key={w} className={cn('flex h-11 items-center', className)}>
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </li>
      ))}
    </ul>
  );
}
