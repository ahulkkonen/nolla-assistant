// Phase 20 (docs/decisions/phase-20-thread.md, decision 4): the one render and export path of
// artifacts, shared by the thread's inline figures and the artifact panel. The sandbox documents
// follow phase 19 (docs/decisions/phase-19-viz.md).
import { type Artifact, mermaidMeta } from '@pa/protocol';
import { saveFile } from '@/lib/utils';
import runtimeUrl from './artifact-runtime.ts?worker&url';
import { htmlDocument } from './components/Sandbox.tsx';
import kitCss from './kit.css?raw';
import plotUrl from './plot-runtime.ts?worker&url';
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
} from './viz.ts';
import vizUrl from './viz-runtime.ts?worker&url';

export type Scheme = 'light' | 'dark';

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

const phone = globalThis.matchMedia?.('(max-width: 767.98px)');

/** Fonts, the active theme's tokens and the kit, ahead of an artifact's own content (phase 19). */
async function themeHead(scheme: Scheme) {
  const fonts = await fontFaces();
  // Read after an await: App's theme effect runs after the caller's effect in the same commit.
  const t = readTokens();
  const head = `<meta name="color-scheme" content="${scheme}"><style>${fonts}${tokenSheet(t)}${kitCss}</style>`;
  return { t, fonts, head };
}

let worker: Worker | undefined;
let seq = 0;
function transpile(source: string): Promise<string> {
  worker ??= new Worker(new URL('./transpile.worker.ts', import.meta.url), { type: 'module' });
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

/** The R1 chart page: the lifted title as HTML, the spec as JSON, then the chart runtime. */
const figure = (kind: string, { title, subtitle, caption }: Lifted, body: string) =>
  `<figure class="${kind}">${title ? `<h2>${inlineHtml(title)}</h2>` : ''}${subtitle ? `<p>${inlineHtml(subtitle)}</p>` : ''}${body}${caption ? `<figcaption>${inlineHtml(caption)}</figcaption>` : ''}</figure>`;
const chartBody = ({ spec, lifted }: Chart, rt: string) =>
  `${figure('chart', lifted, '<div id="vis"></div>')}<script type="application/json" id="spec">${JSON.stringify(spec).replace(/</g, '\\u003c')}</script><script>${inline(rt)}</script>`;

/** The sandboxed document of an artifact; a chart also keeps what its export and fallback need. */
export type Doc = {
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

export async function documentFor(a: Artifact, scheme: Scheme): Promise<Doc> {
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
    // A parse error throws (the caller shows it) instead of drawing Mermaid's error SVG.
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

/** A file name from the artifact's title. */
export const stem = (a: Artifact) =>
  a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti';

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
export async function exportFigure(
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
