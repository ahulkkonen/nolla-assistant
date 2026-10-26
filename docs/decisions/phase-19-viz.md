# Phase 19: Charts, themed diagrams and the design kit

The research is in `0008-viz-research.md`, with the user's addendum (renderer rules R1 to R7 and the
revised routing). This record gives the decisions of phase 19, the data model, the task cards and
the gate. The artifact plumbing of phase 7 and the sandbox of `Sandbox.tsx` stay. The DOT block is
out of scope.

## Goal

1. The model can answer with a ```` ```vega-lite ```` block. The artifact panel shows a chart that
   looks like a part of this app, in light and in dark.
2. Mermaid diagrams use our tokens in light and in dark.
3. HTML, JSX and TSX artifacts get a design kit: our tokens, our fonts and a small set of classes.
   Observable Plot and D3 are available when the artifact uses them.
4. The user can download a chart or a diagram as SVG or PNG.
5. The model draws only when a chart is clearly better than text. The default stays prose or a
   table ("model-first").

Constraints:

- No network at runtime. Every library and every font comes from our bundle. No CDN.
- The sandbox CSP stays as strict as before, with one exception (decision 3).
- No dependency except the pinned libraries below.
- App CSS uses tokens, not hex values. The renderer can freeze token values into the Vega config at
  render time.

## Pinned libraries

All dates come from `https://registry.npmjs.org/<package>` (field `time`), read on 2026-10-26. Each
version is the newest version on or before 2026-10-19.

| Package | Version | Published (UTC) |
|---|---|---|
| vega-lite | 6.5.0 | 2026-10-08 14:30 |
| vega | 6.4.0 | 2026-08-14 17:16 |
| vega-embed | 7.3.0 | 2026-09-23 17:37 |
| vega-interpreter | 2.3.2 | 2026-08-14 17:18 |
| @observablehq/plot | 0.6.17 | 2025-02-14 16:15 |
| d3 | 7.9.0 | 2024-03-12 22:15 |
| mermaid | 12.2.0 | installed before this phase |
| zod | 4.6.7 | the version of `@pa/protocol`; now also a direct dependency of `@pa/web` |

`vega-interpreter` is a dependency of `vega-embed` already. We import it directly, so it is pinned
in `apps/web/package.json` (decision 2).

## Decisions

1. **New artifact kind `vega-lite`.** `Artifact.kind` in `@pa/protocol` gets `vega-lite`. The server
   (`apps/server/src/artifacts.ts`) and the thread (`MessageView.tsx`) map the info string
   `vega-lite` to it. The title of the artifact is `title.text` (or `title`) of the spec, when the
   JSON parses. "Lataa" and "Tallenna tiedostoksi" write the spec as `.json`.
2. **Vega runs in the sandbox iframe.** The parent page builds the document. The document holds the
   lifted title (R1), the spec as JSON in `<script type="application/json">`, and the viz runtime
   (`apps/web/src/viz-runtime.ts`) as an inline script. Vite bundles the runtime as one
   self-contained file (`?worker&url`), as it does the React runtime. The sandbox CSP has no
   `'unsafe-eval'`, so the runtime calls `vegaEmbed` with `ast: true` and the
   `expressionInterpreter` of `vega-interpreter`.
3. **The sandbox page.** Finding: a `srcdoc` iframe inherits the CSP of the app page. Since phase
   16 the app CSP has `script-src 'self'` and `font-src 'self'`. Thus no inline script of any
   artifact ran (React artifacts were broken), and no font could load. The e2e tests did not see
   this, because they checked HTML artifacts without a script. Fix: the frame loads
   `GET /api/sandbox` (no login, a static page). The response has its own CSP header:
   `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src
   'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none';
   frame-ancestors 'self'`, and `X-Frame-Options: SAMEORIGIN`. The page tells its parent (or its
   opener) "sandbox-ready". The parent posts the document once. The page writes it with
   `document.open()`, `document.write()` and `document.close()`. The CSP meta tag stays the first
   element of every document. The policy string is `SANDBOX_CSP` in `@pa/protocol`, shared by the
   header and the meta tag. "Avaa uudessa ikkunassa" opens `/api/sandbox` in a tab and posts the
   document there; the `sandbox` directive keeps the tab on an opaque origin.
   **Changed directive:** `font-src data:` is new. The document inlines Inter, Source Serif 4 and
   JetBrains Mono (the latin `wght` WOFF2 files of `@fontsource-variable`) as base64 `@font-face`
   rules. A data URI font cannot load anything and cannot send anything. The `sandbox` and
   `frame-ancestors` directives are new because the policy is now a header. All other directives
   are as before.
