import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * A confirmation (brief 7.5): 420 wide, a passive question with the object in ”…”, one line of
 * body, Peruuta (focused) and the labelled action. `destructive` only to confirm a delete.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  action,
  destructive = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  action: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)] gap-6 data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-[420px]">
        <AlertDialogHeader className="place-items-start gap-2 text-left">
          <AlertDialogTitle className="text-heading [overflow-wrap:anywhere]">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-body text-pretty text-muted-foreground">
            {children}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <AlertDialogCancel>Peruuta</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
