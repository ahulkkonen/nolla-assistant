// Phase 19 (docs/decisions/phase-19-viz.md): the parent-page half of the chart renderer. The
// spec guard and the theme builders are pure; `readTokens` and the font loader touch the DOM.
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import serifUrl from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url';
import type { MermaidConfig } from 'mermaid';
import { z } from 'zod';

type Obj = Record<string, unknown>;
export type Row = Record<string, unknown>;

const NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'muted',
  'muted-foreground',
  'secondary',
  'border',
  'input',
  'link',
  'info',
  'info-subtle',
  'destructive',
  'destructive-subtle',
  'success',
  'success-subtle',
  'warning-subtle',
  'warning-line',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-faint',
  'chart-band',
  'chart-accent-soft',
  'font-sans',
  'font-serif',
  'font-mono',
] as const;
export type Tokens = Record<(typeof NAMES)[number], string>;
const CHART = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'] as const;

/**
 * The token values of `root` (Vega and Mermaid need literal values, not `var()`); by default the
 * active theme's.
 */
export function readTokens(root: Element = document.documentElement): Tokens {
  const cs = (root.ownerDocument.defaultView ?? window).getComputedStyle(root);
  return Object.fromEntries(NAMES.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])) as Tokens;
}

let light: Promise<Tokens> | undefined;
/**
 * The light theme's tokens for every export (phase-20 decision 7): a hidden same-origin frame
 * with `data-theme="light"` and the app's own style sheets, so tokens.css stays the one source.
 */
export function lightTokens() {
  light ??= new Promise<Tokens>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    const sheets = [...document.querySelectorAll('link[rel="stylesheet"], style')];
    frame.srcdoc = `<!doctype html><html data-theme="light"><head>${sheets.map((n) => n.outerHTML).join('')}</head></html>`;
    frame.onload = () => {
      const root = frame.contentDocument?.documentElement;
      if (root) resolve(readTokens(root));
      else reject(new Error('teema'));
      frame.remove();
    };
    document.body.append(frame);
  });
  // A failed read is tried again on the next export.
  light.catch(() => {
    light = undefined;
  });
  return light;
}

/** `:root { --name: value }` of the active theme, for the sandbox page (decision 4). */
export const tokenSheet = (t: Tokens) => `:root{${NAMES.map((n) => `--${n}:${t[n]}`).join(';')}}`;

/** R7: the colour roles the model may write; `@c1`..`@c6` are the six chart colours (phase 20). */
export const roles = (t: Tokens): Record<string, string> => ({
  fg: t.foreground,
  muted: t['muted-foreground'],
  faint: t['chart-faint'],
  accent: t['chart-1'],
  'accent-soft': t['chart-accent-soft'],
  band: t['chart-band'],
  ...Object.fromEntries(CHART.map((n, i) => [`c${i + 1}`, t[n]])),
});