4. **Theme from the tokens, frozen at render time (R2, R7).** The parent page reads the token values
   with `getComputedStyle` on `<html>`. It builds the Vega config, the colour roles, the Mermaid
   `themeVariables` and the sandbox token sheet from these values. A theme change (setting or OS)
   rebuilds the document and renders again. The research proposed `prefers-color-scheme` in the
   sandbox token sheet. We do not use it: the user can set the app to dark while the OS is light, and
   `tokens.css` stays the one source of the values. The sandbox gets the values of the active
   theme and `<meta name="color-scheme">` with the same scheme.
5. **Chart tokens.** `tokens.css` gets `--chart-1` to `--chart-6` (categorical), `--chart-faint`,
   `--chart-band` and `--chart-accent-soft`, for light and for dark. The six colours come from the
   warm palette of the brief: clay, teal, blue (the link blue), ochre, plum (the mask line) and rose.
   Each colour has a contrast of 3:1 or more on `--card` in its scheme (non-text marks).
6. **The artifact page follows the theme.** Brief 7.5 kept the artifact page white in both schemes.
   Phase 19 changes this for artifacts: the page uses `--card` and `--card-foreground` of the active
   theme. The HTML file preview of phase 11 keeps its white page, because it shows a file of the
   user, not a model artifact.
7. **Renderer rules.** The parent page applies R1, R2, R3, R6 and R7 before it builds the document.
   The runtime applies R4 and R5, because only the iframe knows its width and its fonts.
   - R1: `title.text`, `title.subtitle` and `usermeta.caption` leave the spec. They become an `h2`
     (serif), a `p` and a `figcaption`. The subtitle allows `**bold**`. A space between a number and
     a unit or a second number becomes a non-breaking space.
   - R2: the renderer removes `config`, `background`, `padding`, `autosize`, every `font` key, every
     colour literal and every `scheme`, then sets the theme config.
   - R3: `autosize: {type: "fit-x", contains: "padding"}` and `width: "container"`. Padding right is
     44 px when a text mark sits to the right of its point (`align: "left"` or `dx > 0`), else 8 px.
   - R4: below 480 px of container width, an ordinal, nominal, point or band x axis with more than
     six distinct values shows every second label (`labelExpr` of the addendum, with `n` = the
     number of distinct x values), and the height is at most 200 px. Six labels or fewer fit at
     390 px, so they all stay.
   - R5: the runtime waits for `document.fonts.ready` before `vegaEmbed`.
   - R6: the spec must parse as JSON and match a zod schema of the top-level shape. The renderer
     refuses any `url` key, more than 500 data rows in total, and a spec without a mark, layer,
     concat, facet or repeat. On error the panel shows "Kaavio epäonnistui", the error text and the
     data rows as a table. No repair turn in this phase.
   - R7: the colour roles `@fg @muted @faint @accent @accent-soft @c2 @band` become the values of
     the active theme. Other strings that start with `@` stay (they can be data).
8. **Finnish locale.** The runtime passes `formatLocale` (decimal `,`, thousands U+00A0, grouping 3,
   currency suffix ` €`) and `timeFormatLocale` (Finnish month and day names, date `%-d.%-m.%Y`) to
   `vegaEmbed`.
9. **Mermaid.** `theme: 'base'` with `themeVariables` from the tokens (`fontFamily`, `primaryColor`,
   `primaryTextColor`, `primaryBorderColor`, `secondaryColor`, `tertiaryColor`, `lineColor`,
   `textColor`, `background`, `mainBkg`, `noteBkgColor`, `darkMode`). `look: 'classic'`, because
   the default `neo` look of Mermaid 12 adds tinted drop shadows. `htmlLabels: false`, so that the
   labels are SVG text and the export is a plain SVG. Mermaid still renders in the parent page. The
   SVG goes into the sandbox page with the inlined fonts. The `accTitle` becomes the title of the
   export. Finding: quotes are label syntax in flowcharts only; in sequence and state diagrams the
   quotes show. The prompt asks for quotes in flowchart labels only.
