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
  // A plain node's hairline: the neutral of the edges and the decision node (phase 21).
  primaryBorderColor: t['chart-faint'],
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
  // The subgraph band; its title strip is blended from it (render.ts).
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

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** The OKLCH hue (radians) of a `#rrggbb` token (Björn Ottosson's OKLab matrices). */
function hue(hex: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) =>
    lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return Math.atan2(
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
  );
}
/** `#rrggbb` of an OKLCH colour. ponytail: clips to sRGB per channel; fine at these chromas. */
function oklch([L, C]: Step, h: number) {
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return `#${[
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, gamma(c))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

type Step = [lightness: number, chroma: number];
/**
 * Phase-21 decision 1: every role's tint, hairline and text share lightness and chroma; the hue is
 * the role token's (warm `--chart-1`, cool `--chart-3`, alert `--destructive`, ok `--success`,
 * muted `--chart-faint`), so the dark theme follows the tokens. Light steps from the designer's
 * variant B.
 */
const STEPS = {
  light: {
    tint: [0.958, 0.018],
    line: [0.8, 0.07],
    text: [0.4, 0.1],
    mutedTint: [0.97, 0.004],
    mutedLine: [0.88, 0.008],
  },
  dark: {
    tint: [0.36, 0.03],
    line: [0.56, 0.07],
    text: [0.88, 0.06],
    mutedTint: [0.34, 0.004],
    mutedLine: [0.46, 0.008],
  },
} satisfies Record<string, Record<string, Step>>;
const ROLE_TOKEN = {
  warm: 'chart-1',
  cool: 'chart-3',
  alert: 'destructive',
  ok: 'success',
} as const;
export type Role = { tint: string; line: string; text: string };
/** The node classes the model writes as `A:::warm` (phase-20 decision 24), in this theme. */
export function roleColours(t: Tokens, dark: boolean): Record<string, Role> {
  const s = STEPS[dark ? 'dark' : 'light'];
  const faint = hue(t['chart-faint']);
  return {
    ...Object.fromEntries(
      Object.entries(ROLE_TOKEN).map(([role, token]) => {
        const h = hue(t[token]);
        return [role, { tint: oklch(s.tint, h), line: oklch(s.line, h), text: oklch(s.text, h) }];
      }),
    ),
    muted: {
      tint: oklch(s.mutedTint, faint),
      line: oklch(s.mutedLine, faint),
      text: t['muted-foreground'],
    },
  };
}

const SHAPES = ['rect', 'polygon', 'path', 'circle', 'ellipse'];
/** Mermaid adds the class of `A:::warm` also without a `classDef`. */
const nodeClass = (name: string, { tint, line, text }: Role) =>
  `${SHAPES.map((shape) => `.node.${name} ${shape}`).join(', ')} { fill: ${tint} !important; stroke: ${line} !important; }
.node.${name} text { fill: ${text} !important; }`;

/**
 * The diagram rules of the view and the export alike (phase-20 decision 21), as literal token
 * values; Mermaid scopes them to the diagram's id, so they win over its own id rules. Phase 21:
 * nodes are 1 px hairlines with radius 10; flowchart edges and the dashed decision node are
 * --chart-faint; the column pass (render.ts) sets node text (`.node > text`) and edge labels
 * (`.edgeLabel > text`) in the sizes here. Other diagram kinds keep --muted-foreground edges.
 * No `:is()`: Mermaid's scoper splits at every comma.
 */
const diagramCss = (t: Tokens, dark: boolean, size: number) => {
  const line = t['muted-foreground'];
  const faint = t['chart-faint'];
  return `.transition, .relation, [class^="messageLine"], .edge-pattern-solid, .edge-pattern-dashed { stroke: ${line} !important; stroke-width: 1.5px !important; vector-effect: non-scaling-stroke; }
marker path { fill: ${line} !important; stroke: ${line} !important; }
path.flowchart-link { stroke: ${faint} !important; stroke-width: 1.25px !important; fill: none; }
path.flowchart-link.edge-thickness-thick { stroke-width: 2.5px !important; }
path.flowchart-link.edge-pattern-dotted { stroke-dasharray: 0.1 3.75; stroke-linecap: round; }
marker.flowchart-v2 path, marker.flowchart-v2 circle { fill: ${faint} !important; stroke: ${faint} !important; }
.node rect, .statediagram-state rect, .actor rect { rx: 10px; ry: 10px; }
${SHAPES.map((s) => `.node ${s}`).join(', ')} { stroke-width: 1px !important; }
.node > text { font-size: ${size}px; font-weight: ${dark ? 480 : 500}; letter-spacing: -0.006em; fill: ${t.foreground}; }
.node > text .emo { font-size: ${size + 1}px; letter-spacing: 0; }
.node.decision > rect, .node.decision > g.outer-path > path { fill: ${t.card} !important; stroke: ${faint} !important; stroke-dasharray: 4 3; }
.edgeLabel .background { fill: ${t.card} !important; opacity: 1 !important; }
.edgeLabel > text { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; fill: ${line}; }
${Object.entries(roleColours(t, dark))
  .map(([name, role]) => nodeClass(name, role))
  .join('\n')}
.node.muted .emo { opacity: 0.55; }`;
};

/** Mermaid's label wrapping width in a flowchart (the column pass reads its line breaks). */
export const WRAP = 200;

/** Mermaid's options (decisions 9, 21, 26 of phase 20, decision 9 of phase 19). */
export const mermaidConfig = (
  t: Tokens,
  dark: boolean,
  fontSize: number,
  strip = 28,
): MermaidConfig => {
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
    themeCSS: diagramCss(t, dark, fontSize),
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
      // Dagre spaces a rank across a subgraph border 1.5 times: 46 leaves room above the first node
      // for the title strip and 22 px under it, and 12 px of edge into the subgraph.
      rankSpacing: 46,
      // Mermaid's own default wraps a 20-letter label ("Hälytys päivystäjälle").
      wrappingWidth: WRAP,
      // Room for the title strip (render.ts) and 22 px or more between it and the first node.
      subGraphTitleMargin: { top: strip + 4, bottom: 0 },
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
  visit(raw, (o) => {
    if (Array.isArray(o.values)) tables.push(o.values as Row[]);
    if (o.datasets && typeof o.datasets === 'object')
      for (const d of Object.values(o.datasets)) if (Array.isArray(d)) tables.push(d as Row[]);
    if (o.sequence && typeof o.sequence === 'object') sequence += steps(o.sequence as Obj);
    if ('url' in o) url = true;
    if ('href' in o) href = true;
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
  // Bottom 6: x labels keep their descenders ("syys"), the svg is not cut at its baseline. Right 0,
  // also with end labels: `fit-x` already makes room for marks and labels past the plot, and the
  // plot ends on the card's 16 px gutter like the header above it (UI review).
  spec.padding = { left: 0, top: 4, right: 0, bottom: 6 };
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

/** Greedy line breaking of word widths; `first` reserves room on line 1. Word indices per line. */
export function wrap(widths: number[], space: number, max: number, first = 0): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  let w = first;
  widths.forEach((x, i) => {
    const add = line.length ? space + x : x;
    if (line.length && w + add > max) {
      lines.push(line);
      line = [i];
      w = x;
    } else {
      line.push(i);
      w += add;
    }
  });
  lines.push(line);
  return lines;
}

/** Even lines: the narrowest measure that keeps the greedy line count (phase-21 decision 1). */
export function balance(widths: number[], space: number, max: number, first = 0) {
  const n = wrap(widths, space, max, first).length;
  if (n === 1) return wrap(widths, space, max, first);
  let [lo, hi] = [Math.max(...widths), max];
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (wrap(widths, space, mid, first).length > n) lo = mid;
    else hi = mid;
  }
  return wrap(widths, space, hi, first);
}

export type Run = { text: string; bold: boolean };
/** The words of `s` (no break at a no-break space), each as runs of `**bold**` and plain text. */
export const richWords = (s: string): Run[][] => {
  let bold = false;
  return s
    .split(/[ \t\n]+/)
    .map((word) =>
      word.split('**').flatMap((text, i) => {
        if (i) bold = !bold;
        return text ? [{ text, bold }] : [];
      }),
    )
    .filter((runs) => runs.length);
};

/**
 * A Mermaid `themeCSS` directive is model-written: the exported file loads nothing. `@import`
 * goes; a `url(…)` stays only as a fragment of the file itself (`url(#id)`, a marker or gradient).
 */
export const safeCss = (css: string) =>
  css.replace(/@import[^;]*;?/gi, '').replace(/url\((?!\s*['"]?#)[^)]*\)/gi, 'none');

const M = 24;
/**
 * Decision 12 of phase 19 and decision 2 of phase 21: the renderer's SVG on a sheet at least
 * 560 px wide with a 24 px margin, the lifted title (Inter 600 17/24), subtitle (14/20) and
 * caption (13/18) as SVG text wrapped into lines of at most 68ch, measured with the page's loaded
 * fonts; the page colour and the inlined fonts, so the file looks the same outside the app.
 */
export function framedSvg(inner: string, lifted: Lifted, t: Tokens, fonts: string) {
  const doc = new DOMParser().parseFromString(inner, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('SVG ei ole kelvollinen');
  const el = doc.documentElement;
  // Links and images may point inside the file (`#id`) only.
  for (const style of el.querySelectorAll('style'))
    style.textContent = safeCss(style.textContent ?? '');
  for (const node of el.querySelectorAll('image, a, use'))
    for (const attr of ['href', 'xlink:href'])
      if (!(node.getAttribute(attr) ?? '#').startsWith('#')) node.removeAttribute(attr);
  for (const node of el.querySelectorAll('[style]'))
    node.setAttribute('style', safeCss(node.getAttribute('style') ?? ''));
  const box = el
    .getAttribute('viewBox')
    ?.split(/[\s,]+/)
    .map(Number);
  const w = box?.[2] ?? Number.parseFloat(el.getAttribute('width') ?? '0');
  const h = box?.[3] ?? Number.parseFloat(el.getAttribute('height') ?? '0');
  const width = Math.max(560, Math.ceil(w + 2 * M));
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('canvas');
  const sans = t['font-sans'];
  const parts: string[] = [];
  /** One wrapped text block from `top`; `**bold**` runs are semibold --foreground tspans. */
  const block = (
    s: string,
    top: number,
    [size, lh, weight, fill]: [number, number, number, string],
    tracking = 0,
    even = false,
  ) => {
    const ls = tracking * size;
    const measure = (text: string, bold = false) => {
      ctx.font = `${bold ? 600 : weight} ${size}px ${sans}`;
      return ctx.measureText(text).width + [...text].length * ls;
    };
    const words = richWords(s);
    const lines = (even ? balance : wrap)(
      words.map((runs) => runs.reduce((n, r) => n + measure(r.text, r.bold), 0)),
      measure(' '),
      Math.min(68 * measure('0'), width - 2 * M),
    );
    // The line box centres the cap height (Inter's is 0.727 em).
    const base = top + (lh + 0.727 * size) / 2;
    const tspans = lines.map(
      (line, k) =>
        `<tspan x="${M}" y="${(base + k * lh).toFixed(2)}">${line
          .map((i) =>
            (words[i] ?? [])
              .map((r) =>
                r.bold && weight < 600
                  ? `<tspan font-weight="600" fill="${t.foreground}">${xml(r.text)}</tspan>`
                  : xml(r.text),
              )
              .join(''),
          )
          .join(' ')}</tspan>`,
    );
    parts.push(
      `<text font-family="${xml(sans)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${ls ? ` letter-spacing="${ls.toFixed(3)}"` : ''}>${tspans.join('')}</text>`,
    );
    return top + lines.length * lh;
  };
  let y = M;
  if (lifted.title) y = block(lifted.title, y, [17, 24, 600, t.foreground], -0.012, true);
  if (lifted.subtitle)
    y = block(lifted.subtitle, y + (lifted.title ? 4 : 0), [14, 20, 400, t['muted-foreground']]);
  if (parts.length) y += 16;
  // A narrow figure sits in the middle of the sheet, as in the view.
  el.setAttribute('x', String(Math.round((width - w) / 2)));
  el.setAttribute('y', String(y));
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.removeAttribute('style');
  y += h;
  if (lifted.caption) y = block(lifted.caption, y + 12, [13, 18, 400, t['muted-foreground']]);
  const height = Math.ceil(y + M);
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

/** A top-to-bottom flowchart: the one the column pass of phase-21 decision 1 lays out. */
export const columnar = (src: string) =>
  /^\s*(flowchart|graph)([ \t]+(TB|TD))?[ \t]*(;|$)/m.test(src.replace(/^---[\s\S]*?---/, ''));
