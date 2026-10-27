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
 * end above the largest value (`nice`) and the y unit as horizontal text above the top tick, as
 * the Vega axis. Colours and grid come from kit.css.
 */
function plot(options: Options = {}) {
  const width = contentWidth();
  return ObservablePlot.plot({
    ...options,
    // 0 before layout (a hidden frame): Plot's own minimum.
    width: width > 0 ? width : 320,
    marginLeft: Math.max(Number(options.marginLeft) || 0, 56),
    x: axis(options.x),
    y: { nice: true, ...axis(options.y), labelAnchor: 'top' },
  } as ObservablePlot.PlotOptions);
}

// Bars round their end only, radius 4 (Vega `cornerRadiusEnd`).
const barY: typeof ObservablePlot.barY = (data, o) => ObservablePlot.barY(data, { ry2: 4, ...o });
const barX: typeof ObservablePlot.barX = (data, o) => ObservablePlot.barX(data, { rx2: 4, ...o });

// `Plot.barY(…).plot()` goes through `Mark.prototype.plot`, not the global: it gets the kit too.
ObservablePlot.Mark.prototype.plot = function (
  this: ObservablePlot.Mark,
  { marks = [], ...o } = {},
) {
  return plot({ ...o, marks: [...marks, this] });
} as ObservablePlot.Mark['plot'];

Object.assign(globalThis, { Plot: { ...ObservablePlot, plot, barX, barY }, d3 });
