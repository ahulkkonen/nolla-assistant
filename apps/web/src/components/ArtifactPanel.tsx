import type { Artifact } from '@pa/protocol';
import { Check, ChevronDown, Copy, Download, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import runtimeUrl from '../artifact-runtime.ts?worker&url';
import { useMedia } from '../media.ts';
import { useStore } from '../store.ts';
import { IconButton } from './IconButton.tsx';

const EMPTY: Artifact[] = [];
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
/** The artifact keeps its own white page in both schemes (brief 7.5). */
const SCHEME_META = '<meta name="color-scheme" content="light">';
/** The open-in-tab wrapper runs no script; it only frames the sandboxed document. */
const WRAPPER_CSP = "default-src 'none'; frame-src 'self' about:; style-src 'unsafe-inline'";
const EXT: Record<string, string> = { html: 'html', react: 'jsx', mermaid: 'mmd' };

/** `</script` would end an inline script early and `<!--` can change how the parser reads it. */
const inline = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const page = (body: string, head = '') =>
  `<!doctype html>${CSP_META}${SCHEME_META}<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${body}</body></html>`;
const BASE_STYLE = '<style>body{margin:16px;font-family:system-ui,sans-serif}</style>';

let runtime: Promise<string> | undefined;
const loadRuntime = () => {
  runtime ??= fetch(runtimeUrl).then((r) => {
    if (!r.ok) throw new Error(`runtime ${r.status}`);
    return r.text();
  });
  // A failed load is retried on the next artifact.
  runtime.catch(() => {
    runtime = undefined;
  });
  return runtime;
};

let worker: Worker | undefined;
let seq = 0;
function transpile(source: string): Promise<string> {
  worker ??= new Worker(new URL('../transpile.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
      w.removeEventListener('messageerror', onError);
    };
    const onMessage = (e: MessageEvent<{ id: number; code?: string; error?: string }>) => {
      if (e.data.id !== id) return;
      done();
      if (e.data.code !== undefined) resolve(e.data.code);
      else reject(new Error(e.data.error ?? 'transpile failed'));
    };
    const onError = () => {
      done();
      // A broken worker is replaced on the next call.
      if (worker === w) worker = undefined;
      w.terminate();
      reject(new Error('transpile worker failed'));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('transpile timed out'));
    }, 15_000);
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.addEventListener('messageerror', onError);
    w.postMessage({ id, source });
  });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The sandboxed document for an artifact; `code` and `file` have none. */
async function documentFor(a: Artifact): Promise<string | null> {
  if (a.kind === 'html') {
    // Our CSP is always the first element, before anything of the artifact's (even a <script>
    // ahead of <head>); a later, looser policy cannot widen it.
    return `<!doctype html>${CSP_META}${SCHEME_META}${a.content.replace(/^\s*<!doctype[^>]*>/i, '')}`;
  }
  if (a.kind === 'react') {
    const [rt, code] = await Promise.all([loadRuntime(), transpile(a.content)]);
    const boot = `(function(){var exports={},module={exports:exports};function require(n){if(n==='react')return React;if(n==='react-dom/client'||n==='react-dom')return ReactDOMClient;throw new Error('Moduulia ei ole saatavilla: '+n)}try{${code}
;var C=module.exports.default||exports.default;ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(C))}catch(e){document.body.textContent='Virhe: '+e.message}})();`;
    return page(
      `<div id="root"></div><script>${inline(rt)}</script><script>${inline(boot)}</script>`,
      BASE_STYLE,
    );
  }
  if (a.kind === 'mermaid') {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    const { svg } = await mermaid.render(`m${a.id.replace(/\W/g, '')}`, a.content);
    return page(svg, BASE_STYLE);
  }
  return null;
}

