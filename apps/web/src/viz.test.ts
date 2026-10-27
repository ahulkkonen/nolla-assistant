import { parse, View } from 'vega';
import { compile } from 'vega-lite';
import { describe, expect, it } from 'vitest';
import {
  type Chart,
  clean,
  framedSvg,
  inlineHtml,
  liftTitle,
  mermaidConfig,
  mermaidTheme,
  nbsp,
  prepareChart,
  type Refused,
  roles,
  roundDecisions,
  type Tokens,
  tokenSheet,
  vegaConfig,
} from './viz.ts';

const T = {
  background: '#faf9f5',
  foreground: '#141413',
  card: '#ffffff',
  'card-foreground': '#141413',
  muted: '#f0eee6',
  'muted-foreground': '#64635d',
  secondary: '#ebe9e0',
  input: '#8a8880',
  border: '#1f1e1d1f',
  link: '#1d5bbf',
  info: '#1d5bbf',
  'info-subtle': '#e5eefb',
  destructive: '#b42318',
  'destructive-subtle': '#fbe7e4',
  success: '#26702b',
  'success-subtle': '#e6f2e3',
  'warning-subtle': '#fbefd9',
  'warning-line': '#b7791f',
  'chart-1': '#b5532a',
  'chart-2': '#2c7a73',
  'chart-3': '#1d5bbf',
  'chart-4': '#9a6700',
  'chart-5': '#7151c4',
  'chart-6': '#b5446e',
  'chart-faint': '#929088',
  'chart-band': '#f3efe6',
  'chart-accent-soft': '#f4dfd3',
  'font-sans': '"Inter Variable", system-ui, sans-serif',
  'font-serif': '"Source Serif 4 Variable", Georgia, serif',
  'font-mono': '"JetBrains Mono Variable", ui-monospace, monospace',
} satisfies Tokens;

const bar = (extra: object = {}) =>
  JSON.stringify({
    data: { values: [{ k: 'a', v: 1 }] },
    mark: 'bar',
    encoding: { x: { field: 'k' }, y: { field: 'v', type: 'quantitative' } },
    ...extra,
  });
const refused = (r: Chart | Refused) => ('error' in r ? r : undefined);

describe('spec guard (R6)', () => {
  it('refuses invalid JSON, a missing mark, and keeps the rows for the fallback table', () => {
    expect(refused(prepareChart('{', T))?.error).toMatch(/^JSON ei ole kelvollinen/);
    const noMark = refused(prepareChart(JSON.stringify({ data: { values: [{ a: 1 }] } }), T));
    expect(noMark?.error).toContain('Kaaviosta puuttuu mark');
    expect(noMark?.rows).toEqual([{ a: 1 }]);
    expect(refused(prepareChart(JSON.stringify({ mark: 'bar', title: 5 }), T))).toBeDefined();
  });

  it('refuses a url anywhere, but not a url field inside the data rows', () => {
    expect(refused(prepareChart(bar({ data: { url: 'https://x.test/a.csv' } }), T))?.error).toBe(
      'Kaavio ei saa ladata dataa osoitteesta (url).',
    );
    const lookup = { lookup: 'k', from: { data: { url: 'https://x.test/b.csv' }, key: 'k' } };
    const r = refused(prepareChart(bar({ transform: [lookup] }), T));
    expect(r?.error).toContain('url');
    expect(r?.rows).toEqual([{ k: 'a', v: 1 }]);
    expect(refused(prepareChart(bar({ data: { values: [{ url: 'https://x.test' }] } }), T))).toBe(
      undefined,
    );
  });

  it('refuses more than 500 rows in all tables together', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    expect(refused(prepareChart(bar({ data: { values: rows(500) } }), T))).toBe(undefined);
    const layered = JSON.stringify({
      layer: [
        { data: { values: rows(300) }, mark: 'line' },
        { data: { values: rows(201) }, mark: 'point' },
      ],
    });
    expect(refused(prepareChart(layered, T))?.error).toBe('Kaaviossa on 501 riviä; enintään 500.');
  });
});

