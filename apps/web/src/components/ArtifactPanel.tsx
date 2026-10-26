import type { Artifact } from '@pa/protocol';
import { Check, ChevronDown, Copy, Download, ExternalLink, Save, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { saveFile } from '@/lib/utils';
import { saveArtifact } from '../api.ts';
import runtimeUrl from '../artifact-runtime.ts?worker&url';
import { fileError, showInFiles } from '../files.ts';
import kitCss from '../kit.css?raw';
import { useStore } from '../store.ts';
import {
  type Chart,
  fontFaces,
  inlineHtml,
  type Lifted,
  prepareChart,
  type Refused,
  type Row,
  readTokens,
  type Tokens,
  tokenSheet,
} from '../viz.ts';
import vizUrl from '../viz-runtime.ts?worker&url';
import { IconButton } from './IconButton.tsx';
import { htmlDocument, postWhenReady, SANDBOX_URL, SandboxFrame, SCHEME_META } from './Sandbox.tsx';
import { SidePanel } from './SidePanel.tsx';

const EMPTY: Artifact[] = [];
const EXT: Record<string, string> = {
  html: 'html',
  react: 'jsx',
  mermaid: 'mmd',
  'vega-lite': 'json',
};

/** `</script` would end an inline script early and `<!--` can change how the parser reads it. */
const inline = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const page = (body: string, head = SCHEME_META) =>
  htmlDocument(
    `<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`,
    head,
  );
const BASE_STYLE = '<style>body{margin:16px;font-family:system-ui,sans-serif}</style>';

const scripts = new Map<string, Promise<string>>();
/** A bundled runtime's source, to inline into the sandbox document. */
const loadScript = (url: string) => {
  let p = scripts.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`runtime ${r.status}`);
      return r.text();
    });
    // A failed load is retried on the next artifact.
    p.catch(() => scripts.delete(url));
    scripts.set(url, p);
  }
  return p;
};

type Scheme = 'light' | 'dark';
const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const onScheme = (cb: () => void) => {
  darkQuery?.addEventListener('change', cb);
  return () => darkQuery?.removeEventListener('change', cb);
};
/** The active scheme: the theme setting, or the OS while it is `system`. */
function useScheme(): Scheme {
  const theme = useStore((s) => s.theme);
  const osDark = useSyncExternalStore(onScheme, () => darkQuery?.matches ?? false);
  return theme === 'system' ? (osDark ? 'dark' : 'light') : theme;
}

/** Fonts, the active theme's tokens and the kit, ahead of an artifact's own content (phase 19). */
async function themeHead(scheme: Scheme) {
  const fonts = await fontFaces();
  // Read after an await: App's theme effect runs after this panel's effect in the same commit.
  const t = readTokens();
  const head = `<meta name="color-scheme" content="${scheme}"><style>${fonts}${tokenSheet(t)}${kitCss}</style>`;
  return { t, fonts, head };
}

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

/** The R1 chart page: the lifted title as HTML, the spec as JSON, then the chart runtime. */
const chartBody = ({ spec, lifted: { title, subtitle, caption } }: Chart, rt: string) =>
  `<figure class="chart">${title ? `<h2>${inlineHtml(title)}</h2>` : ''}${subtitle ? `<p>${inlineHtml(subtitle)}</p>` : ''}<div id="vis"></div>${caption ? `<figcaption>${inlineHtml(caption)}</figcaption>` : ''}</figure><script type="application/json" id="spec">${JSON.stringify(spec).replace(/</g, '\\u003c')}</script><script>${inline(rt)}</script>`;

/**
 * The sandboxed document of an artifact (`code` and `file` have none); a chart also keeps what its
 * export and its fallback table need.
 */
type Doc = {
  html: string | null;
  rows?: Row[];
  refused?: Refused;
  svg?: string;
  lifted?: Lifted;
  theme?: { t: Tokens; fonts: string };
};
async function documentFor(a: Artifact, scheme: Scheme): Promise<Doc> {
  if (a.kind === 'html') return { html: htmlDocument(a.content) };
  if (a.kind === 'vega-lite') {
    const [{ t, fonts, head }, rt] = await Promise.all([themeHead(scheme), loadScript(vizUrl)]);
    const chart = prepareChart(a.content, t);
    if ('error' in chart) return { html: null, refused: chart };
    return {
      html: page(chartBody(chart, rt), head),
      rows: chart.rows,
      lifted: chart.lifted,
      theme: { t, fonts },
    };
  }
  if (a.kind === 'react') {
    const [rt, code] = await Promise.all([loadScript(runtimeUrl), transpile(a.content)]);
    const boot = `(function(){var exports={},module={exports:exports};function require(n){if(n==='react')return React;if(n==='react-dom/client'||n==='react-dom')return ReactDOMClient;throw new Error('Moduulia ei ole saatavilla: '+n)}try{${code}
;var C=module.exports.default||exports.default;ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(C))}catch(e){document.body.textContent='Virhe: '+e.message}})();`;
    return {
      html: page(
        `<div id="root"></div><script>${inline(rt)}</script><script>${inline(boot)}</script>`,
        SCHEME_META + BASE_STYLE,
      ),
    };
  }
  if (a.kind === 'mermaid') {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    const { svg } = await mermaid.render(`m${a.id.replace(/\W/g, '')}`, a.content);
    return { html: page(svg, SCHEME_META + BASE_STYLE) };
  }
  return { html: null };
}

