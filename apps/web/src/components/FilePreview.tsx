import type { FileRoot, TreeEntry } from '@pa/protocol';
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

/** The file's text for the text kinds; null while it loads, undefined when it failed. */
function useText(url: string, wanted: boolean) {
  const [text, setText] = useState<{ url: string; body: string | undefined } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(
        (body) => live && setText({ url, body }),
        () => live && setText({ url, body: undefined }),
      );
    return () => {
      live = false;
    };
  }, [url, wanted]);
  return text?.url === url ? text.body : null;
}

const note = (text: string) => <p className="p-1 text-meta text-muted-foreground">{text}</p>;

/** The preview body per kind (phase-11 decision 9). Every kind shows real values. */
function Body({ root, entry }: { root: FileRoot; entry: TreeEntry }) {
  const url = treeRawUrl(root, entry.path);
  const kind = entry.preview;
  const text = useText(url, kind !== 'image' && kind !== 'pdf');
  if (kind === 'image')
    return (
      <div className="flex size-full items-center justify-center overflow-auto rounded-lg bg-muted p-4">
        <img src={url} alt={entry.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  if (kind === 'pdf')
    // The browser's own viewer; without one in a frame, the header's "Lataa" stays (risk 1).
    return navigator.pdfViewerEnabled === false ? (
      note('Esikatselu ei onnistunut.')
    ) : (
      <iframe title={entry.name} src={url} className="block size-full rounded-lg border" />
    );
  if (text === null) return note('Ladataan…');
  if (text === undefined) return note('Esikatselu ei onnistunut.');
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
  onClose,
}: {
  root: FileRoot;
  entry: TreeEntry;
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
          <Body root={root} entry={entry} />
        </div>
      </aside>
    </SidePanel>
  );
}