describe('spec guard, security review', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
  it('counts rows under datasets and the steps of a sequence', () => {
    const named = { datasets: { a: rows(300), b: rows(201) }, data: { name: 'a' }, mark: 'bar' };
    expect(refused(prepareChart(JSON.stringify(named), T))?.error).toBe(
      'Kaaviossa on 501 riviä; enintään 500.',
    );
    const seq = (stop: number) =>
      JSON.stringify({ data: { sequence: { start: 0, stop, step: 1 } }, mark: 'point' });
    expect(refused(prepareChart(seq(500), T))).toBe(undefined);
    expect(refused(prepareChart(seq(100000), T))?.error).toContain('enintään 500');
  });

  it('refuses href in an encoding or a mark', () => {
    const enc = bar({ encoding: { href: { field: 'k' } } });
    expect(refused(prepareChart(enc, T))?.error).toBe('Kaaviossa ei saa olla linkkejä (href).');
    const mark = bar({ mark: { type: 'bar', href: 'https://x.test' } });
    expect(refused(prepareChart(mark, T))?.error).toContain('href');
  });

  it('clamps width and height everywhere and sets the Vega-Lite schema itself', () => {
    const spec = JSON.stringify({
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      vconcat: [
        { width: 99999, height: 5000, mark: 'bar' },
        { layer: [{ mark: 'line', height: 300 }] },
      ],
    });
    const { spec: out } = prepareChart(spec, T) as Chart;
    expect(out.$schema).toBe('https://vega.github.io/schema/vega-lite/v6.json');
    expect(out.vconcat).toEqual([
      { width: 2000, height: 2000, mark: 'bar' },
      { layer: [{ mark: 'line', height: 300 }] },
    ]);
  });

  it('clamps a band step to 100 px at every level', () => {
    const spec = JSON.stringify({
      hconcat: [
        { width: { step: 5000 }, mark: 'bar' },
        { facet: { field: 'k' }, spec: { height: { step: 400 }, mark: 'bar' } },
      ],
    });
    const { spec: out } = prepareChart(spec, T) as Chart;
    expect(out.hconcat).toEqual([
      { width: { step: 100 }, mark: 'bar' },
      { facet: { field: 'k' }, spec: { height: { step: 100 }, mark: 'bar' } },
    ]);
  });

  it('keeps colour-like text outside colour keys', () => {
    const spec = bar({
      title: '#2024 kasvoi',
      encoding: { x: { field: 'k', scale: { domain: ['#1', '#2024'] } } },
    });
    const { spec: out, lifted } = prepareChart(spec, T) as Chart;
    expect(lifted.title).toBe('#2024 kasvoi');
    expect(out.encoding).toMatchObject({ x: { scale: { domain: ['#1', '#2024'] } } });
    expect(clean({ shape: { scale: { range: ['circle', '#fff'] } } }, roles(T))).toEqual({
      shape: { scale: { range: ['circle'] } },
    });
  });

  it('fails the export when the SVG does not parse', () => {
    const parser = globalThis.DOMParser;
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelector: (s: string) => (s === 'parsererror' ? {} : null) };
      }
    } as unknown as typeof DOMParser;
    try {
      expect(() => framedSvg('<svg', {}, T, '')).toThrow('SVG ei ole kelvollinen');
    } finally {
      globalThis.DOMParser = parser;
    }
  });
});

describe('title lifting (R1)', () => {
  it('lifts title, subtitle and caption out of the spec', () => {
    const spec: Record<string, unknown> = {
      title: { text: ['Kulutus', '2025'], subtitle: 'Yhteensä **3 370 kWh**' },
      usermeta: { caption: 'Lähde: raportti, 12 %' },
    };
    expect(liftTitle(spec)).toEqual({
      title: 'Kulutus 2025',
      subtitle: 'Yhteensä **3 370 kWh**',
      caption: 'Lähde: raportti, 12 %',
    });
    expect(spec.title).toBeUndefined();
    expect(liftTitle({ title: 'Pelkkä' })).toEqual({ title: 'Pelkkä' });
    expect(liftTitle({})).toEqual({});
  });

  it('keeps a space before a long word, escapes HTML and allows **bold**', () => {
    expect(nbsp('2024 kesäkuussa 30 s')).toBe('2024 kesäkuussa 30 s');
    expect(inlineHtml('<b>a</b> & **b**')).toBe('&lt;b&gt;a&lt;/b&gt; &amp; <strong>b</strong>');
  });
});