10. **Design kit.** `apps/web/src/kit.css` styles the sandbox page: body type (Inter 15/24), `h1` and
    `h2` in Source Serif 4 on a 1.2 scale, mono code, `max-width: 68ch` for prose, tabular numerals
    in tables, `.card`, `.callout` (`.info`, `.warn`), `table`, `figure`, `figcaption`, `.stat`
    (`.value`, `.label`), `@media print` and `max-width: 100%` on media. The renderer puts the font
    faces, the token sheet and `kit.css` before the content of every `html`, `jsx` and `tsx`
    artifact. The content can override the kit.
11. **Plot and D3.** When the source of an `html`, `jsx` or `tsx` artifact contains `Plot.` or `d3.`,
    the renderer inlines `apps/web/src/plot-runtime.ts` before the content. It sets the globals
    `Plot` and `d3`. Plot needs D3, so one bundle holds both.
12. **Export.** For `vega-lite` and `mermaid` artifacts the "Lataa" button opens a menu: "Lataa
    SVG", "Lataa PNG" and "Lataa lähdekoodi". A menu keeps the 390 px header at five buttons.
    The parent asks the iframe for `view.toSVG()` with `postMessage` and checks `event.source`. For
    Mermaid it uses its own render output. The export adds the lifted title, subtitle and caption as
    SVG text, a background rectangle, and the font faces as base64 WOFF2. PNG draws that SVG on a
    canvas at device pixel ratio 2 in the parent page and calls `toBlob`. The file name comes from
    the artifact title. "Tallenna tiedostoksi" does not change.
13. **Prompt.** `agents/prompts/assistant.md` gets one Finnish paragraph after the artifact paragraph.
    It holds the routing of the addendum and the chart rules of the research.

## Data model

- `Artifact.kind`: `'html' | 'react' | 'code' | 'mermaid' | 'vega-lite' | 'file'`.
- No database change. Artifacts are still derived from the message text.

## Task cards

1. **Vega-Lite block.** Protocol kind, server and thread mapping, `viz.ts` (guard, title lifting,
   role replacement, theme builder), `viz-runtime.ts`, chart tokens, sandbox fonts and CSP, fallback
   table. Done when a `vega-lite` reply renders an SVG in the panel with the lifted title.
2. **Mermaid retheme.** `base` theme from the tokens, rebuilt on theme change. Done when flow,
   sequence and state diagrams read at 390 px in light and dark.
3. **Design kit.** `kit.css`, token sheet, Plot and D3 runtime. Done when an HTML artifact with
   `.card`, `.stat` and a Plot chart renders in our fonts in light and dark.
4. **Export.** "Lataa SVG" and "Lataa PNG". Done when the SVG file holds `@font-face`.
5. **Prompt.** The routing paragraph.
6. **Tests.** Unit tests (guard, title lifting, roles, theme builder), e2e flows (chart, fallback,
   export) and screens (chart and kit artifacts at 390 and 1024, light and dark).

## Gate

- `pnpm typecheck`, `pnpm lint` and `pnpm --filter @pa/web test` pass.
- The `screens` project passes with strict axe.
- The chromium flows of the artifact panel pass.
- The screenshots of the chart and kit artifacts match the brief: our fonts, legible axes at 390 px,
  no clipped labels, contrast in dark.

## Risks

- An artifact can navigate its own frame or tab to an external URL with data in the query. No CSP
  directive stops a document from navigating itself. The chat that the artifact can see is
  pseudonymized, so the exposure is surrogate text. This risk is older than the sandbox page: the
  `srcdoc` frame had it too.
- "Avaa uudessa ikkunassa" keeps the opener reference, because the app posts the document to the
  tab. The `sandbox` directive (without `allow-top-navigation` and `allow-popups`) stops the
  artifact from navigating its opener. An e2e flow checks that an artifact cannot navigate the
  opener, read `document.cookie` or `fetch('/api/chats')`.
- The sandbox page accepts a document only from `location.origin`. Measured in Chromium:
  `location.origin` in the CSP-sandboxed page is the real origin, not "null". The page posts
  "sandbox-ready" to `location.origin`. In the other direction the app sees the page's messages
  from the origin "null" and can only post to it with the target `'*'`: an opaque origin never
  matches a named origin. The app checks `event.source` and `event.origin === 'null'` and stops
  listening after the first "sandbox-ready". Another origin that opens `/api/sandbox` cannot make
  it render (e2e). Opened directly, with no opener and no parent, the page does nothing.

