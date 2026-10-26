import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import { useStore } from '../store.ts';

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

type Place = Pick<ReturnType<typeof useStore.getState>, 'screen' | 'activeChatId'>;

/**
 * Unsaved changes on `screen`: the browser asks on unload, and an in-app navigation away is undone
 * and asked in the returned dialog. "Hylkää muutokset" runs `discard`, then goes on.
 */
export function useLeaveGuard(
  screen: Place['screen'],
  dirty: boolean,
  body: string,
  discard: () => void = () => {},
) {
  const [leave, setLeave] = useState<Place | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (!dirtyRef.current || prev.screen !== screen || s.screen === screen) return;
        setLeave({ screen: s.screen, activeChatId: s.activeChatId });
        useStore.setState({ screen, activeChatId: prev.activeChatId });
      }),
    [screen],
  );
  return (
    <ConfirmDialog
      open={!!leave}
      title="Hylätäänkö tallentamattomat muutokset?"
      action="Hylkää muutokset"
      onConfirm={() => {
        dirtyRef.current = false;
        discard();
        if (leave) useStore.setState(leave);
      }}
      onClose={() => setLeave(null)}
    >
      {body}
    </ConfirmDialog>
  );
}