describe('colour roles and theme keys (R2, R7)', () => {
  it('swaps roles, drops theme keys and colour literals, leaves data alone', () => {
    const spec = {
      config: { font: 'Comic Sans MS' },
      background: '#000',
      padding: 40,
      data: { values: [{ c: '@accent', d: '#fff' }] },
      mark: { type: 'line', color: '#ff0000', stroke: 'red', font: 'Arial', strokeWidth: 3 },
      encoding: {
        color: { field: 'c', scale: { range: ['@accent', '@c2'] } },
        fill: { value: '@band' },
        text: { value: '@nimi' },
        stroke: { scale: { range: ['#123456', 'rgb(1,2,3)'] } },
      },
    };
    expect(clean(spec, roles(T))).toEqual({
      data: { values: [{ c: '@accent', d: '#fff' }] },
      mark: { type: 'line', strokeWidth: 3 },
      encoding: {
        color: { field: 'c', scale: { range: [T['chart-1'], T['chart-2']] } },
        fill: { value: T['chart-band'] },
        text: { value: '@nimi' },
        stroke: { scale: {} },
      },
    });
  });

  it('sets sizing and padding (R3): 44 px right only for end labels', () => {
    const plain = prepareChart(bar(), T) as Chart;
    expect(plain.spec).toMatchObject({
      width: 'container',
      autosize: { type: 'fit-x', contains: 'padding' },
      padding: { left: 0, top: 4, right: 8, bottom: 6 },
    });
    const labels = JSON.stringify({
      layer: [{ mark: 'line' }, { mark: { type: 'text', align: 'left', dx: 6 } }],
    });
    expect((prepareChart(labels, T) as Chart).spec.padding).toMatchObject({ right: 44 });
  });
});

