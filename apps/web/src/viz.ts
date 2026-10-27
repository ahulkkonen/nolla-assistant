// Phase 19 (docs/decisions/phase-19-viz.md): the parent-page half of the chart renderer. The
// spec guard and the theme builders are pure; `readTokens` and the font loader touch the DOM.
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import monoUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import serifUrl from '@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url';
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

/** R7: the colour roles the model may write. */
export const roles = (t: Tokens): Record<string, string> => ({
  fg: t.foreground,
  muted: t['muted-foreground'],
  faint: t['chart-faint'],
  accent: t['chart-1'],
  'accent-soft': t['chart-accent-soft'],
  c2: t['chart-2'],
  band: t['chart-band'],
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
    axisX: { grid: false },
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
    line: { strokeWidth: 2 },
    point: { filled: true },
    rule: { color: t['chart-faint'] },
    range: {
      category: [1, 2, 3, 4, 5, 6].map((i) => t[`chart-${i}` as keyof Tokens]),
    },
  };
}

/** Mermaid `base` theme variables (decision 9). */
export const mermaidTheme = (t: Tokens, dark: boolean, fontSize = 14) => ({
  darkMode: dark,
  fontFamily: t['font-sans'],
  fontSize: `${fontSize}px`,
  background: t.card,
  mainBkg: t.secondary,
  primaryColor: t.secondary,
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
});

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
      if (DROP.has(k)) continue;
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
  const spec = clean(raw, roles(t)) as Obj;
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