const stem = (a: Artifact) =>
  a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti';

function download(a: Artifact) {
  const ext = EXT[a.kind] ?? a.language ?? 'txt';
  saveFile(new Blob([a.content], { type: a.mime ?? 'text/plain' }), `${stem(a)}.${ext}`);
}

/** R6 fallback: the error and the spec's data as a table, in the panel (not the sandbox). */
function ChartFallback({ refused: { error, rows } }: { refused: Refused }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) =>
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  return (
    <div
      role="region"
      aria-label="Kaavion data"
      // A scrollable region must be focusable (brief 7.8).
      tabIndex={0}
      className="size-full overflow-auto rounded-lg border p-4"
    >
      <p className="font-semibold">Kaavio epäonnistui</p>
      <p className="mt-1 text-meta whitespace-pre-wrap text-muted-foreground">{error}</p>
      {cols.length > 0 && (
        <table className="mt-4 border-collapse text-body tabular-nums">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="border-b px-2 py-1 text-left text-meta font-medium text-muted-foreground"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="border-b px-2 py-1">
                    {cell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "Tallenna tiedostoksi" (phase-11 decision 12): into the work dir, with real values. */
async function saveToWork(chatId: string, artifactId: string) {
  try {
    const { entry } = await saveArtifact(chatId, artifactId);
    useStore.getState().notify('Tallennettu Työkansioon', {
      label: 'Näytä',
      onClick: () => showInFiles(entry.path),
    });
  } catch (err) {
    useStore.getState().pushError(fileError(err));
  }
}

/**
 * A document opens the sandbox page in a new tab and posts itself there; the page's `sandbox` CSP
 * keeps it off the app's origin. Code opens as a script-free blob page.
 */
function openInTab(a: Artifact, doc: string | null) {
  if (doc) {
    const win = window.open(SANDBOX_URL, '_blank');
    const stop = postWhenReady(() => win, doc);
    setTimeout(stop, 60_000);
    return;
  }
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(a.title)}</title><pre>${escapeHtml(a.content)}</pre>`;
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
  const artifacts = list ?? EMPTY;
  const a = artifacts.find((x) => x.id === open?.id);
  const [doc, setDoc] = useState<(Doc & { id: string; error?: string }) | null>(null);
  const scheme = useScheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');

  // Keyed by content, not object identity: a streaming upsert of another artifact must not reload
  // this one. The old document stays up until the new one is ready.
  useEffect(() => {
    if (!a) return;
    let live = true;
    documentFor(a, scheme).then(
      (d) => live && setDoc({ id: a.id, ...d }),
      (err: unknown) =>
        live &&
        setDoc({ id: a.id, html: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [a?.id, a?.content, a?.kind, scheme]);

  // A chart that fails inside the sandbox (Vega's own errors) falls back like a refused spec.
  useEffect(() => {
    const onMessage = (e: MessageEvent<{ type?: string; message?: unknown }>) => {
      if (e.source !== frame.current?.contentWindow || e.data?.type !== 'viz-error') return;
      const error = String(e.data.message);
      setDoc((d) => d && { ...d, html: null, refused: { error, rows: d.rows ?? [] } });
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

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
  const preview = ready?.refused ? (
    <ChartFallback refused={ready.refused} />
  ) : ready?.error ? (
    <p className="p-1 text-muted-foreground">Artefaktin näyttäminen epäonnistui: {ready.error}</p>
  ) : ready?.html ? (
    <SandboxFrame ref={frame} title={a.title} html={ready.html} themed={a.kind === 'vega-lite'} />
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
            {/* A code block opened from a message (`local-…`) has no artifact on the server. */}
            {!a.id.startsWith('local-') && (
              <IconButton
                label="Tallenna tiedostoksi"
                className="size-8"
                onClick={() => void saveToWork(open.chatId, a.id)}
              >
                <Save size={16} />
              </IconButton>
            )}
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

  return (
    <SidePanel title={a.title} description="Artefakti" onClose={close}>
      {panel}
    </SidePanel>
  );
}