describe('theme builders', () => {
  it('builds the Vega config from the tokens', () => {
    const c = vegaConfig(T) as Record<string, Record<string, unknown>>;
    expect(c.background).toBe('#ffffff');
    expect(c.font).toBe(T['font-sans']);
    expect(c.axis).toMatchObject({
      labelFont: T['font-sans'],
      labelColor: '#64635d',
      labelAngle: 0,
    });
    expect(c.range?.category).toEqual([
      '#b5532a',
      '#2c7a73',
      '#1d5bbf',
      '#9a6700',
      '#7151c4',
      '#b5446e',
    ]);
    expect(c.mark?.color).toBe('#b5532a');
  });

  it('builds the Mermaid variables and the sandbox token sheet', () => {
    expect(mermaidTheme(T, true)).toMatchObject({
      darkMode: true,
      fontFamily: T['font-sans'],
      primaryTextColor: '#141413',
      lineColor: '#64635d',
    });
    expect(tokenSheet(T)).toMatch(/^:root\{--background:#faf9f5;--foreground:#141413;/);
  });
});

describe('fonts and Mermaid config (phase 20)', () => {
  it('drops every family key of the model (R2): font, labelFont, titleFont, subtitleFont', () => {
    const { spec } = prepareChart(
      bar({
        encoding: {
          x: { field: 'k', axis: { labelFont: 'Courier New', titleFont: 'Courier New' } },
          y: { field: 'v', type: 'quantitative', legend: { labelFont: 'Courier New' } },
        },
        title: { text: 'T', font: 'Courier New', subtitleFont: 'Courier New' },
        mark: { type: 'bar', font: 'Courier New' },
      }),
      T,
    ) as Chart;
    expect(JSON.stringify({ ...spec, config: undefined })).not.toContain('Courier New');
    expect((spec.config as { axis: { labelFont: string } }).axis.labelFont).toBe(T['font-sans']);
  });

  it('secures the theme keys, measures with our font and keeps subgraph titles legible', () => {
    const c = mermaidConfig(T, false, 14);
    expect(c.secure).toEqual(
      expect.arrayContaining([
        'secure',
        'securityLevel',
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
      ]),
    );
    expect(c.fontFamily).toBe(T['font-sans']);
    expect(c.sequence).toEqual({
      actorFontFamily: T['font-sans'],
      messageFontFamily: T['font-sans'],
      noteFontFamily: T['font-sans'],
    });
    expect(c.flowchart?.subGraphTitleMargin).toEqual({ top: 4, bottom: 0 });
    expect(c.themeVariables).toMatchObject({ clusterBkg: T['chart-band'] });
    // The halo is the cluster fill; the edge colour is a literal token value.
    expect(c.themeCSS).toContain(
      `.cluster-label text { paint-order: stroke; stroke: ${T['chart-band']};`,
    );
    expect(c.themeCSS).toContain(`stroke: ${T['muted-foreground']} !important`);
    expect(c.themeCSS).not.toContain(':is(');
  });
});

describe('colour (phase 20)', () => {
  it('maps @c1 to @c6 to the six chart colours; @accent stays @c1', () => {
    const r = roles(T);
    expect([1, 2, 3, 4, 5, 6].map((i) => r[`c${i}`])).toEqual([
      '#b5532a',
      '#2c7a73',
      '#1d5bbf',
      '#9a6700',
      '#7151c4',
      '#b5446e',
    ]);
    expect(r.accent).toBe(r.c1);
    const spec = JSON.parse(bar({ encoding: { color: { value: '@c5' } } }));
    expect(clean(spec, r)).toMatchObject({ encoding: { color: { value: '#7151c4' } } });
  });

  it('gives sequential, diverging and ordinal ranges from the tokens', () => {
    const range = (vegaConfig(T) as { range: Record<string, unknown> }).range;
    expect(range.ramp).toEqual(['#f3efe6', '#1d5bbf']);
    expect(range.heatmap).toEqual(['#f3efe6', '#1d5bbf']);
    expect(range.diverging).toEqual(['#b5532a', '#f3efe6', '#2c7a73']);
    expect(range.ordinal).toEqual({ scheme: ['#f3efe6', '#1d5bbf'] });
  });

  it('blends the ordinal and sequential ramps in Lab: no hue detour through pink', async () => {
    const mid = async (type: 'ordinal' | 'quantitative') => {
      const chart = prepareChart(
        JSON.stringify({
          data: { values: [0, 5, 10].map((v, i) => ({ k: 'abc'[i], v })) },
          mark: 'point',
          encoding: { x: { field: 'k' }, color: { field: type === 'ordinal' ? 'k' : 'v', type } },
        }),
        T,
      ) as Chart;
      const view = new View(parse(compile(chart.spec as never).spec), { renderer: 'none' });
      await view.runAsync();
      const c = String(view.scale('color')(type === 'ordinal' ? 'b' : 5));
      view.finalize();
      return c.match(/\d+/g)?.map(Number) ?? [];
    };
    // HCL gave rgb(218, 140, 161) between --chart-band and --chart-3.
    for (const type of ['ordinal', 'quantitative'] as const) {
      const [r = 0, , b = 0] = await mid(type);
      expect(b, type).toBeGreaterThan(r);
    }
  });

  it('colours the Mermaid node classes without a classDef', () => {
    const css = mermaidConfig(T, false, 14).themeCSS ?? '';
    expect(css).toContain('.node.alert rect, .node.alert polygon');
    expect(css).toContain('{ fill: #fbe7e4 !important; stroke: #b42318 !important; }');
    for (const c of ['warm', 'cool', 'alert', 'ok', 'muted'])
      expect(css).toContain(`.node.${c} rect`);
  });
});

describe('roundDecisions', () => {
  it('draws a flowchart decision as a rounded box, nothing else changes', () => {
    expect(roundDecisions('flowchart TD\nA --> B{Mökki vai matka?}\nB -->|x| C{{Hex}}')).toBe(
      'flowchart TD\nA --> B([Mökki vai matka?])\nB -->|x| C{{Hex}}',
    );
    expect(roundDecisions('sequenceDiagram\nA->>B: {x}')).toBe('sequenceDiagram\nA->>B: {x}');
  });
});

describe('y unit', () => {
  it('moves to a title on the left edge of the chart; the axis keeps none', () => {
    const spec = JSON.stringify({
      mark: 'bar',
      encoding: { x: { field: 'k' }, y: { field: 'v', title: 'Kulutus (kWh)' } },
    });
    const { spec: out } = prepareChart(spec, T) as Chart;
    expect(out.title).toMatchObject({ text: 'Kulutus (kWh)', anchor: 'start', frame: 'bounds' });
    expect((out.encoding as { y: { axis: unknown } }).y.axis).toEqual({ title: null });
  });
});
