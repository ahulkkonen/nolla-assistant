import { decryptCommand } from '@pa/protocol';
import { Download } from 'lucide-react';
import { Fragment, type MouseEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { exportCancel, exportDownloadUrl, exportGet, exportStart, HttpError } from '../api.ts';
import { formatBytes } from '../files.ts';
import { useStore } from '../store.ts';
import { messageTime } from '../thread.ts';
import { UnmaskRow } from './ExportDialog.tsx';
import { CopyButton } from './MessageView.tsx';

/** The passphrase minimum of `ExportStart`. */
const MIN = 12;
/** Finnish text per export error (phase-15 UI). */
const FAILED: Record<string, string> = {
  pseudo_down: 'Nimisuoja ei vastaa. Yritä myöhemmin uudelleen.',
  too_large: 'Tiedot ovat yli 2 Gt. Siivoa työkansiota ja yritä uudelleen.',
  busy: 'Vienti on jo käynnissä.',
  reauth:
    'Oikeat nimet vaativat tuoreen kirjautumisen. Kirjaudu ulos ja takaisin sisään, ja yritä uudelleen.',
};
const failText = (code: string | null | undefined) =>
  FAILED[code ?? ''] ?? 'Vienti epäonnistui. Yritä uudelleen.';

/**
 * `text` that wraps only between its space-separated tokens (a file name, a command); copying
 * the rendered text gives `text` back. ponytail: a token wider than the box overflows it.
 */
function Tokens({ text }: { text: string }) {
  return text.split(' ').map((t, i) => (
    <Fragment key={i}>
      {i > 0 && ' '}
      <span className="whitespace-nowrap">{t}</span>
    </Fragment>
  ));
}

/** The passphrase and the job form; mounted afresh on each open, so no passphrase stays. */
function StartForm({ failed }: { failed: string | null }) {
  const [unmask, setUnmask] = useState(false);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(failed);
  const short = pass.length > 0 && pass.length < MIN;
  const mismatch = again.length > 0 && again !== pass;
  const ready = pass.length >= MIN && again === pass && !busy;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      useStore.setState({ exportJob: (await exportStart(pass, unmask)).job });
    } catch (err) {
      setError(failText(err instanceof HttpError ? err.code : null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id="export-all-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void start();
      }}
    >
      <UnmaskRow
        id="export-all-unmask"
        checked={unmask}
        onChange={setUnmask}
        masked="Nimet niin kuin malli näki ne. Mukana vain keskustelut. Nimisuoja, muisti ja tiedostot sisältävät oikeita nimiä."
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="export-pass" className="text-ui font-medium">
          Salasana
        </label>
        <Input
          id="export-pass"
          type="password"
          autoComplete="off"
          maxLength={1024}
          value={pass}
          aria-invalid={short}
          aria-describedby="export-pass-help"
          onChange={(e) => setPass(e.target.value)}
        />
        <p
          id="export-pass-help"
          className={short ? 'text-meta text-destructive' : 'text-meta text-muted-foreground'}
        >
          Vähintään {MIN} merkkiä. Ilman salasanaa tiedostoa ei saa auki.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="export-again" className="text-ui font-medium">
          Salasana uudelleen
        </label>
        <Input
          id="export-again"
          type="password"
          autoComplete="off"
          maxLength={1024}
          value={again}
          aria-invalid={mismatch}
          {...(mismatch ? { 'aria-describedby': 'export-again-error' } : {})}
          onChange={(e) => setAgain(e.target.value)}
        />
        {mismatch && (
          <p id="export-again-error" className="text-meta text-destructive">
            Salasanat eivät täsmää.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      {/* Inside the form, so Aloita submits it and Enter in a field does too. */}
      <DialogFooter className="grid grid-cols-2 sm:flex">
        <Button
          type="button"
          variant="outline"
          onClick={() => useStore.setState({ exportAllOpen: false })}
        >
          Peruuta
        </Button>
        <Button type="submit" disabled={!ready}>
          Aloita
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * "Vie kaikki tiedot" (phase-15 decisions 13 to 18): real names or not, a passphrase twice, then
 * the job's progress from `export.state`, the download once and the command that opens the file.
 */
export function ExportAllDialog() {
  const open = useStore((s) => s.exportAllOpen);
  const job = useStore((s) => s.exportJob);
  const [n, setN] = useState(0);
  // A screen opened after the start has missed the `export.state` broadcasts.
  useEffect(() => {
    if (!open) return;
    setN((k) => k + 1);
    void exportGet().then(
      (r) => useStore.setState({ exportJob: r.job }),
      () => {},
    );
  }, [open]);
  const close = () => useStore.setState({ exportAllOpen: false });
  // The download is done when the server drops the job (`export.state` with null).
  const prev = useRef(job);
  useEffect(() => {
    if (prev.current?.status === 'ready' && !job) close();
    prev.current = job;
  }, [job]);
  const cancel = (id: string) =>
    void exportCancel(id).then(
      () => useStore.setState({ exportJob: null }),
      (err) =>
        // 404: the job is already gone.
        err instanceof HttpError && err.status === 404
          ? useStore.setState({ exportJob: null })
          : useStore.getState().pushError('Vientiä ei voitu perua.'),
    );
  /**
   * The file goes once. ponytail: a navigation hides the download's own 409 or 410, so the job
   * is checked just before; a download that races another tab still fails in the browser only.
   */
  const download = async (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const href = e.currentTarget.href;
    const now = await exportGet().then(
      (r) => r.job,
      () => undefined,
    );
    if (now === undefined || (now?.id === id && now.status === 'ready'))
      return window.location.assign(href);
    useStore.getState().pushError('Tiedosto on jo ladattu tai vanhentunut.');
    useStore.setState({ exportJob: now });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent showCloseButton={false} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Vie kaikki tiedot</DialogTitle>
          <DialogDescription>
            Yksi salattu tiedosto, jonka saa auki vain salasanalla.
          </DialogDescription>
        </DialogHeader>
        {job?.status === 'building' ? (
          <>
            <div className="flex flex-col gap-2">
              <div
                role="progressbar"
                aria-label="Vienti"
                aria-valuemin={0}
                aria-valuemax={job.total}
                aria-valuenow={job.done}
                className="h-1 overflow-hidden rounded-full bg-secondary dark:bg-accent"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }}
                />
              </div>
              <p className="text-meta text-muted-foreground tabular-nums">
                {job.done} / {job.total}
              </p>
            </div>
            <DialogFooter className="grid grid-cols-2 sm:flex">
              <Button variant="outline" onClick={close}>
                Sulje
              </Button>
              <Button variant="outline" onClick={() => cancel(job.id)}>
                Peruuta
              </Button>
            </DialogFooter>
          </>
        ) : job?.status === 'ready' && job.fileName ? (
          <>
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="font-mono text-[13px]">
                  <Tokens text={job.fileName} />
                </p>
                <p className="text-meta text-muted-foreground tabular-nums">
                  {[
                    job.size !== null && formatBytes(job.size),
                    job.expiresAt && `ladattavissa ${messageTime(job.expiresAt)} asti`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <p className="text-meta text-muted-foreground">
                Tiedosto poistuu latauksen jälkeen tai tunnin kuluttua.
              </p>
              <div className="flex flex-col gap-1.5">
                {/* The copy button sits by the label: the box keeps its full width for the file name. */}
                <div className="flex items-center justify-between gap-2">
                  <p className="text-ui font-medium">Avaa tiedosto komennolla</p>
                  <CopyButton
                    text={() => decryptCommand(job.fileName ?? '')}
                    className="size-8 shrink-0"
                  />
                </div>
                <code className="block rounded-lg bg-muted px-3 py-2 font-mono text-[13px] leading-5">
                  <Tokens text={decryptCommand(job.fileName)} />
                </code>
              </div>
            </div>
            <DialogFooter className="grid grid-cols-2 sm:flex">
              <Button variant="outline" onClick={close}>
                Sulje
              </Button>
              <Button asChild>
                <a
                  href={exportDownloadUrl(job.id)}
                  download
                  onClick={(e) => void download(e, job.id)}
                >
                  <Download size={16} />
                  Lataa
                </a>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <StartForm key={n} failed={job?.status === 'failed' ? failText(job.error) : null} />
        )}
      </DialogContent>
    </Dialog>
  );
}
