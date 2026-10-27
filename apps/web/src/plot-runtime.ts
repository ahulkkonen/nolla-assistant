// Phase 19 decision 11: Observable Plot and D3 as the globals `Plot` and `d3`, bundled by Vite as
// one self-contained script (`?worker&url`) and inlined into an artifact that uses them.
import * as ObservablePlot from '@observablehq/plot';
import * as d3 from 'd3';

type Options = Record<string, any>;

/** The page's content width: the body less its padding (kit.css). */
const contentWidth = () => {
  const s = getComputedStyle(document.body);
  return (
    document.body.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight)
  );
};

/** Axis defaults the model cannot override: no tick marks, no domain line, no label arrow. */
const axis = (a: Options | undefined) => ({ ...a, tickSize: 0, line: false, labelArrow: 'none' });

/**
 * `Plot.plot` with the kit's look (like the Vega config): the full content width, y ticks that
 * end above the largest value (`nice`), the y unit as horizontal text above the tick labels and
 * the tick labels starting on the page's text edge, as in Vega. Colours and grid: kit.css.
 */
function plot(options: Options = {}) {
  const width = contentWidth();
  const render = (marginLeft: number) =>
    ObservablePlot.plot({
      ...options,
      // 0 before layout (a hidden frame): Plot's own minimum.
      width: width > 0 ? width : 320,
      marginLeft,
      // The Vega charts' right gutter.
      marginRight: options.marginRight ?? 15,
      // Band gaps as Vega's `bandPaddingInner` 0.25 (Plot ignores it on other scales).
      x: { padding: 0.25, ...axis(options.x) },
      // The unit at the left edge above the top tick; labels 8 px from the plot, as Vega's.
      y: { nice: true, ...axis(options.y), tickPadding: 8, labelAnchor: 'top' },
    } as ObservablePlot.PlotOptions);
  // A first render off the page: the widest y tick label sets the left margin, so the labels
  // start on the text edge. A frame not laid out yet measures 0 and keeps 56.
  const probe = render(56);
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const labels = probe.querySelector<SVGGraphicsElement>('g[aria-label="y-axis tick label"]');
  const w = labels ? Math.ceil(labels.getBBox().width) : 0;
  probe.remove();
  if (w) return render(w + 8);
  probe.style.position = probe.style.visibility = '';
  return probe;
}

// Bars round their end only, radius 4 (Vega `cornerRadiusEnd`). Measured: the corner names work
// in pixel space, so the top of a positive barY is y1 and the right end of a barX is x2.
const barY: typeof ObservablePlot.barY = (data, o) => ObservablePlot.barY(data, { ry1: 4, ...o });
const barX: typeof ObservablePlot.barX = (data, o) => ObservablePlot.barX(data, { rx2: 4, ...o });
// A rule at zero reads as a grid line, not an ink domain line.
const ruleY: typeof ObservablePlot.ruleY = (data, o) =>
  ObservablePlot.ruleY(data, { stroke: 'var(--border)', ...o });

// `Plot.barY(…).plot()` goes through `Mark.prototype.plot`, not the global: it gets the kit too.
ObservablePlot.Mark.prototype.plot = function (
  this: ObservablePlot.Mark,
  { marks = [], ...o } = {},
) {
  return plot({ ...o, marks: [...marks, this] });
} as ObservablePlot.Mark['plot'];

Object.assign(globalThis, { Plot: { ...ObservablePlot, plot, barX, barY, ruleY }, d3 });