/** R2: the theme config; the model never writes one. */
export function vegaConfig(t: Tokens): Obj {
  const sans = t['font-sans'];
  const label = { labelFont: sans, labelFontSize: 12, labelColor: t['muted-foreground'] };
  const title = {
    titleFont: sans,
    titleFontSize: 12,
    titleFontWeight: 500,
    titleColor: t['muted-foreground'],
  };
  return {
    background: t.card,
    font: sans,
    view: { stroke: null, continuousHeight: 240 },
    axis: {
      ...label,
      ...title,
      gridColor: t.border,
      domainColor: t.border,
      tickColor: t.border,
      domain: false,
      ticks: false,
      labelPadding: 8,
      labelAngle: 0,
      labelLimit: 140,
      titlePadding: 8,
    },
    // Labels closer than 12 px drop every second one (phase-20 UI review: "toukokesä").
    axisX: { grid: false, labelOverlap: 'parity', labelSeparation: 12 },
    // The unit as horizontal text above the top tick, not a rotated title (as Plot's).
    axisY: {
      titleAngle: 0,
      titleAnchor: 'end',
      titleAlign: 'left',
      titleBaseline: 'bottom',
      titleX: 0,
      titleY: -8,
    },
    legend: { ...label, ...title, labelColor: t.foreground, orient: 'top', symbolType: 'circle' },
    header: { labelFont: sans, labelColor: t.foreground, titleFont: sans },
    text: { font: sans, fontSize: 13, color: t.foreground },
    mark: { color: t['chart-1'] },
    bar: { cornerRadiusEnd: 4 },
    scale: { bandPaddingInner: 0.25 },
    // As a style, not mark config: Vega-Lite bakes mark config over an encoded strokeWidth.
    style: { line: { strokeWidth: 2 } },
    point: { filled: true },
    rule: { color: t['chart-faint'] },
    // Phase-20 decision 23: no new hue. A quantitative colour field gets the sequential band to
    // blue, one with `domainMid` the diverging clay to teal (both ends tell apart for red-green
    // colour blindness); `scheme` stays dropped.
    range: {
      category: CHART.map((n) => t[n]),
      ramp: [t['chart-band'], t['chart-3']],
      heatmap: [t['chart-band'], t['chart-3']],
      diverging: [t['chart-1'], t['chart-band'], t['chart-2']],
      ordinal: { scheme: [t['chart-band'], t['chart-3']] },
    },
  };
}

/** Mermaid `base` theme variables (decision 9). */
export const mermaidTheme = (t: Tokens, dark: boolean, fontSize = 14) => ({
  darkMode: dark,
  fontFamily: t['font-sans'],
  fontSize: `${fontSize}px`,
  background: t.card,
  // Nodes on --card with the --input border (3.5:1), inside a subgraph's band and outside it.
  mainBkg: t.card,
  primaryColor: t.card,
  primaryTextColor: t.foreground,
  primaryBorderColor: t.input,
  secondaryColor: t['chart-accent-soft'],
  secondaryTextColor: t.foreground,
  secondaryBorderColor: t['chart-1'],
  tertiaryColor: t['chart-band'],
  tertiaryTextColor: t.foreground,
  tertiaryBorderColor: t['chart-faint'],
  lineColor: t['muted-foreground'],
  textColor: t.foreground,
  noteBkgColor: t['info-subtle'],
  noteTextColor: t.foreground,
  noteBorderColor: t.info,
  edgeLabelBackground: t.card,
  actorBkg: t.secondary,
  actorBorder: t.input,
  actorTextColor: t.foreground,
  signalColor: t['muted-foreground'],
  signalTextColor: t.foreground,
  labelBoxBkgColor: t.secondary,
  labelTextColor: t.foreground,
  // The subgraph title's halo has the same colour (phase-20 decision 26).
  clusterBkg: t['chart-band'],
});

/**
 * Mermaid's own `secure` keys plus the theme's (phase-20 decision 21): a model's `%%{init}%%`
 * directive or front matter `config:` cannot replace our theme, fonts, layout or SVG labels, nor
 * loosen the sanitizer (`dompurifyConfig`).
 */
const SECURE = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'theme',
  'themeVariables',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'fontSize',
  'look',
  'darkMode',
  'htmlLabels',
  'flowchart',
  'sequence',
  'class',
  'dompurifyConfig',
  'layout',
];

/**
 * A node class the model writes as `A:::warm` (phase-20 decision 24): Mermaid adds the class also
 * without a `classDef`. Text stays --foreground.
 */
const nodeClass = (name: string, fill: string, stroke: string) =>
  ['rect', 'polygon', 'path', 'circle', 'ellipse']
    .map((shape) => `.node.${name} ${shape}`)
    .join(', ') + ` { fill: ${fill} !important; stroke: ${stroke} !important; }`;
/** Node shapes; their 1.5 px border covers a whole pixel at 1x (a 1 px one blurs over two). */
const NODE_SHAPES = ['rect', 'polygon', 'path', 'circle', 'ellipse']
  .map((s) => `.node ${s}`)
  .join(', ');

