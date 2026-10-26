# 0008: Charts and diagrams (deep research)

Deep research run by the user on Claude Web on 2026-10-26 from the prompt Fable wrote. Pasted
verbatim below. Decisions that follow from it are recorded in the phase record (phase 19 viz).

---

# Decision record: charts and diagrams in a self-hosted chat assistant (2026-10-26)

**Decision:** charts use ```` ```vega-lite ````, diagrams keep ```` ```mermaid ````, and graph layouts that Mermaid handles badly get a WASM ```` ```dot ```` block. Free HTML artifacts get an injected token sheet, a small component CSS, and a preloaded Observable Plot and D3. The model gets a short Finnish decision rule. Its default is prose or a table, and it draws a chart only when the data has a shape that a chart shows better.

## Summary

1. Spec block for charts: **Vega-Lite 6.5.0** via vega-embed. It is plain JSON, validates against a published schema, has a full `config` theming layer, uses the global d3 Finnish locale, and renders to SVG or PNG offline.
2. Spec block for diagrams: **Mermaid 12.2.0**, with the `base` theme driven by our tokens and `accTitle`/`accDescr` required.
3. Optional third block: **Graphviz DOT** via `@hpcc-js/wasm-graphviz` 1.29.2, for dependency and state graphs. Lazy-loaded.
4. Rejected as model-facing blocks: Chart.js, ECharts, Plotly (imperative or heavy, or harder to theme), D2 (stale npm WASM build), PlantUML (Java heritage, heavy browser runtime), Excalidraw (big and not a language), Penrose (niche), Typst (wrong job).
5. Tables stay Markdown. We style them with tabular numerals. We never chart them.
6. Free HTML artifacts: inject `tokens.css` plus `kit.css` (cards, tables, callouts, figure, caption), and preload Observable Plot 0.6.17 and D3 7.9.0 from our origin. Do not preload Chart.js or ECharts.
7. Tailwind in the sandbox is allowed only as a prebuilt, tokenised CSS file. It is optional and comes second to `kit.css`.
8. Export: SVG first, via the renderer's own SVG output. PNG is rasterised from that SVG at 2× in the parent page, with fonts inlined.
9. Prompt rule: "fewer than 4 numbers → prose; exact lookups → table; trend, distribution, correlation or part-to-whole over ≥ 4 values → chart; process, structure or sequence → diagram". No pie charts with more than 3 slices. No dual axes.
10. Main risk: Mermaid 12 is a breaking release, and validity evidence for frontier models in 2026 is thin. Mitigate with schema validation, one silent repair turn, and a fallback to a table.

## Question 1: declarative spec blocks

Spec sizes are our own estimates for a 6-row dataset, excluding data. They are not measured from model output.

| Format | Spec size (bar / line / scatter / table) | Model validity evidence | Theming API | Size and WASM | Offline from our origin | SVG / PNG export | Accessibility | Licence | Status Oct 2026 | Finnish locale |
|---|---|---|---|---|---|---|---|---|---|---|
| **Vega-Lite** | ~200 / ~220 / ~220 chars; table: not native | Most-studied target. nvBench/VisEval-style evals of Vega-Lite generation exist [9][10][12]. An eval found Vega-Lite scripts harder than Python for some charts [14] | `config` object: fonts per axis/legend/title, `range.category` palette, background. Dark mode = swap config [21][22] | vega + vega-lite + vega-embed. No WASM. Size UNVERIFIED | Yes. `data.values` inline. No loader needed | Native SVG and canvas renderers. Export API (`toSVG`, `toImageURL`) UNVERIFIED in this research | `description` → ARIA. Keyboard: none native (UNVERIFIED) | BSD-3-Clause [S] | 6.5.0 released 2026-10-08 [1] | `formatLocale` / `timeFormatLocale` options in vega-embed, global [19][20] |
| **Observable Plot** (spec-like) | ~120–180 chars of JS | No dedicated eval found | Plot options plus CSS on the SVG. Inherits `currentColor` and fonts | Built on D3. No WASM. Size UNVERIFIED | Yes | SVG native. PNG via rasterising | Auto `aria-label` per mark. Ticks hidden from AT since 0.6.14 [5] | ISC (observablehq/plot CONTRIBUTING.md: "released under the ISC license") | 0.6.17, 2025-02-14. No release since [4] | Via d3 formatters (UNVERIFIED) |
| **Chart.js config** | ~350–450 chars JSON | Not specifically measured | Global `defaults.font`, per-dataset colours. Dark = re-init | Canvas only. No WASM | Yes | PNG via canvas. **No native SVG** | Canvas: needs fallback text | MIT | 4.5.1, 2025-10-13 [6] | `locale` option via Intl (UNVERIFIED) |
| **ECharts option JSON** | ~350–500 chars | DV-World: declarative frameworks (ECharts, Vega-Lite) fail mainly on data mapping [11] | `registerTheme` with tokens. v6 adds dynamic theme switching and dark mode [7] | Large (npm unpacked 57.6 MB). Gzip UNVERIFIED | Yes | SVG and canvas renderers | `aria` option (UNVERIFIED) | Apache-2.0 [8] | 6.1.0, 2026-05-19. **CVE-2026-45249 (XSS, medium) affects ≤ 6.1.0** [8] | Locale registration (UNVERIFIED) |
| **Plotly JSON** | ~300–400 chars | Included in DV-World [11] | `layout.template`, `font.family` | Basic bundle 1.2 MB min, **401 kB gzip**. Full 1.49 MB gzip [15] | Yes | SVG and PNG built in | Weak (UNVERIFIED) | MIT | basic-dist-min 3.6.0, 2026-06-01 [16] | `locale` and `separators` (UNVERIFIED) |
| **Mermaid** | Flowchart ~80 chars. xychart bar ~120. No scatter or table | No eval found. Widely written by models (UNVERIFIED) | `theme: base` + `themeVariables` (`fontFamily`, `primaryColor`, `darkMode`, …) [23] | 12.0 adds ~500 kB gzip vs 11 (bundled ELK) [S] | Yes | SVG native. PNG via rasterising | `accTitle`/`accDescr` → `<title>`/`<desc>` plus aria [24] | MIT (mermaid-js/mermaid LICENSE file: "The MIT License (MIT)") | 12.0.0 2026-09-10, 12.2.0 2026-10-13 [2][S]. New types: Venn, Ishikawa (11.13), Wardley, TreeView (11.14), Event Modeling (11.15), Cynefin, Railroad, Swimlane (11.16), use case and agentflow (12.0) [2][3][25][26] | No number locale (UNVERIFIED) |
| **D2** | ~60 chars (diagram) | None found | Built-in themes. Custom fonts limited (UNVERIFIED) | Go→WASM in a web worker | Yes, but the npm wrapper `@terrastruct/d2` is 0.1.33 from 2025-08 while D2 itself is v0.9.0 (2026-09-07) [17][S] | SVG | UNVERIFIED | MPL-2.0 | Core active. JS wrapper lags | n/a |
| **PlantUML** | ~80 chars | None found | skinparam | Official TeaVM JS build, or older CheerpJ (~10–20 MB runtime) [S] | Possible without a server in 2026 [S] | SVG | Weak (UNVERIFIED) | GPL/LGPL/MIT variants (UNVERIFIED) | Active | n/a |
| **Graphviz DOT** (`@hpcc-js/wasm-graphviz`) | ~60–100 chars | None found. DOT is old and common in training data (UNVERIFIED) | Graph/node/edge attributes: `fontname`, `color`, `bgcolor` | WASM inlined in JS (UNVERIFIED size) | Yes | SVG native | Must add title/desc ourselves | Apache-2.0 [S] | 1.29.2, 2026-09-29. 1.30.0 on 2026-10-21 is after cutoff [18][S] | n/a |
| **Excalidraw JSON** | Thousands of chars (coordinates per element) | None. Models handle absolute coordinates poorly (our judgement) | Hand-drawn look only | 46.8 MB install, React component [S] | Yes | SVG and PNG | Weak | MIT | 0.18.1, 2026-04-20 [S] | n/a |
| **Penrose** | Three files (domain, substance, style) | None | Style language | Optimiser in JS. Size UNVERIFIED | Yes | SVG | UNVERIFIED | MIT | 3.3.x. 4.0 in alpha [S] | n/a |
| **Typst** (`typst.ts`) | Document language, not charts | None | Full typesetting | WASM compiler, multi-MB (UNVERIFIED) | Yes | SVG and PDF | PDF tagging UNVERIFIED | Apache-2.0 | 0.7.0, 2026-06-01 [S] | Typst `lang: "fi"` (UNVERIFIED) |

**2025–2026 entrants.** The most relevant "entrant" is not a library. All four major assistants now draw visuals inline (see Question 2). AntV's GPT-Vis family targets LLM output, but this research did not verify its 2026 state (UNVERIFIED).

**Why Vega-Lite wins for charts:**
- It is data, not code, so we can JSON-schema-validate it before rendering.
- It has the deepest research base on LLM generation.
- Its theme is one `config` object that we own.
- It has a documented global d3 locale for Finnish number and date formats.

## Question 2: design kit for free HTML artifacts

| Approach | Brand consistency | Model burden | Bundle / CSP | Mobile 390 px | Print | Verdict |
|---|---|---|---|---|---|---|
| **Injected `tokens.css` + `kit.css`** (cards, tables, callouts, figure, caption, stat) | High. The model uses semantic classes and CSS variables | Low. ~15 class names in the prompt | A few kB. Same-origin `<link>` | Kit sets `max-width:100%` and fluid type | Kit ships `@media print` | **Adopt** |
| **Preloaded Observable Plot + D3** | High if Plot reads `currentColor` and CSS variables | Medium. Concise API [27] | No WASM. Same origin | SVG scales | SVG prints sharply | **Adopt** |
| Preloaded Chart.js | Medium. Theme must be set in JS defaults | Medium | Canvas only | Needs `responsive` | Canvas prints raster | Reject. No SVG export |
| Preloaded ECharts | Medium–high via `registerTheme` | High. Option trees are long | Heavy. Open CVE ≤ 6.1.0 [8] | Good | Good with SVG renderer | Reject for now |
| Prebuilt Tailwind CSS (no Play CDN) | High if built from our `@theme` tokens | Low for models, which know Tailwind well (UNVERIFIED) | One CSS file. Unused classes vanish unless safelisted | Good | Good | Optional. Safelist a fixed set |
| Typography defaults | — | None | — | — | — | **Adopt.** Inter for UI and body, Source Serif 4 for long-form headings, JetBrains Mono for code. Ratio-1.2 scale, `max-width: 68ch`, `font-variant-numeric: tabular-nums` in tables and axes |

**What the big assistants do in 2026:**

- **Claude.** Since 2026-03-12, Claude draws "custom charts, diagrams and other visualizations in-line" in chat. These are separate from Artifacts. The feature is on by default and "Claude will decide when to build a visual" [28]. Secondary reports say the visuals render as HTML and SVG and can be exported as .html and .svg [29].
- **ChatGPT.** Canvas was removed from GPT-5.5 models on 2026-05-28, per a secondary report that quotes OpenAI release notes [32]. On 2026-10-07, with GPT-6, OpenAI launched "Intelligent UI". It builds charts, forms and calculators "from a library of components" and uses a streaming compiler. ChatGPT decides when to use it, and users can turn visuals down [30][31].
- **Gemini.** Since 2026-04-09 the app has generated "interactive simulations and models" in chat. You select the Pro model and say "show me" or "help me visualize" [33].
- **Perplexity.** Around 2026-10-01/05, Computer threads gained inline interactive charts and 3D explanations. Financial data uses TradingView Lightweight Charts [34][35].

**Pattern.** Every vendor lets the model decide, and every vendor draws on a fixed design vocabulary: OpenAI's component library, Perplexity's pinned charting library. Our token sheet plus a fixed library set is the self-hosted version of the same idea.

## Question 3: guidance on when to chart

**Evidence:**
- VisEval (Chen, Zhang, Xu, Ren and Yang, arXiv 2407.00981, 2024) uses a dataset of "2,524 representative queries covering 146 databases" and scores generated charts on "validity, legality, and readability". Follow-up citations summarise its findings as "persistent failure modes in chart type selection, axis mapping, and aggregation logic" [10].
- Wang et al., "Visualization Generation with Large Language Models: An Evaluation" (arXiv 2401.11255, v2 11 Dec 2025), tested six LLMs and eight prompt strategies on six target chart types from nvBench in Vega-Lite and found "substantial performance disparities across prompt strategies, chart types, and LLMs" [9].
- DV-World (2026) found that declarative frameworks such as ECharts and Vega-Lite "expose weaknesses in data mapping and organization". Low-level D3 caused style errors; Gemini-3-Flash had a 40.96% visual style error rate [11].
- PlotCraft lists illegible overlapping axis labels, raw variable names on axes, and wrong chart types as common failures [13].
- In a 2025 study, Khan, Chandak and Mukherjea (arXiv 2507.22890) found that "LLMs could generate code for some simpler visualizations such as bar and pie charts", while some models "had difficulty generating complex visualizations, such as violin plot" [14].
- VegaChat proposes grammar-constrained generation so that output is always valid Vega-Lite [12].
- No paper found in this research directly measures *when* a model should choose a chart over prose. Product practice (Claude, ChatGPT) is "the model decides, the user can override" [28][31]. Our rule below therefore rests on standard visualisation practice, not on an LLM study.

**Failure modes to guard against in the prompt and validator:**
- Charting 2–3 numbers.
- Pie charts with many slices.
- Dual y-axes.
- More than 7 colours.
- Overlapping or rotated labels at 390 px.
- Raw field names as axis titles.
- Unsorted bars.
- Invented data.

## Recommendation

**Block types the model may emit:**
- ```` ```vega-lite ```` (new). Bar, line, area, scatter, histogram, heatmap. Inline `data.values` only. Max 500 rows.
- ```` ```mermaid ```` (existing). Flowchart, sequence, state, class, ER, gantt, timeline, mindmap, xychart only if trivial.
- ```` ```dot ```` (phase 2). Graphs with > 15 nodes or dense edges.
- ```` ```html ```` / ```` ```jsx ```` / ```` ```tsx ```` (existing). Only when interaction is the point. They get the design kit.
- Markdown tables, styled by us.

**Pinned libraries (all published before 2026-10-19; serve from our origin):**

| Package | Version | Published | Note |
|---|---|---|---|
| vega-lite | 6.5.0 | 2026-10-08 [1] | |
| vega | 6.4.0 | ~2026-08-14 (inferred) [S] | |
| vega-embed | 7.3.0 | 2026-09-23 (from dependabot PR notes) [36] | Fall back to 7.1.0 if the date check fails |
| mermaid | 12.2.0 | 2026-10-13 [S] | Breaking: ES2024, Safari 17.4+. 11.17.2 (2026-08-25) is the fallback |
| @hpcc-js/wasm-graphviz | 1.29.2 | 2026-09-29 [18] | Not 1.30.0 (2026-10-21) |
| @observablehq/plot | 0.6.17 | 2025-02-14 [4] | |
| d3 | 7.9.0 | 2024-03-12 [S] | |

**Theme mapping (our token → library key):**

| Token | Vega-Lite `config` | Mermaid `themeVariables` | Plot / kit |
|---|---|---|---|
| `--font-sans` (Inter) | `font`, `axis.labelFont`, `legend.labelFont` | `fontFamily` | `font-family` on `svg` |
| `--font-serif` (Source Serif 4) | `title.font` | — | `figcaption`, `h2` |
| `--font-mono` | — | — | `code` |
| `--fg` | `axis.labelColor`, `title.color`, `legend.labelColor` | `primaryTextColor`, `lineColor` | `color` (→ `currentColor`) |
| `--fg-muted` | `axis.titleColor`, `axis.tickColor` | `secondaryTextColor` | captions |
| `--border` | `axis.gridColor`, `axis.domainColor` | `primaryBorderColor` | rules |
| `--bg` | `background` | `background`, `mainBkg` | `background` |
| `--surface` | `view.fill` | `primaryColor` | `.card` |
| `--accent` | `mark.color` | `secondaryColor` | `fill` default |
| `--chart-1…6` | `range.category` | `cScale0…` (UNVERIFIED names) | `color.range` |
| dark theme | rebuild `config` from dark tokens and re-embed | `darkMode: true` + dark tokens | CSS variables switch automatically |
| locale | `formatLocale {decimal:",", thousands:" ", grouping:[3], currency:[""," €"]}`, `timeFormatLocale` fi-FI (`%-d.%-m.%Y`) | — | `d3.formatLocale` same definition |

Read the CSS variables with `getComputedStyle` in the parent page. Freeze them into the config at render time, because Vega and Mermaid need literal values. At 390 px:
- Set `width: "container"`.
- Use font size ≥ 12 px.
- Set `labelAngle: 0`, use `labelLimit`, and switch to horizontal bars when there are more than 6 categories.

**Export path:**
1. Get the SVG string from the renderer (Vega view SVG, Mermaid render output, Graphviz SVG).
2. Inline `@font-face` as base64 WOFF2 subsets.
3. Offer SVG download.
4. For PNG, draw the SVG on an `OffscreenCanvas` at devicePixelRatio 2 in the parent page and call `toBlob`.
5. For print, use `@media print` with the light tokens forced and charts at `max-width: 100%`.

**Validation pipeline:** parse JSON → validate against the vega-lite v6 schema → reject `data.url`, which the CSP blocks anyway → render. On error, send the error back for one silent repair turn. If that fails, show the data as a table plus a "chart failed" note.

**Prompt paragraph (Finnish):**

> Käytä visualisointia vain, kun se tekee vastauksesta selvästi helpommin ymmärrettävän kuin teksti. Päätössääntö: alle neljä lukua → kirjoita ne lauseeseen; tarkat arvot tai vertailu useassa ominaisuudessa → Markdown-taulukko; kehitys ajassa, jakauma, korrelaatio tai osuudet vähintään neljästä arvosta → ```vega-lite-kaavio; prosessi, rakenne, vaiheet tai riippuvuudet → ```mermaid-kaavio. Älä keksi dataa – kaavion luvut on oltava vastauksessa tai lähteessä. Ei piirakkakaaviota yli kolmelle osalle, ei kahta y-akselia, enintään kuusi väriä. Anna kuvaava otsikko, akseleille suomenkieliset nimet yksiköineen ja `description`-kenttään yhden lauseen tekstivastine. Lajittele pylväät arvon mukaan ja käytä vaakapylväitä, jos luokkia on yli kuusi. Älä määrittele fontteja tai värejä – teema hoitaa ne. Kirjoita aina kaavion jälkeen yksi lause, joka kertoo sen tärkeimmän havainnon.

**Decision rule (for system prompt and validator):** chart only if n ≥ 4 data points AND the message is a trend, distribution, relationship or part-to-whole. Otherwise use a table if the user needs exact lookup, else prose. Diagram only if there are ≥ 3 entities with relations or ordered steps.

## Risks

- **Mermaid 12 breaks things.** ELK is now the default layout and the default look changes. It needs Safari 17.4+ and adds ~500 kB gzip [S]. Pin it and test our existing diagrams. Keep 11.17.2 ready.
- **Thin 2026 validity data.** Published evals cover GPT-3.5/4-era models on nvBench-style tasks [9][10]. Frontier validity for Vega-Lite 6 is unmeasured. Log our own failure rate from day one.
- **Vega global locale.** `formatLocale` is global [19]. That is fine for a single-user Finnish app, but it affects every view.
- **Observable Plot cadence.** There has been no release since 2025-02 [4]. It is stable but slow-moving.
- **ECharts CVE-2026-45249** is a reason not to preload it until a fixed release ships [8].
- **Over-visualising.** The vendors now push visuals by default [28][31]. Our rule must keep the default at text.
- **Fonts in exported SVG.** Without inlining, PNG and SVG fall back to system fonts.

## Facts not verified

- Minified + gzip sizes for vega, vega-lite, vega-embed, Plot, D3, Mermaid, Graphviz WASM and Typst.
- The vega-embed 7.3.0 publish date (known only from a dependabot PR) and its licence.
- Observable Plot's licence is now resolved: ISC, per observablehq/plot CONTRIBUTING.md ("Observable Plot is open source and released under the ISC license").
- Mermaid's licence is now resolved: MIT, per the mermaid-js/mermaid LICENSE file ("The MIT License (MIT) Copyright (c) 2014 - 2022 Knut Sveidqvist").
- Vega `toSVG`/`toImageURL` API names. Vega-Lite ARIA and keyboard behaviour.
- Number locale support in Chart.js, ECharts, Plotly, Mermaid and Plot.
- The ECharts and Plotly accessibility features.
- PlantUML licence variants and TeaVM bundle size.
- Mermaid `themeVariables` names for pie and xychart palettes.
- The claim that frontier models write Tailwind or DOT reliably.
- AntV GPT-Vis status in 2026.
- Spec character counts are our own estimates.
- ChatGPT Canvas removal relies on a secondary source quoting OpenAI release notes.

## Sources (all read 2026-10-26)

1. vega-lite Release 6.5.0 — https://github.com/vega/vega-lite/releases/tag/v6.5.0
2. Mermaid releases (12.0.0, 11.17.2) — https://github.com/mermaid-js/mermaid/releases
3. Mermaid v11.13.0 blog (Venn, Ishikawa) — https://mermaid.ai/blog/posts/mermaid-v11-13-0-two-new-diagram-types-and-our-most-polished-release-yet
4. Observable Plot releases (0.6.17) — https://github.com/observablehq/plot/releases
5. Quarto issue on Plot accessibility — https://github.com/quarto-dev/quarto-cli/issues/14934
6. Chart.js v4.5.1 release — https://github.com/chartjs/Chart.js/releases/tag/v4.5.1
7. ECharts 6 features (theme, dark mode) — https://echarts.apache.org/handbook/en/basics/release-note/v6-feature/
8. Aikido: echarts CVE-2026-45249 — https://intel.aikido.dev/packages/npm/echarts ; ECharts npm versions — https://www.npmjs.com/package/echarts?activeTab=versions ; Snyk echarts — https://security.snyk.io/package/npm/echarts
9. Visualization Generation with LLMs: An Evaluation — https://arxiv.org/html/2401.11255v2
10. VisEval — https://arxiv.org/html/2407.00981v1 ; citing summary — https://www.researchgate.net/publication/383919090_VisEval_A_Benchmark_for_Data_Visualization_in_the_Era_of_Large_Language_Models
11. DV-World — https://arxiv.org/html/2604.25914
12. VegaChat — https://arxiv.org/html/2601.15385v1
13. PlotCraft — https://arxiv.org/pdf/2511.00010
14. Evaluating LLMs for Visualization Generation and Understanding — https://arxiv.org/html/2507.22890v1
15. plotly.js dist README (bundle sizes) — https://github.com/plotly/plotly.js/blob/main/dist/README.md
16. plotly.js-basic-dist-min on npmx — https://npmx.dev/package/plotly.js-basic-dist-min
17. D2 Go package v0.9.0 — https://pkg.go.dev/github.com/d2lang/d2 ; @terrastruct/d2 npm — https://www.npmjs.com/package/@terrastruct/d2
18. hpcc-js-wasm graphviz v1.29.2 — https://github.com/hpcc-systems/hpcc-js-wasm/releases/tag/wasm-graphviz-v1.29.2 ; v1.30.0 bump — https://github.com/hpcc-systems/hpcc-js-wasm/releases/tag/wasm-graphviz-cli-v1.11.4
19. vega-embed README (formatLocale, timeFormatLocale) — https://github.com/vega/vega-embed/blob/main/README.md
20. Vega Locale API — https://vega.github.io/vega/docs/api/locale/
21. Vega config — https://vega.github.io/vega/docs/config/
22. Vega-Lite axis — https://vega.github.io/vega-lite/docs/axis.html ; vega-themes example — https://github.com/vega/vega-themes/blob/main/src/theme-latimes.ts
23. Mermaid theme configuration — https://mermaid.ai/open-source/config/theming.html
24. Mermaid accessibility options — https://mermaid.ai/open-source/config/accessibility.html
25. Mermaid Studio 2026.2.2 / 2026.2.5 / 2026.3.1 notes — https://mermaidstudio.dev/whatsnew/2026-2-2/ ; https://mermaidstudio.dev/whatsnew/2026-2-5/ ; https://mermaidstudio.dev/whatsnew/2026-3-1/
26. Mermaid Studio 2026.4.2 (Mermaid 12) — https://mermaidstudio.dev/whatsnew/2026-4-2/
27. Observable Plot overview — https://openvisualizationacademy.beehiiv.com/p/observable-plot-simplicity-meets-expressiveness-in-charts
28. Claude: interactive charts, diagrams and visualizations — https://claude.com/blog/claude-builds-visuals
29. Claude inline HTML visuals (secondary) — https://getaibook.com/news/claudes-new-inline-visuals-what-developers-should-know-about-html-charts-in-chat ; https://thenewstack.io/anthropics-claude-interactive-visualizations/
30. SiliconANGLE on ChatGPT Intelligent UI — https://siliconangle.com/2026/10/07/with-gpt-6-chatgpts-responses-are-much-more-visually-appealing-and-interactive/
31. Citybiz / Dataconomy on Intelligent UI — https://www.citybiz.co/article/915814/openai-adds-interactive-charts-and-visual-tools-to-chatgpt-with-gpt-6/ ; https://dataconomy.com/2026/10/08/openai-chatgpt-gpt-6-interactive-visuals/
32. ChatGPT Canvas removal (secondary) — https://felloai.com/chatgpt-canvas/
33. Google: Gemini interactive simulations and models — https://blog.google/innovation-and-ai/products/gemini-app/3d-models-charts/
34. Perplexity on X (TradingView charts) — https://x.com/perplexity_ai/status/2105692220280226296
35. Perplexity release notes (Releasebot) — https://releasebot.io/updates/perplexity-ai
36. Dependabot PR with vega-embed 7.2.0/7.3.0 notes — https://github.com/KyleWhyet/dsh-u-20261026-streamlit__streamlit/pull/9

[S] = subagent verification on 2026-10-26 from: Snyk mermaid https://security.snyk.io/package/npm/mermaid ; Mermaid 12.0.0 release https://github.com/mermaid-js/mermaid/releases/tag/mermaid@12.0.0 ; Snyk vega https://security.snyk.io/package/npm/vega ; Snyk d3 https://security.snyk.io/package/npm/d3 ; jsDelivr vega-lite https://www.jsdelivr.com/package/npm/vega-lite ; npmx terrastruct https://npmx.dev/org/terrastruct ; npmx excalidraw https://npmx.dev/package/@excalidraw/excalidraw/v/%5E0.18.1 ; libraries.io penrose https://libraries.io/npm/@penrose%2Fcore ; typst.ts releases https://github.com/myriad-dreamin/typst.ts/releases ; PlantUML https://github.com/plantuml/plantuml and https://plantuml.com/ ; plantuml-core https://github.com/plantuml/plantuml-core ; xddxdd dependabot PR https://github.com/xddxdd/blog/pull/2840.

---

## Addendum 2026-10-26: findings from rendering tests (user)

Method: own tests in headless Chromium, network blocked, our fonts and warm light tokens, at 640 px and 390 px. Versions: vega 6.4.0, vega-lite 6.5.0, vega-embed 7.3.0, d3 7.9.0, @observablehq/plot 0.6.17, chart.js 4.5.1, echarts 6.1.0, plotly.js-dist-min 4.1.2, mermaid 12.2.0, @antv/infographic 0.2.20. One chart per test, so treat results as indicative.

### Results
| Test | HTML (D3/CSS) | Vega-Lite | Model-written size |
|---|---|---|---|
| Two-series line chart: shaded band between series, direct end labels, one note | Reference | Visually equivalent at 640 and 390 px after renderer fixes R1–R5 | VL ~2,550 chars (~730 tokens); HTML ~4,400 chars (~1,260 tokens) |
| Annotated before/after timeline: bars, cutoff line, shaded window, notes | Phone layout with one media query | Equal on desktop. Phone needed 4 workarounds: width expressions, text widths guessed from character count, background bars behind labels, band alignment | Equal, ~4,000 chars (~1,100 tokens) each |
| Same line chart in Chart.js, ECharts, Plotly, Observable Plot | Not tested in HTML | Plot and VL cleanest. Plotly `separators` does not apply to custom text labels | Not measured |
| Mermaid xychart | Not tested in HTML | Weakest look. Parse error on unquoted labels with ä ("kesä") | Not measured |
| AntV Infographic (2 templates) | Not tested in HTML | Two-line title overlapped subtitle. Icons load from weavefox.cn by default | Not measured |

### Revised routing
- Data-driven chart (≥ 4 values; trend, distribution, relationship, part-to-whole) → ```vega-lite
- Explanatory chart with few values and many notes (timeline, before/after, timed process) → ```html with design kit and preloaded D3/Plot
- Structure or flow without numbers → ```mermaid
- Exact lookups → Markdown table. Fewer than 4 numbers → prose.
- The deciding question is whether the chart is mostly data or mostly notes and layout.

