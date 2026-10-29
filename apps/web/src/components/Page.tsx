import { ChevronLeft, type LucideIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * A management screen (brief 7.4): `--thread-max` (672) or, `wide`, `--page-max` (960); title
 * 20/600 (the phone top bar carries it), 24 to the content, 32 between sections.
 */
export function Page({
  title,
  wide = false,
  action,
  footer,
  children,
}: {
  title: string;
  wide?: boolean;
  action?: ReactNode;
  /** An editor's actions: a bar at the bottom of the main area, outside the scroll. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const max = wide ? 'max-w-(--page-max)' : 'max-w-(--thread-max)';
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6">
        <div className={cn('mx-auto flex w-full flex-col gap-6 py-6 md:py-8', max)}>
          {/* Phones: the top bar carries the title; only an action keeps this row. */}
          <div className={cn('flex items-center gap-4', !action && 'max-md:hidden')}>
            <h1 className="min-w-0 flex-1 text-title max-md:hidden">{title}</h1>
            {/* Phones: the action is a full-width button (the title is in the top bar). */}
            {action && (
              <div className="ml-auto max-md:ml-0 max-md:w-full max-md:*:w-full">{action}</div>
            )}
          </div>
          <div className="flex flex-col gap-8">{children}</div>
        </div>
      </div>
      {footer && (
        // Phones: above the home indicator (brief 7.7).
        <div className="shrink-0 border-t bg-background p-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-6">
          <div
            className={cn(
              'mx-auto flex w-full flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2',
              max,
            )}
          >
            {footer}
          </div>
        </div>
      )}
    </>
  );
}

/** An editor's way back to its list (phase-15 UI); the screen's title stays above it. */
export function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onClick}>
      <ChevronLeft size={16} />
      Takaisin luetteloon
    </Button>
  );
}

/**
 * A file editor (phase-15 UI, also the modes of phase 23): the way back, the name and its id,
 * a general error, the tabs (`children` holds their contents), Peruuta and Tallenna at the bottom.
 */
export function EditorPage({
  title,
  heading,
  id,
  general,
  busy,
  tab,
  tabs,
  onTab,
  onSave,
  onDone,
  children,
}: {
  title: string;
  heading: string;
  /** Unset for a new file: the server makes the id from the name. */
  id: string | undefined;
  general: string | null;
  busy: boolean;
  tab: string;
  tabs: [value: string, label: string][];
  onTab: (tab: string) => void;
  onSave: () => void;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <Page
      title={title}
      footer={
        <>
          <Button variant="outline" className="sm:ml-auto" onClick={onDone}>
            Peruuta
          </Button>
          <Button disabled={busy} onClick={onSave}>
            Tallenna
          </Button>
        </>
      }
    >
      <section aria-labelledby="editor-title" className="flex flex-col gap-4">
        <BackLink onClick={onDone} />
        <div className="min-w-0">
          <h2 id="editor-title" className="truncate text-heading">
            {heading}
          </h2>
          <p className="text-meta text-muted-foreground">
            {id ? (
              <>
                Tunniste <span className="font-mono">{id}</span>
              </>
            ) : (
              'Tunniste tehdään nimestä.'
            )}
          </p>
        </div>
        {general && (
          <p role="alert" className="text-meta text-destructive">
            {general}
          </p>
        )}
        <Tabs value={tab} onValueChange={onTab} className="gap-0">
          <TabsList className="max-md:h-11! max-md:w-full">
            {tabs.map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {children}
        </Tabs>
      </section>
    </Page>
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
      {line && <p className="text-meta text-balance text-muted-foreground">{line}</p>}
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