function download(a: Artifact) {
  const ext = EXT[a.kind] ?? a.language ?? 'txt';
  const url = URL.createObjectURL(new Blob([a.content], { type: a.mime ?? 'text/plain' }));
  const link = Object.assign(document.createElement('a'), {
    href: url,
    download: `${a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti'}.${ext}`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A new tab gets a script-free wrapper page around a sandboxed iframe: a blob URL shares the app's
 * origin, so the artifact must never run in it directly.
 */
function openInTab(a: Artifact, doc: string | null) {
  const html = doc
    ? `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><title>${escapeHtml(a.title)}</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`
    : `<!doctype html><meta charset="utf-8"><title>${escapeHtml(a.title)}</title><pre>${escapeHtml(a.content)}</pre>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The side panel (brief 7.4, 7.5): docked right from 1024 px (440, at 1280 px
 * clamp(440px, 40vw, 640px)), a full-screen sheet below. Header: title, Esikatselu / Koodi, actions.
 */
export function ArtifactPanel() {
  const open = useStore((s) => s.openArtifact);
  const list = useStore((s) => (s.openArtifact ? s.artifacts[s.openArtifact.chatId] : undefined));
  const docked = useMedia('(min-width: 1024px)');
  const artifacts = list ?? EMPTY;
  const a = artifacts.find((x) => x.id === open?.id);
  const [doc, setDoc] = useState<{ id: string; html: string | null; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');

  // Keyed by content, not object identity: a streaming upsert of another artifact must not reload
  // this one. The old document stays up until the new one is ready.
  useEffect(() => {
    if (!a) return;
    let live = true;
    documentFor(a).then(
      (html) => live && setDoc({ id: a.id, html }),
      (err: unknown) =>
        live &&
        setDoc({ id: a.id, html: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [a?.id, a?.content, a?.kind]);

  if (!open || !a) return null;
  const close = () => useStore.setState({ openArtifact: null });
  const ready = doc?.id === a.id ? doc : null;
  const plain = a.kind === 'code' || a.kind === 'file';
  const title = <span className="truncate">{a.title}</span>;
  const code = (
    <pre
      translate="no"
      role={plain ? 'region' : undefined}
      aria-label={plain ? `${a.title}: koodi` : undefined}
      // A scrollable region must be focusable (brief 7.8).
      tabIndex={0}
      className="size-full overflow-auto rounded-lg bg-muted p-4 font-mono text-code whitespace-pre"
    >
      {a.content}
    </pre>
  );
  const preview = ready?.error ? (
    <p className="p-1 text-muted-foreground">Artefaktin näyttäminen epäonnistui: {ready.error}</p>
  ) : ready?.html ? (
    // Its own white page in both schemes, inset 12 with radius 12 and a border.
    <iframe
      title={a.title}
      sandbox="allow-scripts"
      srcDoc={ready.html}
      className="block size-full rounded-lg border bg-white"
    />
  ) : (
    <p className="p-1 text-muted-foreground">Ladataan…</p>
  );

  const panel = (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as 'preview' | 'code')}
      className="h-full gap-0"
      asChild
    >
      <aside aria-label="Artefaktit" className="flex h-full min-h-0 flex-col bg-card">
        {/* Phones: the tabs take a second row so the title keeps its width. */}
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 border-b px-3">
          <h2 className="flex h-12 min-w-0 flex-1 items-center text-ui font-semibold">
            {artifacts.length > 1 ? (
              // More than one artifact in the chat: the title picks between them.
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 rounded-md hover:text-muted-foreground">
                  {title}
                  <ChevronDown size={16} className="shrink-0 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-auto min-w-56">
                  <DropdownMenuRadioGroup
                    value={a.id}
                    onValueChange={(id) =>
                      useStore.setState({ openArtifact: { chatId: open.chatId, id } })
                    }
                  >
                    {artifacts.map((x) => (
                      <DropdownMenuRadioItem key={x.id} value={x.id}>
                        {x.title}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              title
            )}
          </h2>
          {!plain && (
            <TabsList className="max-md:order-last max-md:mb-2 max-md:w-full">
              <TabsTrigger value="preview">Esikatselu</TabsTrigger>
              <TabsTrigger value="code">Koodi</TabsTrigger>
            </TabsList>
          )}
          <div className="flex">
            <IconButton
              label={copied ? 'Kopioitu' : 'Kopioi'}
              className="size-8"
              onClick={() =>
                void navigator.clipboard.writeText(a.content).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </IconButton>
            <IconButton label="Lataa" className="size-8" onClick={() => download(a)}>
              <Download size={16} />
            </IconButton>
            <IconButton
              label="Avaa uudessa ikkunassa"
              className="size-8"
              disabled={!plain && !ready?.html}
              onClick={() => openInTab(a, plain ? null : (ready?.html ?? null))}
            >
              <ExternalLink size={16} />
            </IconButton>
            <IconButton label="Sulje artefaktit" className="size-8" onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
        {plain ? (
          <div className="min-h-0 flex-1 p-3">{code}</div>
        ) : (
          <>
            <TabsContent value="preview" className="min-h-0 flex-1 p-3">
              {preview}
            </TabsContent>
            <TabsContent value="code" className="min-h-0 flex-1 p-3">
              {code}
            </TabsContent>
          </>
        )}
      </aside>
    </Tabs>
  );

  if (docked)
    return <div className="w-110 shrink-0 border-l xl:w-[clamp(440px,40vw,640px)]">{panel}</div>;
  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0 pt-[env(safe-area-inset-top)] data-[side=right]:w-full data-[side=right]:sm:max-w-none"
      >
        <SheetTitle className="sr-only">{a.title}</SheetTitle>
        <SheetDescription className="sr-only">Artefakti</SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  );
}