- The token sheet and the Vega config are frozen. An artifact opened in a new tab keeps the theme
  of the moment it was opened.
- R4 runs once, when the chart renders. A panel resize across 480 px does not thin or un-thin the
  labels until the next render.
- Model HTML that sets its own colours can conflict with the dark page. The prompt tells the model
  to use the kit variables.
- Each themed artifact document carries about 190 KB of base64 fonts.

## UI review fixes (2026-10-26)

A blind UI review scored the first screenshots as FAIL. Changes:

- A themed artifact page has no inner frame. It sits on the panel's `--card` surface without a
  border, so the page does not look like an empty box under short content. The page padding is
  16 px. Every `html`, `jsx` and `tsx` artifact gets the kit, also without kit classes.
- The tabs Esikatselu and Koodi are in a second header row, so the title keeps the header width.
  The track is 44 px high below 768 px. The selected tab is `--card` with `--shadow-sm`.
- Vega: `bandPaddingInner` 0.25; bar corner radius 4 at the end of the bar only.
- The chart subtitle uses the body type (15/24) in `--muted-foreground`.
- Mermaid: the artifact title is `accTitle` (else a `title` line). `accTitle` and `accDescr` show
  as the heading and the caption, as in R1 (`mermaidMeta` in `@pa/protocol`). Edges are
  `--muted-foreground` at 1.5 px with a non-scaling stroke. Nodes have radius 8, an `--input`
  border and a `--secondary` fill. Labels are 14 px, 13 px on phones.
- Plot: `Plot.plot` is wrapped. The model cannot change these defaults: the width is the page
  content width, there are no tick marks and no domain line, and the y label is rotated and
  centred like the Vega axis title. `kit.css` mutes the tick and axis labels, sets the grid to
  `--border` and gives bars radius 3.

## Security review fixes (2026-10-26)

- The guard also counts rows under `datasets` and the steps of a `data.sequence` (500 in all).
  It refuses any `href` (encoding or mark). It drops the model's `$schema` and sets the Vega-Lite
  v6 schema itself, and the runtime embeds with `mode: 'vega-lite'`, so a raw Vega spec cannot
  pass the guard.
- Numeric `width` and `height` are at most 2000 px at every level (concat, facet, repeat,
  layers). PNG export refuses a canvas over 4096 px on a side.
- A chart that does not report "drawn" (`viz-ready`) within 10 s shows the fallback table.
- Colour literals go only under keys that take colours: a `color`, `fill` or `stroke` value (and
  the `value` and `condition` of such a channel) keeps only colour roles; a `range` loses colour
  literals and keeps other strings. Text such as "#2024" in a title or a domain stays.
- Export: a `<parsererror>` fails the export with a toast. `**bold**` converts in the title, the
  subtitle and the caption. The file inlines only the font families it uses. `url(` and
  `@import` are removed from every `<style>` of the exported SVG (a Mermaid `themeCSS` directive
  is model-written).
- Mermaid: `suppressErrorRendering: true`; `htmlLabels: false` at the root and for `flowchart`
  and `class`. Measured with one diagram of each type: `journey` still draws `foreignObject` (2
  elements); flowchart, sequence, class, state, ER, gantt, mindmap, timeline, pie, kanban, block
  and quadrant draw none.
- Plot and D3 load when the source matches `\bPlot\b` or `\bd3\b`. A false positive only
  costs bytes.

## Status (2026-10-26)

- Tasks 1 to 6 are done. `pnpm typecheck` and `pnpm lint` pass.
- `pnpm --filter @pa/web test`: 46 tests pass (10 new in `viz.test.ts`). The server tests of
  `artifacts.test.ts` and `csp.test.ts` pass (one new test for `/api/sandbox`).
- e2e `screens` (strict axe): 456 pass, 2 skipped. New screens: `chart-artifact`,
  `mermaid-artifact` and `kit-artifact` at 390 and 1024, light and dark. `artifact-panel` changed,
  because HTML artifacts now use the kit and the theme.
- e2e `chromium`, the artifact, file, export and chart flows: 119 pass. New flows: the chart with the
  lifted title, the fallback table, the SVG and PNG export.
- Not done: the repair turn after a refused spec (out of scope), the DOT block (out of scope).
