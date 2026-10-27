import { type Artifact, artifactExt, mermaidMeta } from '@pa/protocol';
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileImage,
  Save,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn, saveFile } from '@/lib/utils';
import { saveArtifact } from '../api.ts';
import runtimeUrl from '../artifact-runtime.ts?worker&url';
import { fileError, showInFiles } from '../files.ts';
import kitCss from '../kit.css?raw';
import { useMobile } from '../media.ts';
import plotUrl from '../plot-runtime.ts?worker&url';
import { useStore } from '../store.ts';
import {
  type Chart,
  fontFaces,
  framedSvg,
  inlineHtml,
  type Lifted,
  mermaidTheme,
  pngBlob,
  prepareChart,
  type Refused,
  type Row,
  readTokens,
  roundDecisions,
  type Tokens,
  tokenSheet,
} from '../viz.ts';
import vizUrl from '../viz-runtime.ts?worker&url';
import { ActionMenu } from './Actions.tsx';
import { IconButton } from './IconButton.tsx';
import { htmlDocument, postWhenReady, SANDBOX_URL, SandboxFrame } from './Sandbox.tsx';
import { SidePanel } from './SidePanel.tsx';

const EMPTY: Artifact[] = [];
const RENDER_TIMEOUT = 10_000;
const LOAD_TIMEOUT = 30_000;
const TAB = 'data-active:bg-card data-active:shadow-sm dark:data-active:bg-card';

/** `</script` would end an inline script early and `<!--` can change how the parser reads it. */
const inline = (js: string) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const page = (body: string, head: string) =>
  htmlDocument(
    `<html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`,
    head,
  );

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
const phone = globalThis.matchMedia?.('(max-width: 767.98px)');
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
const figure = (kind: string, { title, subtitle, caption }: Lifted, body: string) =>
  `<figure class="${kind}">${title ? `<h2>${inlineHtml(title)}</h2>` : ''}${subtitle ? `<p>${inlineHtml(subtitle)}</p>` : ''}${body}${caption ? `<figcaption>${inlineHtml(caption)}</figcaption>` : ''}</figure>`;
const chartBody = ({ spec, lifted }: Chart, rt: string) =>
  `${figure('chart', lifted, '<div id="vis"></div>')}<script type="application/json" id="spec">${JSON.stringify(spec).replace(/</g, '\\u003c')}</script><script>${inline(rt)}</script>`;

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
/** Decisions 10 and 11: the kit, plus Plot and D3 when the source uses them. */
async function kitHead(a: Artifact, scheme: Scheme) {
  const plot = /\b(Plot|d3)\b/.test(a.content);
  const [{ t, fonts, head }, lib] = await Promise.all([
    themeHead(scheme),
    plot ? loadScript(plotUrl) : '',
  ]);
  return { head: lib ? `${head}<script>${inline(lib)}</script>` : head, theme: { t, fonts } };
}