### Renderer requirements for every Vega-Lite block
- R1 Title out of Vega. Lift `title.text`, `title.subtitle` and `usermeta.caption` out of the spec. Render them as HTML h2, p and figcaption. Vega titles do not wrap and cannot mix font weights. Allow `**bold**` in the subtitle. Insert a non-breaking space between number and unit (12 %, 30 s, 3 370 kWh).
- R2 Theme injected, never written by the model. Font names ending in a digit must be quoted: `"'Source Serif 4', Georgia, serif"`. Unquoted, it silently falls back to another serif.
- R3 Sizing. Use `autosize: {type: "fit-x", contains: "padding"}` with `width: "container"`. fit-x already reserves space for marks outside the plot (row labels), so never add padding for them; doing so shifted the plot and clipped notes. Direct end labels on the right need `padding.right` ≈ 44.
- R4 Narrow screens. Below 480 px container width with an ordinal x axis, show every second label: `labelExpr: "round(datum.index*(n-1))%2 ? '' : datum.label"`. Axis `datum.index` is a 0–1 fraction, not an integer. Cap height at 200. `labelOverlap` did not hide colliding labels on a point scale.
- R5 Wait for `document.fonts.ready` before `vegaEmbed`.
- R6 Validate against the v6 schema. Reject `data.url`. Allow `params` with `expr`, and `containerSize()`. On error, one silent repair turn; then fall back to a table.
- R7 (proposed, untested) Colour roles. The model writes `@fg @muted @faint @accent @accent-soft @c2 @band`. The renderer replaces them with the current theme's hex values before embedding. Dark mode then becomes a re-render.

### Theme config, light (tested values; dark values to be added)
The hex values below are the user's test values. The implementation reads the project tokens
(`apps/web/src/tokens.css`) instead; the structure is what matters.
```json
{
  "background": "#FBF8F3",
  "font": "Inter",
  "padding": {"left": 0, "top": 4, "right": 44, "bottom": 0},
  "view": {"stroke": null},
  "axis": {"labelFont": "Inter", "labelFontSize": 12, "labelColor": "#7A6F66",
           "gridColor": "#E7DFD4", "domainColor": "#E7DFD4", "tickColor": "#E7DFD4",
           "domain": false, "ticks": false, "labelPadding": 8, "labelAngle": 0},
  "axisX": {"grid": false},
  "text": {"font": "Inter", "fontSize": 13, "color": "#2B2622"},
  "mark": {"color": "#C2602F"},
  "bar": {"cornerRadius": 4}
}
```
Role values: @fg #2B2622, @muted #7A6F66, @faint #A89E94, @border #E7DFD4, @accent #C2602F, @accent-soft #F3DFD2, @c2 #3E7C78, @band #F1EBE2.