/**
 * The diagram rules of the view and the export alike (decision 21), as literal token values;
 * Mermaid scopes them to the diagram's id, so they win over its own id rules. Edges are
 * --muted-foreground at 1.5 px whatever the scale; nodes have radius 8. A subgraph title gets a
 * halo of the cluster fill (decision 26); the node classes (decision 24). No `:is()`: Mermaid's
 * scoper splits at every comma.
 */
const diagramCss = (t: Tokens) => {
  const line = t['muted-foreground'];
  return `.flowchart-link, .transition, .relation, [class^="messageLine"], .edge-pattern-solid, .edge-pattern-dashed { stroke: ${line} !important; stroke-width: 1.5px !important; vector-effect: non-scaling-stroke; }
marker path { fill: ${line} !important; stroke: ${line} !important; }
.node rect, .statediagram-state rect, .actor rect { rx: 8px; ry: 8px; }
${NODE_SHAPES} { stroke-width: 1.5px !important; }
.cluster-label text { paint-order: stroke; stroke: ${t['chart-band']}; stroke-width: 4px; stroke-linejoin: round; }
.cluster-label .background { fill: ${t['chart-band']} !important; opacity: 1 !important; }
.edgeLabel .background { fill: ${t.card} !important; opacity: 1 !important; }
${nodeClass('warm', t['chart-accent-soft'], t['chart-1'])}
${nodeClass('cool', t['info-subtle'], t['chart-3'])}
${nodeClass('alert', t['destructive-subtle'], t.destructive)}
${nodeClass('ok', t['success-subtle'], t.success)}
${nodeClass('muted', t.muted, t['chart-faint'])}
.node.muted text { fill: ${t['muted-foreground']} !important; }`;
};

/** Mermaid's options (decisions 9, 21, 26 of phase 20, decision 9 of phase 19). */
export const mermaidConfig = (t: Tokens, dark: boolean, fontSize: number): MermaidConfig => {
  const font = t['font-sans'];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    secure: SECURE,
    theme: 'base',
    // Flat shapes: Mermaid 12's `neo` look adds tinted drop shadows.
    look: 'classic',
    // Mermaid 12 lays out with ELK by default, which ignores the flowchart spacing below and
    // leaves a wide band under a subgraph (phase-20 UI review).
    layout: 'dagre',
    themeVariables: mermaidTheme(t, dark, fontSize),
    themeCSS: diagramCss(t),
    // Mermaid measures text with these: the faces the CSS paints (T4).
    fontFamily: font,
    sequence: { actorFontFamily: font, messageFontFamily: font, noteFontFamily: font },
    // SVG labels keep the export a plain SVG that a canvas can draw. Every diagram type that
    // has the option; the per-type keys are deprecated but still read.
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      // Less label padding: a decision diamond grows with its label's box (phase-19 UI review).
      padding: 8,
      nodeSpacing: 40,
      rankSpacing: 40,
      // The title 12 px from the border and from the first node.
      subGraphTitleMargin: { top: 12, bottom: 12 },
    },
    class: { htmlLabels: false },
    // A parse error throws (the caller shows it) instead of drawing Mermaid's error SVG.
    suppressErrorRendering: true,
  };
};

const text = z.union([z.string(), z.array(z.string())]);
/** R6: the top-level shape; the rest is Vega-Lite's own business. */
const Spec = z
  .looseObject({
    data: z.looseObject({ values: z.array(z.looseObject({})).optional() }).optional(),
    title: z.union([text, z.looseObject({ text, subtitle: text.optional() })]).optional(),
    description: z.string().optional(),
    usermeta: z.looseObject({ caption: z.string().optional() }).optional(),
  })
  .refine(
    (s) => ['mark', 'layer', 'concat', 'hconcat', 'vconcat', 'facet', 'repeat'].some((k) => k in s),
    'Kaaviosta puuttuu mark, layer, concat, facet tai repeat.',
  );