async function documentFor(a: Artifact, scheme: Scheme): Promise<Doc> {
  if (a.kind === 'html') {
    const { head, theme } = await kitHead(a, scheme);
    return { html: htmlDocument(a.content, head), theme };
  }
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
    const [rt, code, { head, theme }] = await Promise.all([
      loadScript(runtimeUrl),
      transpile(a.content),
      kitHead(a, scheme),
    ]);
    const boot = `(function(){var exports={},module={exports:exports};function require(n){if(n==='react')return React;if(n==='react-dom/client'||n==='react-dom')return ReactDOMClient;throw new Error('Moduulia ei ole saatavilla: '+n)}try{${code}
;var C=module.exports.default||exports.default;ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(C))}catch(e){document.body.textContent='Virhe: '+e.message}})();`;
    return {
      html: page(
        `<div id="root"></div><script>${inline(rt)}</script><script>${inline(boot)}</script>`,
        head,
      ),
      theme,
    };
  }
  if (a.kind === 'mermaid') {
    const [{ default: mermaid }, { t, fonts, head }] = await Promise.all([
      import('mermaid'),
      themeHead(scheme),
    ]);
    // Decision 9: the `base` theme from our tokens. SVG labels (no HTML labels) keep the export
    // a plain SVG that a canvas can draw.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      // Flat shapes: Mermaid 12's `neo` look adds tinted drop shadows.
      look: 'classic',
      // Labels 14 px, 13 on phones.
      themeVariables: mermaidTheme(t, scheme === 'dark', phone?.matches ? 13 : 14),
      // Every diagram type that has the option; the per-type keys are deprecated but still read.
      htmlLabels: false,
      // Less label padding: a decision diamond grows with its label's box (phase-19 UI review).
      flowchart: { htmlLabels: false, padding: 8, nodeSpacing: 40, rankSpacing: 40 },
      class: { htmlLabels: false },
      // A parse error throws (the panel shows it) instead of drawing Mermaid's error SVG.
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(`m${a.id.replace(/\W/g, '')}`, roundDecisions(a.content));
    // R1 for diagrams: accTitle and accDescr as the heading and the caption.
    const { title, description: caption } = mermaidMeta(a.content);
    const lifted = { ...(title ? { title } : {}), ...(caption ? { caption } : {}) };
    return {
      html: page(figure('diagram', lifted, svg), head),
      svg,
      lifted,
      theme: { t, fonts },
    };
  }
  return { html: null };
}

const stem = (a: Artifact) =>
  a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti';

function download(a: Artifact) {
  saveFile(new Blob([a.content], { type: 'text/plain' }), `${stem(a)}.${artifactExt(a)}`);
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

/** The chart's SVG from the sandbox (decision 12): asked by postMessage, from that frame only. */
function askSvg(frame: HTMLIFrameElement | null): Promise<string> {
  const win = frame?.contentWindow;
  if (!win) return Promise.reject(new Error('ei kaaviota'));
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
    };
    const onMessage = (e: MessageEvent<{ type?: string; svg?: unknown }>) => {
      if (e.source !== win || e.data?.type !== 'viz-svg' || typeof e.data.svg !== 'string') return;
      done();
      resolve(e.data.svg);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('aikakatkaisu'));
    }, 10_000);
    addEventListener('message', onMessage);
    win.postMessage({ type: 'viz-svg' }, '*');
  });
}

