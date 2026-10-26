import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useMedia } from '../media.ts';

/**
 * The side panel (brief 7.4, 7.5): docked right from 1024 px (440, at 1280 px
 * clamp(440px, 40vw, 640px)), a full-screen sheet below. The artifact panel and the file preview.
 */
export function SidePanel({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const docked = useMedia('(min-width: 1024px)');
  if (docked)
    return <div className="w-110 shrink-0 border-l xl:w-[clamp(440px,40vw,640px)]">{children}</div>;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0 pt-[env(safe-area-inset-top)] data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}