const MAX_ROWS = 500;
const MAX_SIZE = 2000;
const MAX_STEP = 100;
const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

/** Calls `fn` on every object of the spec except the data rows (`values`, `datasets`). */
function visit(node: unknown, fn: (o: Obj) => void) {
  if (Array.isArray(node)) for (const n of node) visit(n, fn);
  else if (node && typeof node === 'object') {
    fn(node as Obj);
    for (const [k, v] of Object.entries(node)) if (k !== 'values' && k !== 'datasets') visit(v, fn);
  }
}

const DROP = new Set(['config', 'background', 'padding', 'autosize', 'font', 'scheme', '$schema']);
/** R2 (phase-20 decision 20): every family key goes, `font` and `labelFont`, `titleFont`, …. */
const dropped = (k: string) => DROP.has(k) || k.endsWith('Font');
const COLOR_KEYS = new Set(['color', 'fill', 'stroke']);
const LITERAL = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\(.*)$/i;
type Ctx = 'color' | 'range' | undefined;

/**
 * R2 and R7: drops theme keys and colour literals, swaps colour roles; data stays as written.
 * Colours go only where colours are: a `color`, `fill` or `stroke` value (also the `value` and
 * `condition` of such a channel) loses every string that is not a role; a `range` loses colour
 * literals but keeps other strings (shape names). Elsewhere "#2024" is text and stays.
 */
