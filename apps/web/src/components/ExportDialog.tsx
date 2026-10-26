import type { ExportFormat } from '@pa/protocol';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn, saveFile } from '@/lib/utils';
import { exportChat, HttpError } from '../api.ts';
import { firstUserLine, useStore } from '../store.ts';
import { Row } from './SettingsDialog.tsx';
import { UNTITLED } from './Sidebar.tsx';

const ERROR_TEXT: Record<number, string> = {
  503: 'Pseudonymisointipalvelu ei vastaa. Vie ilman oikeita nimiä.',
  413: 'Keskustelu on liian pitkä vietäväksi.',
};

/**
 * The dialog body, mounted afresh on each open (`key`). `open` turns false while the dialog
 * animates out: a download in flight is then aborted and never saved.
 */
function ExportForm({
  chatId,
  open,
  onClose,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
}) {
  const name = useStore(
    (s) => s.chats.find((c) => c.id === chatId)?.title ?? firstUserLine(s.messages[chatId]),
  );
  const [format, setFormat] = useState<ExportFormat>('md');
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) inFlight.current?.abort();
  }, [open]);
  useEffect(() => () => inFlight.current?.abort(), []);

  const download = async () => {
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    setBusy(true);
    try {
      const file = await exportChat(chatId, format, unmask, ctrl.signal);
      if (ctrl.signal.aborted) return;
      saveFile(file.blob, file.name);
      onClose();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      useStore
        .getState()
        .pushError(
          (err instanceof HttpError && ERROR_TEXT[err.status]) ||
            'Vienti epäonnistui. Yritä uudelleen.',
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader className="min-w-0">
        <DialogTitle>Vie keskustelu</DialogTitle>
        <DialogDescription className="truncate">”{name ?? UNTITLED}”</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col divide-y divide-border">
        <Row label="Muoto" htmlFor="export-format">
          <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
            <SelectTrigger id="export-format" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="md">Markdown</SelectItem>
              <SelectItem value="json">JSON</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Näytä oikeat nimet"
          htmlFor="export-unmask"
          helper={
            // Both lines share one grid cell, so the row keeps its height when the switch turns.
            // The hidden one is out of the switch's description.
            <span className="grid">
              <span className={cn('[grid-area:1/1]', unmask && 'invisible')}>
                Nimet niin kuin malli näki ne. Tiedoston voi jakaa.
              </span>
              <span
                className={cn(
                  'flex items-start gap-1 text-warning [grid-area:1/1]',
                  !unmask && 'invisible',
                )}
              >
                <TriangleAlert size={16} className="mt-px shrink-0" />
                Tiedostossa on henkilötietoja.
              </span>
            </span>
          }
        >
          <Switch
            id="export-unmask"
            checked={unmask}
            onCheckedChange={setUnmask}
            aria-describedby="export-unmask-help"
          />
        </Row>
      </div>
      {/* Phones: 50 % each, Lataa on the right, as the confirmation dialog (brief 7.5). */}
      <DialogFooter className="grid grid-cols-2 sm:flex">
        <Button variant="outline" onClick={onClose}>
          Peruuta
        </Button>
        <Button disabled={busy} onClick={() => void download()}>
          Lataa
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * "Vie…" (brief 7.11): format, real names (off by default) and Lataa. One instance in the shell;
 * the chat row menu and the palette open it through `exportChatId`.
 */
export function ExportDialog() {
  const open = useStore((s) => s.exportChatId);
  // The last chat stays rendered through the close animation; each open gets a new form.
  const [prev, setPrev] = useState(open);
  const [shown, setShown] = useState({ chatId: open, n: 0 });
  if (open !== prev) {
    setPrev(open);
    if (open) setShown({ chatId: open, n: shown.n + 1 });
  }
  const close = () => useStore.setState({ exportChatId: null });

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && close()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        {shown.chatId && (
          <ExportForm
            key={`${shown.chatId}:${shown.n}`}
            chatId={shown.chatId}
            open={!!open}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
