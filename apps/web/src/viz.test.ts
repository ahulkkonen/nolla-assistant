import { describe, expect, it } from 'vitest';
import {
  type Chart,
  clean,
  inlineHtml,
  liftTitle,
  mermaidTheme,
  nbsp,
  prepareChart,
  type Refused,
  roles,
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
  border: '#1f1e1d1f',
  link: '#1d5bbf',
  info: '#1d5bbf',
  'info-subtle': '#e5eefb',
  'warning-subtle': '#fbefd9',
  'warning-line': '#b7791f',
  'chart-1': '#b5532a',
  'chart-2': '#2c7a73',
  'chart-3': '#1d5bbf',
  'chart-4': '#9a6700',
  'chart-5': '#7151c4',
  'chart-6': '#b5446e',
  'chart-faint': '#9a988f',
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
      padding: { left: 0, top: 4, right: 8, bottom: 0 },
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
