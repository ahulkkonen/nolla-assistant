import { AlertDialog } from 'radix-ui';
import type { ReactNode } from 'react';

const button = 'h-10 rounded-md px-4 font-medium';

/** A confirmation with a labelled action ("Poista", "Lopeta tunnistus") and "Peruuta". */
export function ConfirmDialog({
  open,
  title,
  children,
  action,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-fg/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <AlertDialog.Content className="fixed inset-x-4 top-1/2 z-50 mx-auto max-w-sm -translate-y-1/2 rounded-lg border border-border bg-bg-raised p-6 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in">
          <AlertDialog.Title className="mb-2 font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mb-6 text-fg-muted">
            {children}
          </AlertDialog.Description>
          <div className="flex justify-end gap-2">
            <AlertDialog.Cancel className={`${button} border border-border hover:bg-bg-sunken`}>
              Peruuta
            </AlertDialog.Cancel>
            <AlertDialog.Action
              className={`${button} bg-accent text-accent-fg`}
              onClick={onConfirm}
            >
              {action}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
