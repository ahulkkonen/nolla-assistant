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
  lightTokens,
  mermaidConfig,
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
/**
 * Decision 5: a figure page tells its frame its height (`viz-size`), once drawn and on every change
 * (a wider thread); the body's own height, so the frame's height never feeds back. A chart page
 * waits for its chart: its title alone would shrink the placeholder before the chart grows it.
 */
const SIZE = `<script>(function(){var h=0,v=document.getElementById('vis');new ResizeObserver(function(){var n=Math.ceil(document.body.getBoundingClientRect().height);if(n!==h&&!(v&&!v.firstChild)){h=n;parent.postMessage({type:'viz-size',height:n},'*')}}).observe(document.body)})()</script>`;

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
  return { t, head };
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
const chartBody = ({ spec, lifted }: Chart, rt: string, fill: boolean) =>
  `${figure(fill ? 'chart fill' : 'chart', lifted, '<div id="vis"></div>')}<script type="application/json" id="spec">${JSON.stringify(spec).replace(/</g, '\\u003c')}</script><script>${inline(rt)}</script>${SIZE}`;

/** The sandboxed document of an artifact; a chart also keeps the rows of its fallback table. */
export type Doc = { html: string | null; rows?: Row[]; refused?: Refused };
/** Decisions 10 and 11: the kit, plus Plot and D3 when the source uses them. */
async function kitHead(a: Artifact, scheme: Scheme) {
  const plot = /\b(Plot|d3)\b/.test(a.content);
  const [{ head }, lib] = await Promise.all([themeHead(scheme), plot ? loadScript(plotUrl) : '']);
  return lib ? `${head}<script>${inline(lib)}</script>` : head;
}

/**
 * Decision 26: subgraph titles paint over the edges. Each `g.cluster-label` moves to the end of
 * its `g.root` (its translate is in the root's coordinates, so it stays in place), and its empty
 * background rect gets the text's box plus 4 px, filled with the cluster colour by `themeCSS`: no
 * edge shows between the words. Measured in this page, where Mermaid measured too. Under 768 px
 * the diagram keeps its own width (labels stay 13 px) and its page scrolls sideways.
 */
function finishDiagram(svg: string) {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:0;left:-99999px;visibility:hidden';
  box.innerHTML = svg;
  document.body.append(box);
  try {
    const root = box.querySelector('svg');
    if (!root) return svg;
    for (const label of root.querySelectorAll('g.cluster-label')) {
      const text = label.querySelector('text');
      const bg = label.querySelector('rect.background');
      if (text && bg) {
        const b = text.getBBox();
        bg.setAttribute('x', String(b.x - 4));
        bg.setAttribute('y', String(b.y - 4));
        bg.setAttribute('width', String(b.width + 8));
        bg.setAttribute('height', String(b.height + 8));
      }
      label.closest('g.root')?.append(label);
    }
    const width = root.viewBox.baseVal?.width;
    if (phone?.matches && width) {
      root.setAttribute('width', String(width));
      root.style.maxWidth = 'none';
    }
    return new XMLSerializer().serializeToString(root);
  } finally {
    box.remove();
  }
}

let diagrams: Promise<unknown> = Promise.resolve();
/** Mermaid's SVG with the theme of `t`. Its config is global: each render runs alone. */
function diagram(a: Artifact, t: Tokens, dark: boolean): Promise<string> {
  const run = diagrams.then(async () => {
    const [{ default: mermaid }] = await Promise.all([
      import('mermaid'),
      // Mermaid measures labels with Inter: it must be loaded first (decision 19).
      document.fonts.load('12px "Inter Variable"'),
    ]);
    // Labels 14 px, 13 on phones.
    mermaid.initialize(mermaidConfig(t, dark, phone?.matches ? 13 : 14));
    const id = `m${a.id.replace(/\W/g, '')}`;
    return finishDiagram((await mermaid.render(id, roundDecisions(a.content))).svg);
  });
  diagrams = run.catch(() => {});
  return run;
}

/** R1 for diagrams: accTitle and accDescr as the heading and the caption. */
const diagramText = (a: Artifact): Lifted => {
  const { title, description: caption } = mermaidMeta(a.content);
  return { ...(title ? { title } : {}), ...(caption ? { caption } : {}) };
};

/** `fill`: the panel's page, where a single-view chart takes the page's height (the thread's keeps its own). */
export async function documentFor(a: Artifact, scheme: Scheme, fill = false): Promise<Doc> {
  if (a.kind === 'html') return { html: htmlDocument(a.content, await kitHead(a, scheme)) };
  if (a.kind === 'vega-lite') {
    const [{ t, head }, rt] = await Promise.all([themeHead(scheme), loadScript(vizUrl)]);
    const chart = prepareChart(a.content, t);
    if ('error' in chart) return { html: null, refused: chart };
    const single = 'mark' in chart.spec || 'layer' in chart.spec;
    if (fill && single) {
      chart.spec.height = 'container';
      chart.spec.autosize = { type: 'fit', contains: 'padding' };
    }
    return { html: page(chartBody(chart, rt, fill && single), head), rows: chart.rows };
  }
  if (a.kind === 'react') {
    const [rt, code, head] = await Promise.all([
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
    };
  }
  const { t, head } = await themeHead(scheme);
  const svg = await diagram(a, t, scheme === 'dark');
  // A wide diagram scrolls sideways on phones; a scrollable region is focusable.
  const body = `<div class="scroll" tabindex="0">${svg}</div>`;
  return { html: page(`${figure('diagram', diagramText(a), body)}${SIZE}`, head) };
}

/** A file name from the artifact's title. */
export const stem = (a: Artifact) =>
  a.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'artefakti';

/**
 * The SVG of `spec` from the chart's sandbox (decision 7): drawn there off screen, asked and
 * answered by postMessage, from that frame only.
 */
function askSvg(frame: HTMLIFrameElement | null, spec: Chart['spec']): Promise<string> {
  const win = frame?.contentWindow;
  if (!win) return Promise.reject(new Error('ei kaaviota'));
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
    };
    const onMessage = (e: MessageEvent<{ type?: string; svg?: unknown; error?: unknown }>) => {
      if (e.source !== win || e.data?.type !== 'viz-svg') return;
      done();
      if (typeof e.data.svg === 'string') resolve(e.data.svg);
      else reject(new Error(String(e.data.error ?? 'kaavio')));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('aikakatkaisu'));
    }, 10_000);
    addEventListener('message', onMessage);
    win.postMessage({ type: 'viz-svg', spec }, '*');
  });
}

/**
 * "Lataa SVG" and "Lataa PNG", always in the light theme (decision 7): a diagram is drawn again,
 * a chart is asked from its sandbox `frame`.
 */
export async function exportFigure(
  a: Artifact,
  format: 'svg' | 'png',
  frame: HTMLIFrameElement | null,
) {
  const [t, fonts] = await Promise.all([lightTokens(), fontFaces()]);
  let inner: string;
  let lifted: Lifted;
  if (a.kind === 'mermaid') [inner, lifted] = [await diagram(a, t, false), diagramText(a)];
  else {
    const chart = prepareChart(a.content, t);
    if ('error' in chart) throw new Error(chart.error);
    [inner, lifted] = [await askSvg(frame, chart.spec), chart.lifted];
  }
  const { svg, width, height } = framedSvg(inner, lifted, t, fonts);
  const blob =
    format === 'svg'
      ? new Blob([svg], { type: 'image/svg+xml' })
      : await pngBlob(svg, width, height);
  saveFile(blob, `${stem(a)}.${format}`);
}