export function clean(node: unknown, map: Record<string, string>, ctx?: Ctx): unknown {
  if (Array.isArray(node)) {
    const out = node.map((n) => clean(n, map, ctx)).filter((n) => n !== undefined);
    return out.length || !node.length ? out : undefined;
  }
  if (node && typeof node === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) {
      if (dropped(k)) continue;
      const child: Ctx = COLOR_KEYS.has(k)
        ? 'color'
        : k === 'range'
          ? 'range'
          : ctx === 'color' && (k === 'value' || k === 'condition')
            ? 'color'
            : undefined;
      const c = k === 'data' || k === 'datasets' ? v : clean(v, map, child);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  if (typeof node === 'string') {
    const role = node.slice(1);
    if (node[0] === '@' && Object.hasOwn(map, role)) return map[role];
    if (ctx === 'color' || (ctx === 'range' && LITERAL.test(node))) return undefined;
  }
  return node;
}

/**
 * `width` and `height` at every level (concat, facet, repeat, layers): a number at most 2000 px,
 * a `{ step }` at most 100 px per band.
 */
function clampSizes(spec: unknown) {
  visit(spec, (o) => {
    for (const k of ['width', 'height']) {
      const v = o[k];
      if (typeof v === 'number') o[k] = Math.min(v, MAX_SIZE);
      else if (v && typeof v === 'object' && typeof (v as Obj).step === 'number')
        o[k] = { ...(v as Obj), step: Math.min((v as Obj).step as number, MAX_STEP) };
    }
  });
}

/** Steps of a `data.sequence` generator. */
const steps = (q: Obj) => Math.abs((Number(q.stop) - Number(q.start)) / (Number(q.step) || 1)) || 0;

/** R1: a space between a number and a unit or a second number does not break. */
export const nbsp = (s: string) => s.replace(/(\d) (?=\d|[%‰°€$]|[\p{L}µ]{1,5}(?!\p{L}))/gu, '$1 ');

const line = (v: unknown) =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : undefined;

export type Lifted = { title?: string; subtitle?: string; caption?: string };
/** R1: title, subtitle and caption leave the spec (Vega titles neither wrap nor mix weights). */
export function liftTitle(spec: Obj): Lifted {
  const t = spec.title;
  delete spec.title;
  const obj = t && typeof t === 'object' && !Array.isArray(t) ? (t as Obj) : undefined;
  const out: Lifted = {};
  const title = line(obj ? obj.text : t);
  const subtitle = line(obj?.subtitle);
  const caption = line((spec.usermeta as Obj | undefined)?.caption);
  if (title) out.title = nbsp(title);
  if (subtitle) out.subtitle = nbsp(subtitle);
  if (caption) out.caption = nbsp(caption);
  return out;
}

/**
 * The y unit of a single view (`encoding.y` of the spec or its first layer that has one) moves to
 * a chart title anchored at the left edge of the whole chart, so it starts on the tick-label
 * column, as in Plot; the axis keeps no title. A concat or facet keeps its axis titles.
 */
function liftYUnit(spec: Obj, t: Tokens) {
  for (const view of [spec, ...((Array.isArray(spec.layer) ? spec.layer : []) as Obj[])]) {
    const y = (view.encoding as Obj | undefined)?.y as Obj | undefined;
    if (!y || typeof y !== 'object') continue;
    if (y.axis === null) return;
    const axis = (y.axis ?? {}) as Obj;
    const unit = axis.title !== undefined ? axis.title : y.title !== undefined ? y.title : y.field;
    if (unit === null || unit === undefined || unit === '') return;
    y.axis = { ...axis, title: null };
    spec.title = {
      text: Array.isArray(unit) ? unit.join(' ') : String(unit),
      anchor: 'start',
      frame: 'bounds',
      font: t['font-sans'],
      fontSize: 12,
      fontWeight: 500,
      color: t['muted-foreground'],
      offset: 8,
    };
    return;
  }
}

const WIDTH: Record<string, number> = { '@accent': 2.5, '@c1': 2.5, '@faint': 1.5 };
/**
 * The highlighted series is wider than the context (phase-20 UI review): a colour of `@accent`
 * strokes 2.5 px, `@faint` 1.5 px, by value or through the colour scale's range. Before R7, while
 * the roles are still names.
 */
function emphasis(raw: unknown) {
  visit(raw, (o) => {
    const enc = o.encoding as Obj | undefined;
    const color = enc?.color as Obj | undefined;
    if (!enc || !color || typeof color !== 'object' || 'strokeWidth' in enc) return;
    const range = (color.scale as Obj | undefined)?.range;
    if (typeof color.value === 'string' && color.value in WIDTH)
      enc.strokeWidth = { value: WIDTH[color.value] };
    else if (
      typeof color.field === 'string' &&
      Array.isArray(range) &&
      range.some((r) => r === '@faint') &&
      range.every((r) => typeof r === 'string' && r in WIDTH)
    ) {
      const sort = color.sort;
      const domain = (color.scale as Obj).domain;
      enc.strokeWidth = {
        field: color.field,
        type: 'ordinal',
        ...(sort === undefined ? {} : { sort }),
        // An ordinal scale maps each name to its width; the default would interpolate between them.
        scale: {
          type: 'ordinal',
          ...(domain === undefined ? {} : { domain }),
          range: range.map((r) => WIDTH[r]),
        },
        legend: null,
      };
    }
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A date without a time ("2026-01-01") in a temporal field means local midnight: JavaScript reads
 * it as UTC, so the first month's tick fell before the domain and lost its label (phase 20).
 */
function localDates(spec: Obj, tables: Row[][]) {
  const fields = new Set<string>();
  visit(spec, (o) => {
    if (o.type === 'temporal' && typeof o.field === 'string') fields.add(o.field);
  });
  for (const rows of tables)
    for (const r of rows)
      for (const f of fields)
        if (typeof r[f] === 'string' && DAY.test(r[f])) r[f] = `${r[f]}T00:00`;
}

export type Chart = { spec: Obj; lifted: Lifted; rows: Row[] };
export type Refused = { error: string; rows: Row[] };

/** R1, R2, R3, R6, R7: the model's spec as the runtime embeds it, or why it was refused. */
export function prepareChart(source: string, t: Tokens): Chart | Refused {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    return { error: `JSON ei ole kelvollinen: ${(err as Error).message}`, rows: [] };
  }
  const tables: Row[][] = [];
  let url = false;
  let href = false;
  let sequence = 0;
  let endLabels = false;
  visit(raw, (o) => {
    if (Array.isArray(o.values)) tables.push(o.values as Row[]);
    if (o.datasets && typeof o.datasets === 'object')
      for (const d of Object.values(o.datasets)) if (Array.isArray(d)) tables.push(d as Row[]);
    if (o.sequence && typeof o.sequence === 'object') sequence += steps(o.sequence as Obj);
    if ('url' in o) url = true;
    if ('href' in o) href = true;
    const mark = typeof o.mark === 'object' && o.mark ? (o.mark as Obj) : undefined;
    if ((mark?.type ?? o.mark) === 'text' && (mark?.align === 'left' || Number(mark?.dx) > 0))
      endLabels = true;
  });
  const rows = tables[0] ?? [];
  const parsed = Spec.safeParse(raw);
  const total = tables.reduce((n, r) => n + r.length, 0) + sequence;
  const error = !parsed.success
    ? z.prettifyError(parsed.error)
    : url
      ? 'Kaavio ei saa ladata dataa osoitteesta (url).'
      : href
        ? 'Kaaviossa ei saa olla linkkejä (href).'
        : total > MAX_ROWS
          ? `Kaaviossa on ${Math.ceil(total)} riviä; enintään ${MAX_ROWS}.`
          : undefined;
  if (error) return { error, rows };
  emphasis(raw);
  const spec = clean(raw, roles(t)) as Obj;
  localDates(spec, tables);
  // Colour ramps blend in Lab: Vega-Lite's default HCL bends the band-to-blue ramp through pink.
  visit(spec, (o) => {
    for (const ch of ['color', 'fill', 'stroke']) {
      const c = (o.encoding as Obj | undefined)?.[ch] as Obj | undefined;
      if (c && typeof c === 'object' && !('value' in c) && c.scale !== null)
        c.scale = { interpolate: 'lab', ...(c.scale as Obj | undefined) };
    }
  });
  clampSizes(spec);
  const lifted = liftTitle(spec);
  if ('mark' in spec || 'layer' in spec) liftYUnit(spec, t);
  // R6: always Vega-Lite; a raw Vega spec (its own $schema) cannot pass the guard as one.
  spec.$schema = SCHEMA;
  if ('mark' in spec || 'layer' in spec) spec.width = 'container';
  spec.autosize = { type: 'fit-x', contains: 'padding' };
  // Bottom 6: x labels keep their descenders ("syys"), the svg is not cut at its baseline.
  spec.padding = { left: 0, top: 4, right: endLabels ? 44 : 8, bottom: 6 };
  spec.config = vegaConfig(t);
  return { spec, lifted, rows };
}

/** Escaped text; `**bold**` (allowed in the subtitle) becomes <strong>. */
export const inlineHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const FONTS = [
  ['Inter Variable', interUrl],
  ['Source Serif 4 Variable', serifUrl],
  ['JetBrains Mono Variable', monoUrl],
] as const;
const dataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
let faces: Promise<string> | undefined;
/**
 * Our three fonts as base64 `@font-face` rules: the sandbox CSP allows `font-src data:` only, and
 * an exported SVG must carry its fonts.
 */
export function fontFaces() {
  faces ??= Promise.all(
    FONTS.map(async ([family, url]) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`font ${r.status}`);
      const src = (await dataUrl(await r.blob())).replace(/^data:[^;,]*/, 'data:font/woff2');
      return `@font-face{font-family:'${family}';font-weight:100 900;font-display:block;src:url(${src}) format('woff2')}`;
    }),
  ).then((rules) => rules.join(''));
  // A failed load is retried on the next artifact.
  faces.catch(() => {
    faces = undefined;
  });
  return faces;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Decision 12: the renderer's SVG with the lifted title, subtitle and caption as SVG text, the
 * page colour and the inlined fonts, so the file looks the same outside the app.
 */
export function framedSvg(inner: string, lifted: Lifted, t: Tokens, fonts: string) {
  const doc = new DOMParser().parseFromString(inner, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('SVG ei ole kelvollinen');
  const el = doc.documentElement;
  // A Mermaid `themeCSS` directive is model-written: no external resource in the file. Links
  // and images may point inside the file (`#id`) only; inline styles lose `url(…)`.
  for (const style of el.querySelectorAll('style'))
    style.textContent = (style.textContent ?? '')
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\([^)]*\)/gi, 'none');
  for (const node of el.querySelectorAll('image, a, use'))
    for (const attr of ['href', 'xlink:href'])
      if (!(node.getAttribute(attr) ?? '#').startsWith('#')) node.removeAttribute(attr);
  for (const node of el.querySelectorAll('[style]'))
    node.setAttribute(
      'style',
      (node.getAttribute('style') ?? '').replace(/url\([^)]*\)/gi, 'none'),
    );
  const box = el
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  const w = box?.[2] ?? Number.parseFloat(el.getAttribute('width') ?? '0');
  const h = box?.[3] ?? Number.parseFloat(el.getAttribute('height') ?? '0');
  const P = 16;
  const text = (y: number, size: number, fill: string, body: string, serif = false) =>
    `<text x="${P}" y="${y}" font-family="${xml(t[serif ? 'font-serif' : 'font-sans'])}" font-size="${size}"${serif ? ' font-weight="600"' : ''} fill="${fill}">${body}</text>`;
  // `**bold**` becomes a semibold tspan, like the <strong> in the panel.
  const rich = (s: string) =>
    xml(s).replace(/\*\*(.+?)\*\*/g, `<tspan font-weight="600" fill="${t.foreground}">$1</tspan>`);
  const parts: string[] = [];
  let y = P;
  if (lifted.title) {
    y += 22;
    parts.push(text(y, 20, t.foreground, rich(lifted.title), true));
    y += 8;
  }
  if (lifted.subtitle) {
    y += 16;
    parts.push(text(y, 14, t['muted-foreground'], rich(lifted.subtitle)));
    y += 8;
  }
  if (parts.length) y += 8;
  el.setAttribute('x', String(P));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.removeAttribute('style');
  y += h;
  if (lifted.caption) {
    y += 20;
    parts.push(text(y, 12, t['muted-foreground'], rich(lifted.caption)));
  }
  const width = Math.ceil(w + 2 * P);
  const height = Math.ceil(y + P);
  const body = `<rect width="100%" height="100%" fill="${t.card}"/>${parts.join('')}${new XMLSerializer().serializeToString(el)}`;
  // Only the families the file uses.
  const used = fonts
    .split(/(?=@font-face)/)
    .filter((rule) => body.includes(/font-family:'([^']+)'/.exec(rule)?.[1] ?? '\0'))
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${used}</style>${body}</svg>`;
  return { svg, width, height };
}

const MAX_CANVAS = 4096;
/** PNG of an SVG at device pixel ratio 2, drawn in the parent page. */
export async function pngBlob(svg: string, width: number, height: number): Promise<Blob> {
  if (width * 2 > MAX_CANVAS || height * 2 > MAX_CANVAS)
    throw new Error(`kuva on yli ${MAX_CANVAS} px`);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG epäonnistui'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A flowchart decision `id{label}` draws as a rounded box (`id([label])`): Mermaid sizes the
 * diamond from its label's box, so it dwarfs the other nodes. The source in Koodi is unchanged.
 */
export const roundDecisions = (src: string) =>
  /^\s*(flowchart|graph)\b/m.test(src.replace(/^---[\s\S]*?---/, '').trimStart())
    ? src.replace(/(\b[\w-]+)\{(?!\{)([^{}\n]+)\}(?!\})/g, '$1([$2])')
    : src;
