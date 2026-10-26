// Phase 19 decision 11: Observable Plot and D3 as the globals `Plot` and `d3`, bundled by Vite as
// one self-contained script (`?worker&url`) and inlined into an artifact that uses them.
import * as Plot from '@observablehq/plot';
import * as d3 from 'd3';

Object.assign(globalThis, { Plot, d3 });