/** "Lataa SVG" and "Lataa PNG": Mermaid's own output, or the chart's SVG from the sandbox. */
async function exportFigure(
  a: Artifact,
  format: 'svg' | 'png',
  source: string | HTMLIFrameElement | null,
  lifted: Lifted,
  { t, fonts }: { t: Tokens; fonts: string },
) {
  const inner = typeof source === 'string' ? source : await askSvg(source);
  const { svg, width, height } = framedSvg(inner, lifted, t, fonts);
  const blob =
    format === 'svg'
      ? new Blob([svg], { type: 'image/svg+xml' })
      : await pngBlob(svg, width, height);
  saveFile(blob, `${stem(a)}.${format}`);
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
  const mobile = useMobile();

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

  // A chart that fails inside the sandbox (Vega's own errors), or is not drawn within 10 s,
  // falls back like a refused spec.
  const chartHtml = doc?.rows ? doc.html : null;
  useEffect(() => {
    if (!chartHtml) return;
    const fail = (error: string) =>
      setDoc((d) => d && { ...d, html: null, refused: { error, rows: d.rows ?? [] } });
    // 10 s from the frame's "loaded" report (its script runs); a frame that never reports fails
    // after 30 s.
    let timer = setTimeout(() => fail('Kaavion piirto ei alkanut.'), LOAD_TIMEOUT);
    const onMessage = (e: MessageEvent<{ type?: string; message?: unknown }>) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'viz-loaded') {
        clearTimeout(timer);
        timer = setTimeout(() => fail('Kaavion piirto kesti yli 10 sekuntia.'), RENDER_TIMEOUT);
      }
      if (e.data?.type === 'viz-ready') clearTimeout(timer);
      if (e.data?.type === 'viz-error') fail(String(e.data.message));
    };
    addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
    };
  }, [chartHtml]);

  if (!open || !a) return null;
  const close = () => useStore.setState({ openArtifact: null });
  const copy = () =>
    void navigator.clipboard.writeText(a.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  const ready = doc?.id === a.id ? doc : null;
  const theme = ready?.html ? ready.theme : undefined;
  const exportable = (a.kind === 'vega-lite' || a.kind === 'mermaid') && theme;
  const exportAs = (format: 'svg' | 'png') => {
    if (!theme || !ready) return;
    exportFigure(a, format, ready.svg ?? frame.current, ready.lifted ?? {}, theme).catch(
      (err: unknown) =>
        useStore.getState().pushError(`Vienti epäonnistui: ${(err as Error).message}`),
    );
  };
  const title = <span className="truncate">{a.title}</span>;
  const code = (
    <pre
      translate="no"
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
    <SandboxFrame ref={frame} title={a.title} html={ready.html} themed={!!ready.theme} />
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
        {/* The tabs take a second row, so the title keeps the header's width. */}
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 border-b px-4">
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
          <TabsList className="order-last mb-2 w-full max-md:h-11!">
            {/* Selected: --card with --shadow-sm (brief 7.5), not the canvas colour. */}
            <TabsTrigger value="preview" className={TAB}>
              Esikatselu
            </TabsTrigger>
            <TabsTrigger value="code" className={TAB}>
              Koodi
            </TabsTrigger>
          </TabsList>
          {/* Phones: Kopioi is in the Lataa menu and the 44 px targets keep 8 px apart. */}
          {/* 32 px buttons 4 apart (44 px and 8 apart on phones): one pitch for all. */}
          <div className="flex gap-1 max-md:gap-2">
            {!mobile && (
              <IconButton label={copied ? 'Kopioitu' : 'Kopioi'} className="size-8" onClick={copy}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </IconButton>
            )}
            {/* One "Lataa" menu for every kind; four icons in the header (phase-19 UI review). */}
            <ActionMenu
              label="Lataa"
              className="size-8"
              Icon={Download}
              actions={[
                ...(exportable
                  ? [
                      { label: 'Lataa SVG', Icon: FileImage, run: () => exportAs('svg') },
                      { label: 'Lataa PNG', Icon: FileImage, run: () => exportAs('png') },
                    ]
                  : []),
                ...(mobile ? [{ label: 'Kopioi', Icon: Copy, run: copy }] : []),
                { label: 'Lataa lähdekoodi', Icon: FileCode, run: () => download(a) },
                // A code block opened from a message (`local-…`) has no artifact on the server.
                ...(a.id.startsWith('local-')
                  ? []
                  : [
                      {
                        label: 'Tallenna työkansioon',
                        Icon: Save,
                        run: () => void saveToWork(open.chatId, a.id),
                      },
                    ]),
              ]}
            />
            <IconButton
              label="Avaa uudessa ikkunassa"
              className="size-8"
              disabled={!ready?.html}
              onClick={() => openInTab(a, ready?.html ?? null)}
            >
              <ExternalLink size={16} />
            </IconButton>
            <IconButton label="Sulje artefaktit" className="size-8" onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
        </div>
        <TabsContent value="preview" className={cn('min-h-0 flex-1', !ready?.theme && 'p-3')}>
          {preview}
        </TabsContent>
        <TabsContent value="code" className="min-h-0 flex-1 p-3">
          {code}
        </TabsContent>
      </aside>
    </Tabs>
  );

  return (
    <SidePanel title={a.title} description="Artefakti" onClose={close}>
      {panel}
    </SidePanel>
  );
}
