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
  balance,
  type Chart,
  columnar,
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
  WRAP,
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

/** `a` blended with `f` of `b`; both `#rrggbb`. */
const mix = (a: string, b: string, f: number) =>
  `#${[1, 3, 5]
    .map((i) => {
      const [x, y] = [a, b].map((c) => Number.parseInt(c.slice(i, i + 2), 16));
      return Math.round((x ?? 0) * (1 - f) + (y ?? 0) * f)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;

/** The cluster header strip's height: 28, 32 on phones (UI review round 4). */
export const stripHeight = () => (phone?.matches ? 32 : 28);

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
};
const translate = (el: Element) => {
  const m = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/.exec(el.getAttribute('transform') ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const even = (v: number) => 2 * Math.ceil(v / 2);
/** A word that is one emoji (with its variation selector, skin tone or joined parts). */
const EMOJI =
  /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]*$/u;
/** Inter's cap height: the text block is centred on its caps. */
const cap = (size: number) => 0.727 * size;

/**
 * Phase-21 decision 1 ("Sarake"): node, row and edge measures, desktop and phone.
 * ponytail: phone nodes are 150 px (not the record's 184) so two columns and the 24 px gap fit
 * the 326 px thread at 390 px; three columns still scroll sideways with fades.
 */
const sarake = (size: number) => ({
  size,
  width: size < 14 ? 150 : 212,
  padX: size < 14 ? 12 : 16,
  padY: size < 14 ? 12 : 13,
  lh: size + 6,
  gap: 5,
  nodeGap: 24,
  rankGap: 36,
  radius: 10,
});
type Sarake = ReturnType<typeof sarake>;

/**
 * An edge label as one line of small capitals on a --card plate, centred on its group's origin;
 * the plate's width.
 */
function edgeLabel(g: Element, text: string) {
  g.replaceChildren();
  const plate = svgEl('rect', { class: 'background', rx: 3 }, g);
  const t = svgEl('text', {}, g) as SVGTextElement;
  t.textContent = text.toLocaleUpperCase('fi');
  // The tracking after the last letter is not ink.
  const w = t.getComputedTextLength() - 0.06 * 11;
  t.setAttribute('x', (-w / 2).toFixed(2));
  t.setAttribute('y', (cap(11) / 2).toFixed(2));
  for (const [k, v] of Object.entries({ x: -w / 2 - 5, y: -8.5, width: w + 10, height: 17 }))
    plate.setAttribute(k, String(v));
  return w + 10;
}

type Node = {
  g: SVGGElement;
  x: number;
  /** Mermaid's box, top and bottom. */
  y0: number;
  y1: number;
  W: number;
  H: number;
  /** The drawing's centre from the node's origin (Mermaid's own shapes). */
  dy: number;
  nx: number;
  top: number;
  row: number;
};

/**
 * A rect, rounded rect or stadium node (the decision of `roundDecisions`) becomes a box of the
 * fixed width with its words in even, centred lines; an emoji first in the label gets its own
 * size and a fixed gap before the words. ponytail: Mermaid's line breaks and markdown runs go;
 * the label is plain words. Other shapes keep Mermaid's drawing.
 */
function typeset(n: Node, o: Sarake) {
  const { g } = n;
  const decision = g.classList.contains('decision');
  if (!decision && !g.querySelector(':scope > rect.label-container')) return;
  const rows = [...g.querySelectorAll<SVGTSpanElement>('.text-outer-tspan')];
  // Mermaid breaks a word wider than its wrapping width inside it: that row is one word that
  // fills the width. ponytail: a whole word of 184–200 px at a row's end reads as broken too.
  const words = rows
    .map((r, i) => {
      const prev = rows[i - 1];
      const broken = prev?.childElementCount === 1 && prev.getComputedTextLength() > WRAP - 16;
      return (broken ? '' : ' ') + (r.textContent ?? '');
    })
    .join('')
    .split(/[ \t\n]+/)
    .filter(Boolean);
  const emoji = words[0] && EMOJI.test(words[0]) ? words.shift() : undefined;
  g.replaceChildren();
  const shape = svgEl('rect', { class: 'shape' }, g);
  const text = svgEl('text', {}, g);
  const probe = svgEl('tspan', {}, text) as SVGTSpanElement;
  const measure = (s: string, cls = '') => {
    probe.setAttribute('class', cls);
    probe.textContent = s;
    return probe.getComputedTextLength();
  };
  const widths = words.map((w) => measure(w));
  const space = measure('n n') - measure('nn');
  const lead = emoji ? measure(emoji, 'emo') + o.gap : 0;
  probe.remove();
  const lines = balance(widths, space, o.width - 2 * o.padX, lead).map((line) =>
    line.map((i) => words[i]).join(' '),
  );
  const spans = lines.map((s) => {
    const t = svgEl('tspan', {}, text) as SVGTSpanElement;
    t.textContent = s;
    return t;
  });
  const ink = spans.map((t, k) => t.getComputedTextLength() + (k ? 0 : lead));
  // A word wider than the box widens it.
  const W = even(Math.max(o.width, Math.max(...ink) + 2 * o.padX));
  const H = even((lines.length - 1) * o.lh + cap(o.size) + 2 * o.padY);
  const y0 = -H / 2 + o.padY + cap(o.size);
  spans.forEach((t, k) => {
    t.setAttribute('x', (-(ink[k] ?? 0) / 2 + (k ? 0 : lead)).toFixed(2));
    t.setAttribute('y', (y0 + k * o.lh).toFixed(2));
  });
  if (emoji) {
    const e = svgEl('tspan', {
      class: 'emo',
      x: (-(ink[0] ?? 0) / 2).toFixed(2),
      y: y0.toFixed(2),
    });
    e.textContent = emoji;
    text.prepend(e);
  }
  // The 1 px hairline on the pixel grid: the box's edges are whole pixels, the stroke inside them.
  for (const [k, v] of Object.entries({
    x: -W / 2 + 0.5,
    y: -H / 2 + 0.5,
    width: W - 1,
    height: H - 1,
    rx: o.radius,
  }))
    shape.setAttribute(k, String(v));
  Object.assign(n, { W, H, dy: 0 });
}

type Point = [number, number];
/** An orthogonal polyline as a path with rounded corners (at most half of each leg). */
function corners(points: Point[], r: number) {
  const p = points.filter(
    (q, i) => !i || q[0] !== points[i - 1]?.[0] || q[1] !== points[i - 1]?.[1],
  );
  // Drop the middle of three points on one line.
  const q = p.filter((b, i) => {
    const [a, c] = [p[i - 1], p[i + 1]];
    return !a || !c || (b[0] - a[0]) * (c[1] - b[1]) !== (b[1] - a[1]) * (c[0] - b[0]);
  });
  let d = `M${q[0]?.join(',')}`;
  for (let i = 1; i < q.length - 1; i++) {
    const [a, b, c] = [q[i - 1], q[i], q[i + 1]] as [Point, Point, Point];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const u = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1] as const;
    const v = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2] as const;
    const sweep = u[0] * v[1] - u[1] * v[0] > 0 ? 1 : 0;
    d += `L${b[0] - u[0] * rr},${b[1] - u[1] * rr}A${rr},${rr} 0 0 ${sweep} ${b[0] + v[0] * rr},${b[1] + v[1] * rr}`;
  }
  return `${d}L${q.at(-1)?.join(',')}`;
}

/** The free x nearest to both ends (`to` wins a tie) outside every blocked interval. */
function channel(blocked: [number, number][], from: number, to: number) {
  const free = (x: number) => !blocked.some(([a, b]) => x > a && x < b);
  let best = to;
  let cost = Number.POSITIVE_INFINITY;
  for (const x of [to, from, ...blocked.flat()]) {
    const c = Math.abs(x - from) + Math.abs(x - to);
    if (free(x) && c < cost) [best, cost] = [x, c];
  }
  return best;
}

/**
 * Phase-21 decision 1 for a top-to-bottom flowchart: every node is set in the fixed width
 * (`typeset`), rows keep Mermaid's order and are top-aligned with a fixed gap, x scales so the
 * tightest pair of a row is 24 px apart, subgraph frames are drawn again around their nodes with
 * room for the title strip, and edges are redrawn as right-angle connectors with rounded corners.
 * An edge that skips rows or goes back up runs in the nearest free channel, so it crosses no node
 * and no other subgraph. False when the layout is not one this pass knows: an isolated subgraph
 * that Mermaid laid out on its own (a nested root).
 * ponytail: a node beside a frame in a row where the frame has no node may touch the frame.
 */
function columns(svg: SVGSVGElement, o: Sarake, strip: number) {
  const root = svg.querySelector<SVGGElement>(':scope > g > g.root');
  if (!root || root.querySelector(':scope > .nodes > .root')) return false;
  // Mermaid's empty placeholders of a self loop.
  for (const d of root.querySelectorAll(':scope > .nodes > :not(.node)')) d.remove();
  const nodes = new Map<string, Node>();
  for (const g of root.querySelectorAll<SVGGElement>(':scope > .nodes > .node')) {
    const key = /flowchart-(.+)-\d+$/.exec(g.id)?.[1];
    if (!key) continue;
    const [x = 0, y = 0] = translate(g);
    const b = g.getBBox();
    const n: Node = {
      g,
      x,
      y0: y + b.y,
      y1: y + b.y + b.height,
      W: b.width,
      H: b.height,
      dy: b.y + b.height / 2,
      nx: 0,
      top: 0,
      row: 0,
    };
    typeset(n, o);
    nodes.set(key, n);
  }
  if (!nodes.size) return false;
  const list = [...nodes.values()];

  // Rows: Mermaid's ranks (a node whose middle is inside the first node's box joins its row).
  const rows: Node[][] = [];
  for (const n of [...list].sort((a, b) => a.y0 - b.y0)) {
    const r = rows.at(-1);
    const mid = (n.y0 + n.y1) / 2;
    if (r?.[0] && mid > r[0].y0 && mid < r[0].y1) r.push(n);
    else rows.push([n]);
    n.row = rows.length - 1;
  }

  // Subgraph frames and the nodes inside each, from Mermaid's layout; inner frames first.
  type Frame = {
    rect: SVGRectElement;
    nodes: Node[];
    inner: Frame[];
    first: number;
    last: number;
    box?: [number, number, number, number];
  };
  const frames: Frame[] = [
    ...root.querySelectorAll<SVGRectElement>(':scope > .clusters > .cluster > rect'),
  ]
    .map((rect) => {
      const b = rect.getBBox();
      const inside = list.filter(
        (n) => n.x > b.x && n.x < b.x + b.width && n.y0 > b.y && n.y1 < b.y + b.height,
      );
      return {
        rect,
        nodes: inside,
        inner: [],
        first: Math.min(...inside.map((n) => n.row)),
        last: Math.max(...inside.map((n) => n.row)),
        area: b.width * b.height,
      };
    })
    .filter((f) => f.nodes.length)
    .sort((a, b) => a.area - b.area);
  frames.forEach((f, k) => {
    f.inner = frames.slice(0, k).filter((i) => i.nodes.every((n) => f.nodes.includes(n)));
  });
  const PAD = 16;
  const head = strip + 24;
  // How many frames nest at the top (bottom) edge of row `i`.
  const depth = (edge: 'first' | 'last', i: number) =>
    Math.max(
      0,
      ...frames
        .filter((f) => f[edge] === i)
        .map((f) => frames.filter((g) => g[edge] === i && (g === f || g.inner.includes(f))).length),
    );
  const starts = (i: number) => depth('first', i);
  const ends = (i: number) => depth('last', i);

  // Rows top-aligned; a gap that a frame starts or ends in also holds its margins.
  const tops: number[] = [];
  const bottoms: number[] = [];
  let y = 0;
  rows.forEach((r, i) => {
    if (i) y += Math.max(o.rankGap, ends(i - 1) * PAD + starts(i) * head + 24);
    for (const n of r) n.top = y;
    tops.push(y);
    y += Math.max(...r.map((n) => n.H));
    bottoms.push(y);
  });
  /** The y of the free band above row `i` (`rows.length`: below the last row). */
  const band = (i: number) => {
    const lo = i
      ? (bottoms[i - 1] ?? 0) + ends(i - 1) * PAD
      : (tops[0] ?? 0) - starts(0) * head - 36;
    const hi = i < rows.length ? (tops[i] ?? 0) - starts(i) * head : lo + 36;
    return Math.round((lo + hi) / 2);
  };

  // x scales so the tightest pair of a row has the node gap (and a frame's margin per wall).
  let k = 0;
  for (const r of rows) {
    r.sort((a, b) => a.x - b.x);
    for (let i = 1; i < r.length; i++) {
      const [a, b] = [r[i - 1], r[i]] as [Node, Node];
      const walls = frames.filter((f) => f.nodes.includes(a) !== f.nodes.includes(b)).length;
      k = Math.max(k, (a.W / 2 + b.W / 2 + o.nodeGap + walls * PAD) / Math.max(b.x - a.x, 1));
    }
  }
  k ||= 1;
  // Nodes within 3 px of a column share its x: no kink in a straight edge.
  let col = Number.NEGATIVE_INFINITY;
  for (const n of [...list].sort((a, b) => a.x - b.x)) {
    n.nx = Math.round(n.x * k);
    if (n.nx - col < 3) n.nx = col;
    else col = n.nx;
    n.g.setAttribute('transform', `translate(${n.nx}, ${n.top + n.H / 2 - n.dy})`);
  }

  for (const f of frames) {
    const [x0, y0, x1, y1] = [
      Math.min(...f.nodes.map((n) => n.nx - n.W / 2), ...f.inner.map((i) => i.box?.[0] ?? 0)) - PAD,
      Math.min(...f.nodes.map((n) => n.top), ...f.inner.map((i) => i.box?.[1] ?? 0)) - head,
      Math.max(...f.nodes.map((n) => n.nx + n.W / 2), ...f.inner.map((i) => i.box?.[2] ?? 0)) + PAD,
      Math.max(...f.nodes.map((n) => n.top + n.H), ...f.inner.map((i) => i.box?.[3] ?? 0)) + PAD,
    ];
    // The title fits its strip (12 px in from each side).
    const title = f.rect.parentElement?.querySelector<SVGGElement>('.cluster-label');
    const grow = Math.max(0, ((title?.getBBox().width ?? 0) + 24 - (x1 - x0)) / 2);
    f.box = [Math.floor(x0 - grow), y0, Math.ceil(x1 + grow), y1];
    for (const [a, v] of Object.entries({
      x: f.box[0],
      y: y0,
      width: f.box[2] - f.box[0],
      height: y1 - y0,
    }))
      f.rect.setAttribute(a, String(v));
  }

  for (const l of root.querySelectorAll(':scope > .edgeLabels > .edgeLabel'))
    if (!l.textContent?.trim()) l.remove();
  for (const p of root.querySelectorAll<SVGPathElement>(':scope > .edgePaths > path')) {
    // Mermaid classes each edge `LS-<from> LE-<to>`; the id joins them with `_`, which an id may hold.
    const cls = [...p.classList];
    const s = nodes.get(cls.find((c) => c.startsWith('LS-'))?.slice(3) ?? '');
    const t = nodes.get(cls.find((c) => c.startsWith('LE-'))?.slice(3) ?? '');
    if (!s || !t) continue;
    const label = root
      .querySelector(`:scope > .edgeLabels .label[data-id="${CSS.escape(p.dataset.id ?? '')}"]`)
      ?.closest('.edgeLabel');
    const lw = label?.textContent?.trim() ? edgeLabel(label, label.textContent.trim()) : 0;
    // The arrowhead's tip (Mermaid's marker reaches 4 px past the path) on the node's edge.
    const end = t.top - (p.getAttribute('marker-end') ? 4 : 0);
    const [sx, sy, tx] = [s.nx, s.top + s.H, t.nx];
    let points: [number, number][];
    let at: [number, number];
    if (t.row === s.row + 1) {
      const my = band(t.row);
      points = [
        [sx, sy],
        [sx, my],
        [tx, my],
        [tx, end],
      ];
      // On the line; a short bend keeps it under the source, clear of the arrowhead.
      at =
        sx === tx
          ? [sx, (sy + t.top) / 2]
          : Math.abs(tx - sx) > lw + 2 * o.radius + 8
            ? [(sx + tx) / 2, my]
            : [sx, (sy + my) / 2];
    } else {
      // Down past the rows between, or back up beside the rows from the target to the source.
      const [a, b] = t.row > s.row ? [s.row + 1, t.row - 1] : [t.row, s.row];
      const [ya, yb] = [band(s.row + 1), band(t.row)];
      const pad = Math.max(12, lw / 2 + 4);
      const blocked: [number, number][] = [
        ...list
          .filter((n) => n.row >= a && n.row <= b)
          .map((n): [number, number] => [n.nx - n.W / 2 - pad, n.nx + n.W / 2 + pad]),
        ...frames
          // Down past the frames of neither end; back up outside every frame but a shared one.
          .filter((f) =>
            t.row > s.row
              ? !f.nodes.includes(s) && !f.nodes.includes(t)
              : !(f.nodes.includes(s) && f.nodes.includes(t)),
          )
          .filter((f) => f.box && f.box[1] < Math.max(ya, yb) && f.box[3] > Math.min(ya, yb))
          .map((f): Point => [(f.box?.[0] ?? 0) - pad, (f.box?.[2] ?? 0) + pad]),
      ];
      const cx = Math.round(channel(blocked, sx, tx));
      // A side of `n` toward the channel, when no node of its row is in between.
      const side = (n: Node) => {
        const x = n.nx + Math.sign(cx - n.nx) * (n.W / 2);
        const clear = !list.some(
          (m) =>
            m !== n &&
            m.row === n.row &&
            m.nx + m.W / 2 > Math.min(x, cx) &&
            m.nx - m.W / 2 < Math.max(x, cx),
        );
        return clear && cx !== n.nx ? x : undefined;
      };
      // A loop back up leaves its source and enters its target from the side.
      const back = t.row <= s.row;
      const out = back && t.row < s.row ? side(s) : undefined;
      const into = back ? side(t) : undefined;
      const start: Point[] =
        out === undefined
          ? [
              [sx, sy],
              [sx, ya],
              [cx, ya],
            ]
          : [
              [out, s.top + s.H / 2],
              [cx, s.top + s.H / 2],
            ];
      const stop: Point[] =
        into === undefined
          ? [
              [cx, yb],
              [tx, yb],
              [tx, end],
            ]
          : [
              [cx, t.top + t.H / 2],
              [into - Math.sign(into - cx) * (end === t.top ? 0 : 4), t.top + t.H / 2],
            ];
      points = [...start, ...stop];
      at = [cx, ((start.at(-1)?.[1] ?? 0) + (stop[0]?.[1] ?? 0)) / 2];
    }
    p.setAttribute('d', corners(points, o.radius));
    p.removeAttribute('data-points');
    if (lw && label) label.setAttribute('transform', `translate(${at[0]}, ${Math.round(at[1])})`);
  }
  return true;
}

/**
 * Decision 26 as the UI review settled it: a subgraph's title is a header strip the cluster's
 * full inner width, its text left-aligned 12 px in and centred, painted above the edges, so an
 * entering edge passes under a bar instead of through a word. The strip is the band blended 12 %
 * toward the text colour (1.2:1 or more on the band in both themes). Measured in this page, where
 * Mermaid measured too. Phase 21: a top-to-bottom flowchart gets the column pass first; any other
 * flowchart gets its edge labels in small capitals.
 */
function finishDiagram(svg: string, t: Tokens, size: number, column: boolean) {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:0;left:-99999px;visibility:hidden';
  box.innerHTML = svg;
  document.body.append(box);
  try {
    let root = box.querySelector('svg');
    if (!root) return svg;
    const strip = stripHeight();
    const flowchart = root.classList.contains('flowchart');
    // A stadium is the decision of `roundDecisions` (other diagram kinds draw boxes so too).
    const decisions = (svg: SVGSVGElement) => {
      if (flowchart)
        for (const g of svg.querySelectorAll('.node'))
          if (g.querySelector(':scope > g.outer-path')) g.classList.add('decision');
    };
    decisions(root);
    let laid = false;
    try {
      laid = column && columns(root, sarake(size), strip);
    } catch {
      // A layout this pass does not know keeps Mermaid's own.
      box.innerHTML = svg;
      root = box.querySelector('svg') as SVGSVGElement;
      decisions(root);
    }
    if (flowchart && !laid)
      for (const label of root.querySelectorAll('.edgeLabel'))
        if (label.textContent?.trim()) edgeLabel(label, label.textContent.trim());
        else label.remove();
    for (const label of root.querySelectorAll<SVGGElement>('g.cluster-label')) {
      const g = label.closest<SVGGElement>('g.root');
      const frame = label.closest('g.cluster')?.querySelector<SVGRectElement>(':scope > rect');
      const text = label.querySelector('text');
      if (!g || !frame || !text) continue;
      // The frame in the root's coordinates (no rotation in a Mermaid layout).
      const f = frame.getBBox();
      const m = (g.getCTM() as DOMMatrix).inverse().multiply(frame.getCTM() as DOMMatrix);
      const [x, y, w] = [f.x * m.a + m.e + 1, f.y * m.d + m.f + 1, f.width * m.a - 2];
      const bar = document.createElementNS(NS, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: w, height: strip }))
        bar.setAttribute(k, String(v));
      bar.setAttribute('class', 'cluster-strip');
      bar.setAttribute('fill', mix(t['chart-band'], t.foreground, 0.12));
      const b = text.getBBox();
      label.setAttribute(
        'transform',
        `translate(${x + 12 - b.x}, ${y + (strip - b.height) / 2 - b.y})`,
      );
      g.append(bar, label);
    }
    if (laid) {
      // The view box around the new drawing, on whole pixels.
      const b = (root.querySelector(':scope > g') as SVGGElement).getBBox();
      const [x, y] = [Math.floor(b.x) - 8, Math.floor(b.y) - 8];
      const [w, h] = [Math.ceil(b.x + b.width) + 8 - x, Math.ceil(b.y + b.height) + 8 - y];
      root.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
      root.style.maxWidth = `${w}px`;
    }
    // Other diagram kinds: an edge stops short of its label (5 px beside it, 2 above and below),
    // and the label sits 3 px above the edge's middle, so a 12 px shaft shows above the arrowhead.
    if (!flowchart)
      for (const bg of root.querySelectorAll<SVGRectElement>('.edgeLabel rect.background')) {
        const b = bg.getBBox();
        if (!b.width) continue;
        bg.setAttribute('x', String(b.x - 5));
        bg.setAttribute('y', String(b.y - 2));
        bg.setAttribute('width', String(b.width + 10));
        bg.setAttribute('height', String(b.height + 4));
        const label = bg.closest('g.edgeLabel');
        const at = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(
          label?.getAttribute('transform') ?? '',
        );
        if (label && at)
          label.setAttribute('transform', `translate(${at[1]}, ${Number(at[2]) - 3})`);
      }
    return new XMLSerializer().serializeToString(root);
  } finally {
    box.remove();
  }
}

/**
 * Phase-20 UI review: a diagram scales to the page's width while it keeps at least 0.85 of its
 * size; narrower, it keeps its size and scrolls sideways from the centre, with a fade at each edge
 * that has more (no node is cut without a sign). A scrollable region is focusable.
 */
function fitted(svg: string) {
  const width = Number(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(svg)?.[1]) || 0;
  const style = `<style>.scroll svg{width:${width}px}@container (min-width:${Math.ceil(width * 0.85)}px){.scroll svg{width:100%}}</style>`;
  const fade = `<script>(function(){var s=document.querySelector('.scroll');function f(){var m=s.scrollWidth-s.clientWidth;s.classList.toggle('l',s.scrollLeft>1);s.classList.toggle('r',s.scrollLeft<m-1)}s.scrollLeft=(s.scrollWidth-s.clientWidth)/2;s.addEventListener('scroll',f);new ResizeObserver(f).observe(s);f()})()</script>`;
  return `${style}<div class="scroll" tabindex="0">${svg}</div>${fade}`;
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
    const size = phone?.matches ? 13 : 14;
    mermaid.initialize(mermaidConfig(t, dark, size, stripHeight()));
    const id = `m${a.id.replace(/\W/g, '')}`;
    const { svg } = await mermaid.render(id, roundDecisions(a.content));
    return finishDiagram(svg, t, size, columnar(a.content));
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
      // About one y tick per 100 px of the panel's plot, 5 to 7 lines as in the thread.
      const config = chart.spec.config as { axisY?: object };
      config.axisY = { ...config.axisY, tickCount: { expr: 'ceil(height / 100)' } };
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
  return { html: page(`${figure('diagram', diagramText(a), fitted(svg))}${SIZE}`, head) };
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
