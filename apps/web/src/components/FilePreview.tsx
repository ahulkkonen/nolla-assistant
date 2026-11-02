import { type FileRoot, PREVIEW_MAX, type TreeEntry } from '@nolla/protocol';
import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { treeRawUrl } from '../api.ts';
import { IconButton } from './IconButton.tsx';
import { CodeBlock, MarkdownText } from './MessageView.tsx';
import { htmlDocument, SandboxFrame } from './Sandbox.tsx';
import { SidePanel } from './SidePanel.tsx';

/** Starts a download of a raw URL: an attachment answer never leaves the page. */
export const download = (url: string) =>
  Object.assign(document.createElement('a'), { href: url }).click();

type Loaded = { text: string } | { error: 'failed' | 'large' };

/** The body as text, or `large` past `max` bytes: by Content-Length first, then while reading. */
async function readCapped(url: string, max: number, signal: AbortSignal): Promise<Loaded> {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', signal });
  if (!r.ok) return { error: 'failed' };
  if (Number(r.headers.get('content-length') ?? 0) > max) {
    void r.body?.cancel();
    return { error: 'large' };
  }
  const reader = r.body?.getReader();
  if (!reader) return { text: await r.text() };
  const parts: BlobPart[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      void reader.cancel();
      return { error: 'large' };
    }
    parts.push(value as BlobPart);
  }
  return { text: await new Blob(parts).text() };
}

/**
 * The file's text for the text kinds (null `max`: none), fetched again when `rev` changes; the
 * last text stays up until the new one is in. Null while the first fetch runs.
 */
function useText(url: string, max: number | null, rev: number) {
  const [got, setGot] = useState<{ url: string; value: Loaded } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rev` asks for a new fetch
  useEffect(() => {
    if (max === null) return;
    const ctrl = new AbortController();
    readCapped(url, max, ctrl.signal).then(
      (value) => setGot({ url, value }),
      () => !ctrl.signal.aborted && setGot({ url, value: { error: 'failed' } }),
    );
    return () => ctrl.abort();
  }, [url, max, rev]);
  return got?.url === url ? got.value : null;
}

const note = (text: string) => <p className="p-1 text-meta text-muted-foreground">{text}</p>;
const TOO_LARGE = 'Tiedosto on liian suuri esikatseluun. Lataa se yläpalkista.';

/** The preview body per kind (phase-11 decision 9). Every kind shows real values. */
function Body({ root, entry, rev }: { root: FileRoot; entry: TreeEntry; rev: number }) {
  const url = treeRawUrl(root, entry.path);
  const kind = entry.preview;
  const max = kind ? PREVIEW_MAX[kind] : 0;
  const big = entry.size > max;
  const loaded = useText(url, kind !== 'image' && kind !== 'pdf' && !big ? max : null, rev);
  // A new `rev` loads the image or PDF again (the raw answer is `no-cache`).
  const fresh = rev ? `${url}&v=${rev}` : url;
  if (big) return note(TOO_LARGE);
  if (kind === 'image')
    return (
      <div className="flex size-full items-center justify-center overflow-auto rounded-lg bg-muted p-4">
        <img src={fresh} alt={entry.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (kind === 'pdf')
    // No `sandbox`: Chrome shows no PDF viewer in a sandboxed frame. This same-origin frame runs no
    // page script: the raw route sends this URL only as `application/pdf` (its pdf branch, with
    // `frame-ancestors 'self'`) and every answer has `nosniff`. Without a viewer, the header's
    // "Lataa" stays (record risk 1).
    return navigator.pdfViewerEnabled === false ? (
      note('Esikatselu ei onnistunut.')
    ) : (
      <iframe title={entry.name} src={fresh} className="block size-full rounded-lg border" />
    );
  if (loaded === null) return note('Ladataan…');
  if ('error' in loaded)
    return note(loaded.error === 'large' ? TOO_LARGE : 'Esikatselu ei onnistunut.');
  const text = loaded.text;
  if (kind === 'html') return <SandboxFrame title={entry.name} html={htmlDocument(text)} />;
  if (kind === 'markdown')
    return (
      <div className="h-full overflow-y-auto px-1">
        <MarkdownText text={text} />
      </div>
    );
  if (kind === 'code') {
    const lang = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '') : '';
    return (
      <div className="md h-full overflow-y-auto">
        <CodeBlock lang={lang}>
          <code>{text}</code>
        </CodeBlock>
      </div>
    );
  }
  return (
    <pre
      translate="no"
      role="region"
      aria-label={`${entry.name}: sisältö`}
      // A scrollable region must be focusable (brief 7.8).
      tabIndex={0}
      className="size-full overflow-auto rounded-lg bg-muted p-4 font-mono text-code whitespace-pre"
    >
      {text}
    </pre>
  );
}

/**
 * Esikatselu (phase-11 UI): a right pane like the artifact panel from 1024 px (header 48: name,
 * "Lataa", "Sulje esikatselu"), a full-screen sheet below.
 */
export function FilePreview({
  root,
  entry,
  rev,
  onClose,
}: {
  root: FileRoot;
  entry: TreeEntry;
  /** A change fetches the file again (a reload of the listing, window focus). */
  rev: number;
  onClose: () => void;
}) {
  return (
    <SidePanel title={entry.name} description="Esikatselu" onClose={onClose}>
      <aside aria-label="Esikatselu" className="flex h-full min-h-0 flex-col bg-card">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <h2 className="min-w-0 flex-1 truncate text-ui font-semibold">{entry.name}</h2>
          <IconButton
            label="Lataa"
            className="size-8"
            onClick={() => download(treeRawUrl(root, entry.path, true))}
          >
            <Download size={16} />
          </IconButton>
          <IconButton label="Sulje esikatselu" className="size-8" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <Body root={root} entry={entry} rev={rev} />
        </div>
      </aside>
    </SidePanel>
  );
}
