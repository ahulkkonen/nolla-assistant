import type { ExportFormat } from '@pa/protocol';
import { useState } from 'react';
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
import { saveFile } from '@/lib/utils';
import { exportChat, HttpError } from '../api.ts';
import { firstUserLine, useStore } from '../store.ts';
import { Row } from './SettingsDialog.tsx';
import { UNTITLED } from './Sidebar.tsx';

/** The dialog body; it mounts on each open, so the switch starts off every time. */
function ExportForm({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const name = useStore(
    (s) => s.chats.find((c) => c.id === chatId)?.title ?? firstUserLine(s.messages[chatId]),
  );
  const [format, setFormat] = useState<ExportFormat>('md');
  const [unmask, setUnmask] = useState(false);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const file = await exportChat(chatId, format, unmask);
      saveFile(file.blob, file.name);
      onClose();
    } catch (err) {
      useStore
        .getState()
        .pushError(
          err instanceof HttpError && err.status === 503
            ? 'Pseudonymisointipalvelu ei vastaa. Vie ilman oikeita nimiä.'
            : 'Vienti epäonnistui. Yritä uudelleen.',
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
            unmask
              ? 'Tiedostossa on henkilötietoja.'
              : 'Nimet niin kuin malli näki ne. Tiedoston voi jakaa.'
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
      <DialogFooter>
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
  // The last chat stays rendered through the close animation.
  const [chatId, setChatId] = useState(open);
  if (open && open !== chatId) setChatId(open);
  const close = () => useStore.setState({ exportChatId: null });

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && close()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
        {chatId && <ExportForm chatId={chatId} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}
