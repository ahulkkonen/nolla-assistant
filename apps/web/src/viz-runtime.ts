// Phase 19: the chart runtime, bundled by Vite as one self-contained script (`?worker&url`) and
// inlined into the sandboxed artifact iframe. The parent page has already applied R1-R3, R6 and R7
// (viz.ts); this applies R4 and R5, which need the iframe's width and fonts.
import embed from 'vega-embed';
import { expressionInterpreter } from 'vega-interpreter';

type Obj = Record<string, any>;

const FI_NUMBER = { decimal: ',', thousands: ' ', grouping: [3], currency: ['', ' €'] };
const FI_TIME = {
  dateTime: '%A %-d. %Bta %Y klo %X',
  date: '%-d.%-m.%Y',
  time: '%H.%M.%S',
  periods: ['ap.', 'ip.'],
  days: ['sunnuntai', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai'],
  shortDays: ['su', 'ma', 'ti', 'ke', 'to', 'pe', 'la'],
  months: [
    'tammikuu',
    'helmikuu',
    'maaliskuu',
    'huhtikuu',
    'toukokuu',
    'kesäkuu',
    'heinäkuu',
    'elokuu',
    'syyskuu',
    'lokakuu',
    'marraskuu',
    'joulukuu',
  ],
  shortMonths: [
    'tammi',
    'helmi',
    'maalis',
    'huhti',
    'touko',
    'kesä',
    'heinä',
    'elo',
    'syys',
    'loka',
    'marras',
    'joulu',
  ],
};
const DISCRETE = new Set(['ordinal', 'nominal']);

/**
 * R4: under 480 px an ordinal x axis with more than six labels shows every second one, and the
 * chart is at most 200 px high. Axis `datum.index` is a 0-1 fraction, hence `n`.
 */
function narrow(spec: Obj, width: number) {
  if (width >= 480) return;
  const units: Obj[] = [spec, ...(Array.isArray(spec.layer) ? spec.layer : [])];
  const xs = units
    .map((u) => u.encoding?.x)
    .filter((x) => x && (DISCRETE.has(x.type) || ['point', 'band'].includes(x.scale?.type)));
  const rows: Obj[] = units.find((u) => Array.isArray(u.data?.values))?.data.values ?? [];
  const n = new Set(rows.map((r) => r[xs[0]?.field])).size;
  if (n <= 6) return;
  for (const x of xs)
    if (x.axis !== null)
      x.axis = { ...x.axis, labelExpr: `round(datum.index*${n - 1})%2 ? '' : datum.label` };
  spec.height = Math.min(typeof spec.height === 'number' ? spec.height : 200, 200);
}

const fail = (err: unknown) =>
  parent.postMessage({ type: 'viz-error', message: String((err as Error)?.message ?? err) }, '*');

const draw = (box: HTMLElement, spec: Obj) => {
  narrow(spec, box.clientWidth);
  return embed(box, spec as never, {
    renderer: 'svg',
    actions: false,
    mode: 'vega-lite',
    ast: true,
    expr: expressionInterpreter,
    formatLocale: FI_NUMBER,
    timeFormatLocale: FI_TIME,
  });
};

/**
 * Export (phase-20 decision 7): the parent sends the spec again with the light theme; it is drawn
 * off screen at the chart's width, and its SVG goes back to the parent only.
 */
const exportSvg = async (el: HTMLElement, spec: Obj) => {
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;top:0;left:-99999px;width:${el.clientWidth}px`;
  document.body.append(box);
  try {
    const { view } = await draw(box, spec);
    try {
      return await view.toSVG();
    } finally {
      view.finalize();
    }
  } finally {
    box.remove();
  }
};

const el = document.getElementById('vis');
const spec: Obj = JSON.parse(document.getElementById('spec')?.textContent ?? '{}');
if (el) {
  // The render timer starts here, in the parent (not when the page html was set).
  parent.postMessage({ type: 'viz-loaded' }, '*');
  // R5: Vega measures text once; the faces must be loaded first. A face loads only when text
  // uses it, so `document.fonts.ready` alone comes too early (phase-20 decision 19).
  Promise.all(
    ['Inter Variable', 'Source Serif 4 Variable'].map((f) => document.fonts.load(`12px "${f}"`)),
  )
    .then(() => draw(el, spec))
    .then(() => {
      parent.postMessage({ type: 'viz-ready' }, '*');
      addEventListener('message', (e) => {
        if (e.source !== parent || e.data?.type !== 'viz-svg' || !e.data.spec) return;
        exportSvg(el, e.data.spec).then(
          (svg) => parent.postMessage({ type: 'viz-svg', svg }, '*'),
          (err: unknown) =>
            parent.postMessage(
              { type: 'viz-svg', error: String((err as Error)?.message ?? err) },
              '*',
            ),
        );
      });
    }, fail);
}
