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
 * `Plot.plot` with the kit's look (like the Vega config): the full content width and a
 * rotated y label centred on its axis, as Vega titles it. Colours and grid come from kit.css.
 */
function plot(options: Options = {}) {
  return ObservablePlot.plot({
    ...options,
    width: contentWidth(),
    marginLeft: Math.max(Number(options.marginLeft) || 0, 56),
    x: axis(options.x),
    y: { ...axis(options.y), labelAnchor: 'center' },
  } as ObservablePlot.PlotOptions);
}

Object.assign(globalThis, { Plot: { ...ObservablePlot, plot }, d3 });
