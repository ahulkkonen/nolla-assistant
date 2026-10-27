# Phase 20: Figures in the thread, queued messages and colour

The user tested the app on 2026-10-27 and asked for the changes in "Goals". This record gives the
findings, the decisions, the protocol changes, the task cards and the gate of phase 20. The records
of phase 19 (charts, sandbox, export), phase 16 (streaming Markdown) and phase 9 section 7 (the
design brief) stay valid, except where this record changes them.

## Goals

1. Vega-Lite and Mermaid figures render inline in the thread. Each inline figure has an action
   that downloads a PNG with a light background. The export code of `ArtifactPanel.tsx` and
   `viz.ts` is reused. "Avaa paneelissa" stays as a second action.
2. The model picker works while a reply streams; a change applies to the next turn. The user can
   send a message while a reply streams: the message waits in a queue and goes when the turn ends.
   The composer shows the queued message and lets the user cancel it.
3. The artifact panel does not stay open on another chat. A new version of the open artifact
   always reaches the panel.
4. The thread never shows the source of an `html`, `jsx` or `tsx` block, also not while it
   streams. Plain code of any length stays in the thread. Only `vega-lite`, `mermaid`, `html`,
   `jsx` and `tsx` fences are artifacts.
5. Figures use the UI fonts: Inter (UI), Source Serif 4 (titles), JetBrains Mono (code).
6. One figure component for the thread and the panel, one export path, one artifact whitelist in
   `packages/protocol`, no duplicated theme code.
7. Colour for legibility: a token palette with roles in Vega-Lite and classes in Mermaid, and a
   prompt paragraph that tells the model to use colour on purpose.
8. Mermaid subgraph titles stay legible: edges do not cross the title text.
9. A pixel pass by a separate reviewer after the web work.

Constraints: no new dependency (none is added, so no registry check is necessary). Pi stays at
1.3.0. The sandbox rules of phase 19 stay (CSP, no network, no cookies, origin checks). Nothing
unmasked reaches the model. Finnish UI text. Inline figures have an accessible name and keyboard
access to their actions.

## Findings

Lines were read on 2026-10-27 at `eafb170`. `pi/` is
`node_modules/.pnpm/@earendil-works+pi-coding-agent@1.3.0_*/node_modules/@earendil-works/`.
Browser checks ran in Playwright Chromium 1248 (the WebKit build is not installed).

### Artifacts and the thread (goals 1, 4, 6)

| # | Fact | Where |
| --- | --- | --- |
| A1 | The fence whitelist exists twice: `KINDS` on the server, `ARTIFACT_KIND` in the thread. | `apps/server/src/artifacts.ts:4-10`, `apps/web/src/components/MessageView.tsx:61-67` |
| A2 | "Code over 30 lines is an artifact" exists twice. | `artifacts.ts:11,89`, `MessageView.tsx:138` |
| A3 | The title rules exist twice (`headingOf`/`specTitle` and `figureTitle`). | `artifacts.ts:27-59`, `MessageView.tsx:204-218` |
| A4 | The kind-to-extension map exists twice. | `ArtifactPanel.tsx:56-61`, `apps/server/src/tree.ts:231-260` |
| A5 | Rendering, the chart timer and the export live inside the panel component: `documentFor`, `askSvg`, `exportFigure`, the 30 s / 10 s timer. | `ArtifactPanel.tsx:178-245`, `:302-339`, `:403-427` |
| A6 | The 30 s timer starts when the document is set, not when the frame loads. | `ArtifactPanel.tsx:412` |
| A7 | The export uses the active theme. In dark mode the PNG is dark. | `ArtifactPanel.tsx:438-446`, `viz.ts:381-444` |
| A8 | Server artifact ids are `sha1(entryId:index)`. The index counts artifacts in the message, so masked and restored text give the same id. | `artifacts.ts:93`, `tree.ts:263-271` |
| A9 | The server sends `artifact.upsert` only at `turn_end`, for a complete message. | `apps/server/src/bridge.ts:1359-1361` |
| A10 | Nothing produces kind `file`; `code` comes only from A2. `PreviewKind.code` of the file preview is a separate enum. | `packages/protocol/src/index.ts:233`, `FilePreview.tsx:99` |
| A11 | The chat export lists the artifacts of each message (`ChatExport.version` 1). | `apps/server/src/export.ts:110-111`, `protocol/src/index.ts:314` |
| A12 | The diagram rules (edge colour, node radius) are in `kit.css`. The exported SVG is Mermaid's own output, so it does not get them. | `apps/web/src/kit.css:210-240` |

The streaming screenshot. The current code shows the compact card for an unclosed ```` ```html ````
fence once the info line is complete (checked: react-markdown with the caret plugin gives
`language-html` for an unclosed fence). The raw source shows in three cases:

1. The opener line is still incomplete (```` ``` ````, ```` ```ht ````). `settleTail` holds back
   only one or two backticks (`thread.ts:294`), so the block renders as code without a language.
2. The fence has no whitelisted info string (none, `htm`, `xml`, `svg`). It stays a code block.
3. A service-worker bundle older than `71a6fdd`, which added the HTML card.

While the fence streams, the card has no title and an active "Avaa paneelissa" button. The button
opens an empty artifact: `Pre` reads the source only when the `code` child is one string
(`MessageView.tsx:126-129`). The caret span (`:332-347`) and the annotation spans of restored names
(`:298-329`) make it an array, so `source` is `''`.

### The panel (goal 3)

Root cause 1, the panel stays open on another chat: `openArtifact` is global. `setActive`
(`apps/web/src/store.ts:920`) and the other writers of `activeChatId` do not clear it. `App.tsx:148`
shows the panel when `openArtifact` is set, on every chat and every screen. The panel reads the
artifacts of `openArtifact.chatId`, not of the active chat (`ArtifactPanel.tsx:376-379`).

Root cause 2, a new version does not reach the panel: **`apps/web/src/store.ts:610`**. The panel
moves to a new artifact only in the `artifact.upsert` branch `i < 0 && msg.chatId ===
st.activeChatId && st.screen === 'chat'`. An artifact id names a message position (server,
`artifacts.ts:93`) or one exact content (`local-${hash(content)}`, `MessageView.tsx:68-72,144`).
No id links version 2 to the open version 1. So the panel stays on version 1 when the new
artifact arrives by another path:

- `chat.state` after a reconnect (`ws.ts:313`, a phone that slept during the reply).
  `mergeArtifacts` keeps the old open id (`store.ts:317`).
- An upsert while another screen or chat is active.
- A card click on a block whose `source` is `''` (above): `showArtifact` (`store.ts:932-942`)
  matches by content and opens the same empty `local-` artifact again.

A latent race: `SandboxFrame` adds its "sandbox-ready" listener in `useEffect`
(`Sandbox.tsx:59`), after paint. A frame that loads first posts into nothing and stays blank.

### Messages during a run (goal 2)

- The composer does not send while a run is active (`Composer.tsx:153`). The model chip is
  disabled during a run (`ModelPicker.tsx:72-77,156-170`). The server refuses `chat.setModel`
  during a run with `assertIdle` (`bridge.ts:1012`, error `failed` at `:1275`).
- The server accepts a `user.message` during a run: `prompt(..., { streamingBehavior: 'steer' })`
  (`bridge.ts:1137`). Pi runs the input hooks (masking) first, then queues the masked text
  (`pi/pi-coding-agent/dist/core/agent-session.js:1623,1636-1646`).
- Pi 1.3.0 has two queues. `steer` is delivered after the current tool calls, before the next
  model call (`agent-session.d.ts:562-569`). `followUp` is delivered when the run has no more tool
  calls or steering messages (`pi/pi-agent-core/dist/agent-loop.js:191-197`). Both stay inside the
  running session. `clearQueue()` removes all queued messages at once (`agent-session.js:1915-1922`).
- After a model change, `registry.evict` refuses while the run is active, and the next
  `registry.get` rebuilds the session after the run settles (`apps/server/src/pi/registry.ts:192-197,255-270`).

### Fonts (goal 5)

Mermaid renders in the main document (`ArtifactPanel.tsx:210-233`). The SVG string goes into the
sandbox document with the inlined faces. Vega renders in the sandbox (`viz-runtime.ts`). In
Chromium the panel shows Inter and Source Serif 4 for the e2e specs. The causes of wrong fonts:

| # | Cause | Evidence |
| --- | --- | --- |
| T1 | A model-written `%%{init}%%` directive or a front-matter `config:` replaces our theme. `mermaid.initialize` sets no `secure` list (`ArtifactPanel.tsx:217-232`). | Measured: `themeVariables.fontFamily: "Courier New"` gave computed font `"Courier New"` and the forest fill. With `secure` extended (decision 21): Inter and our fill. |
| T2 | R2 drops keys named `font` only (`viz.ts:171`). `labelFont`, `titleFont` and `subtitleFont` of the model's axis, legend or header stay. | Code. |
| T3 | R5 waits for `document.fonts.ready` (`viz-runtime.ts:77`). A face loads only when text uses it. | Measured: at `ready`, `Inter Variable` is `unloaded`; 1.5 s later `loaded`. Vega measures label widths with the fallback font. |
| T4 | Mermaid's top-level `fontFamily` (`"trebuchet ms", verdana, arial`) and the sequence keys (`actorFontFamily` `"Open Sans"`, `messageFontFamily`, `noteFontFamily`) stay at their defaults. Mermaid measures text with them; the CSS paints Inter. | Mermaid 12.2.0 defaults (`chunk-DSNLSHJZ.mjs`); computed text font is Inter in flowchart, sequence, gantt and pie. |

Font files (latin, `wght`, normal) of `@fontsource-variable`: Inter 48,256 B, Source Serif 4
50,936 B, JetBrains Mono 40,404 B. As base64: 64,344 + 67,916 + 53,872 = 186,132 characters per
themed document. The chart runtime is 836,845 B (`viz-runtime-*.js`, built 2026-10-27).

### Colour (goal 7)

Vega-Lite has the roles `@fg @muted @faint @accent @accent-soft @c2 @band` (`viz.ts:51-59`) and
the categorical range `--chart-1` to `--chart-6` (`viz.ts:107-109`). R2 drops `scheme`, so the
sequential and diverging ranges are Vega defaults, not tokens. `--chart-faint` light (#9a988f) is
2.9:1 on `--card`, under 3:1 (`tokens.css:257`). Vega-Lite picks the `diverging` range when a
colour scale has `domainMid`, else `ramp` (`heatmap` for `rect`) (`vega-lite/src/compile/scale/range.ts`).
Mermaid adds the class of `A:::warm` to the node also without a `classDef` (measured: `class="node
default warm"`), and our `themeCSS` is scoped to the diagram id (`#id .node.warm rect`).

### Subgraph titles (goal 8)

Mermaid 12.2.0 has `flowchart.subGraphTitleMargin: { top, bottom }` (default 0/0). It moves the
cluster label (`translate(... + subGraphTitleTopMargin)`, `chunk-HNE4Q36P.mjs`). Measured with the
user's subgraph "3. Numeerinen sääennustus (NWP)": with 0/0, 4/16 and 8/24 the cluster height
stays 277 px and 2 of 2 edges that enter from above cross the title. The label is in `g.cluster`
inside `g.clusters`, which paints before `g.edgePaths` (root children: `clusters, edgePaths,
edgeLabels, nodes`). No option fixes the overlap.

Tooling: the Serena project has `language_servers: []` (`.serena/project.yml`), so its symbol tools
returned nothing. The research used direct file reads.

## Decisions

### Artifacts and the thread

1. **One whitelist.** `packages/protocol` exports `ARTIFACT_FENCES` (`html`→`html`, `jsx`/`tsx`→
   `react`, `mermaid`, `vega-lite`) and `ArtifactKind`. `code`, `file` and `mime` go. *A long code
   block is code; server and web read one list.*
2. **Shared helpers.** `artifactKind(lang)`, `artifactTitle(kind, content)` (spec title, Mermaid
   `accTitle`, else `<title>` or the first `<h1>`–`<h6>` in 4 KB) and `artifactExt(a)` move to
   protocol. *A1, A3 and A4 become one copy each.*
3. **Inline figures.** A closed `vega-lite` or `mermaid` fence renders as an inline figure: a
   `<figure>` with radius 12, 1 px `--border`, `--card` surface, full thread width. A 36 px header
   (48 px under 768 px) holds the kind label ("Kuvaaja", "Kaavio"; micro, muted) and two icon
   buttons: "Avaa paneelissa" and "Lataa PNG". The sandbox frame follows. *Same header as the
   code block; one page colour (`--card`) in thread, panel and export.*
4. **One figure module.** `apps/web/src/render.ts` gets `documentFor`, `themeHead`, `kitHead`,
   `loadScript`, `transpile`, `askSvg` and `exportFigure` from `ArtifactPanel.tsx`.
   `apps/web/src/components/Figure.tsx` gets `useFigure(a)` (document, frame ref, fallback, timer,
   `exportAs`) and `InlineFigure`. The panel uses `useFigure` too. *One render and one export path.*
5. **Height.** Figure documents carry a small size script that posts `{type: 'viz-size', height}`
   on load and on resize. `SandboxFrame` gets a `fit` mode: it accepts the message from its own
   `contentWindow` only and clamps the height to 80–2400 px. The panel stays `size-full`. Until
   the first size, the figure reserves 240 px with "Piirretään…". *No layout jump after render.*
6. **Lazy frames, correct timer.** Inline frames use `loading="lazy"`. The 30 s load timer starts
   at the frame `load` event (fixes A6). *An off-screen lazy frame must not fall back.*
7. **Export is light.** Every SVG and PNG export uses the light theme. `readTokens(root)` reads
   any root; `lightTokens()` reads a hidden same-origin `srcdoc` frame with `<html
   data-theme="light">` and clones of the app's `<link rel=stylesheet>` and `<style>` nodes
   (memoized). Mermaid: render again with light tokens. Vega: the parent posts `{type: 'viz-svg',
   spec}` with `prepareChart(source, light)`; the runtime embeds it into an off-screen `div` of the
   chart width, answers `toSVG()`, then `finalize()` and removes the `div`. `framedSvg` and
   `pngBlob` do not change. *A light image pastes into documents; `tokens.css` stays the one source.*
8. **Streaming card.** While a whitelisted fence is open, the thread shows the card layout with a
   spinning `LoaderCircle` (static with reduced motion), "HTML-sivu · kirjoittaa… 42 riviä"
   ("React-komponentti", "Kuvaaja", "Kaavio"), the title from `artifactTitle` when it is known, no
   button and `aria-busy="true"`. `thread.ts` exports `endsInFence(block)` (the scan of
   `settleTail`); for the live tail, `MarkdownText` adds `rehypeOpenFence`, which sets
   `data-streaming` on the last `pre`. *The source never shows; the line count shows progress.*
9. **Opener hold-back.** `settleTail` holds back a last line that opens a fence. *No code flash
   with a half-typed language.*
10. **Source from the node.** `Pre` takes the text of its hast `node` (all text descendants), not
    `child.props.children`. *The caret and annotation spans no longer empty the source.*
11. **Plain code stays code.** Any code block renders as `CodeBlock` with Kopioi. `onOpen`,
    "Avaa artefaktina" and the 30-line rule go (server and web).

### The panel

12. **The panel closes on chat change.** A store subscription in `store.ts` sets `openArtifact:
    null` when `activeChatId` changes to another chat. `App.tsx:148` shows the artifact panel only
    when `screen === 'chat'` and `openArtifact.chatId === activeChatId`. *The panel belongs to its
    chat (as in Claude Web and ChatGPT); no per-chat memory to keep in sync.*
13. **The panel follows the newest version.** One function `adopt(st, chatId, list)` serves
    `artifact.upsert` and `mergeArtifacts`. In an upsert, an id that the chat's list does not hold
    is new. In a `chat.state`, ids are new only when the chat's list existed before (not on its
    first `chat.state`). When new ids exist: an open panel of this chat moves to the last new
    artifact; a closed panel opens only on a new `html` or `react` artifact of the active chat on
    the chat screen. *Fixes root cause 2 on every path; figures are inline, so they do not open
    the panel.*
14. **No missed ready.** `SandboxFrame` adds the listener in `useLayoutEffect`. *Nothing can run
    between the frame insert and the listener.*

### Queue and model

15. **Model chip during a run.** The server removes `assertIdle` from `chat.setModel`
    (`bridge.ts:1012`); `chat.setDataPolicy` keeps it. The row changes now; the running session
    finishes the turn and `registry.get` rebuilds it after it settles. The chip stays enabled;
    tooltip "Muutos koskee seuraavaa vastausta"; the data-policy items are disabled during a run.
    *Amends phase-10 decision 14 for model and level only; consent stays an idle action.*
16. **The queue lives in the browser.** A queued message is still a draft that the user can cancel,
    and only the browser can show and remove it without new protocol messages, while Pi's queues
    hold masked text inside the running session and `clearQueue()` drops all items at once. Sent
    after `agent.status: idle`, the message starts a new turn on the rebuilt session, so a model
    change made during the reply applies to it, which a Pi `followUp` cannot do.
17. **Queue rules.** The store holds one slot per chat: `queued: Record<chatId, { text,
    attachments }>`. A second send appends with a blank line. `ws.ts` sends the slot on
    `agent.status: idle` of that chat. "Pysäytä", a failed reply (`failed`, `zdrRefused`) or a held
    message put the text back into the composer instead. Composer during a run: empty input shows
    "Pysäytä" (primary, as today); input with text shows "Pysäytä" (outline) and "Lisää jonoon"
    (primary, `ArrowUp`). Enter queues on keyboards. The queued row sits above the textarea:
    `Clock` 16, "Jonossa", the text on one line, "+2 liitettä", and "Peru", which puts the text
    back into the composer. `chat.deleted` drops the slot. The server keeps `steer` for a
    `user.message` that arrives during a run. *Small, no protocol change.*

### Fonts

18. **Inlined faces.** Every themed sandbox document keeps the three latin `wght` normal faces as
    base64 (186 KB). No italic, no latin-ext. The CSP does not change. *One font sheet; a frame on
    an opaque origin cannot load fonts from our origin without CORS, and the export needs data
    URIs anyway.*
19. **R5 that waits.** The runtime awaits `document.fonts.load('12px "Inter Variable"')` and the
    same for `"Source Serif 4 Variable"` before `embed`. The parent awaits the Inter load before
    `mermaid.render`. *Fixes T3.*
20. **R2 drops every family key:** `font` and any key that ends in `Font`. *Fixes T2.*
21. **`mermaidConfig(t, dark, size)` in `viz.ts`.** It returns the options of
    `ArtifactPanel.tsx:217-232` plus: top-level `fontFamily` and the sequence `actorFontFamily`,
    `messageFontFamily` and `noteFontFamily` = `--font-sans` (fixes T4); `secure` = Mermaid's
    defaults (`secure`, `securityLevel`, `startOnLoad`, `maxTextSize`, `suppressErrorRendering`,
    `maxEdges`) plus `theme`, `themeVariables`, `themeCSS`, `fontFamily`, `altFontFamily`,
    `fontSize`, `look`, `darkMode`, `htmlLabels`, `flowchart` (fixes T1); `themeCSS` with the rules
    of `kit.css:210-240` as literal token values, the classes of decision 24 and the cluster halo
    of decision 26. The rules leave `kit.css`. *The export gets the same look as the view (A12).*
22. **Mermaid stays in the main document**, with `securityLevel: 'strict'`. The SVG reaches the
    page only inside the sandbox.

### Colour

23. **Palette and roles.** No new hue: the six chart tokens stay. Light `--chart-faint` becomes
    `#929088` (3.2:1). R7 adds `@c1` to `@c6` (`@accent` = `@c1`; the old roles stay).
    `vegaConfig` gets `range.ramp` and `range.heatmap` = [`--chart-band`, `--chart-3`],
    `range.diverging` = [`--chart-1`, `--chart-band`, `--chart-2`] and `range.ordinal` = `{scheme:
    [band, chart-3]}`. The model gets sequential colour from a quantitative colour field and
    diverging colour from `scale.domainMid`; `scheme` stays dropped. Six colours: more categories
    are grouped as "Muut". *Clay and teal at the ends are distinct for red-green colour blindness.*
24. **Mermaid classes** in `themeCSS` (no `classDef` needed): `warm`, `cool`, `alert`, `ok`,
    `muted`. Values in the table below. Decision nodes keep the shape of phase 19
    (`roundDecisions`). *Colour by meaning without hex values in the source.*
25. **Prompt.** `agents/prompts/assistant.md:11` says that charts and diagrams show in the thread
    and pages in the panel. A new Finnish paragraph after `:13` replaces the role list: use colour
    for meaning; one highlighted series `@accent`, the others `@faint`; at most six categories;
    a quantitative colour field gives a sequential scale, `domainMid` a diverging one; Mermaid
    `:::warm`, `:::cool`, `:::alert`, `:::ok`, `:::muted`; decisions in `{}`; an error path ends
    in an `:::alert` node over a dashed edge `-.->`; never hex values, never `%%{init}%%`, front
    matter `config:`, `classDef` or `style` colours.

| Role or class | Light | Dark | Contrast light / dark |
| --- | --- | --- | --- |
| `@c1` `--chart-1` clay | #b5532a | #e3936b | 5.0 / 5.4 on `--card` |
| `@c2` `--chart-2` teal | #2c7a73 | #6cbab1 | 5.1 / 5.9 |
| `@c3` `--chart-3` blue | #1d5bbf | #8fb6f5 | 6.4 / 6.4 |
| `@c4` `--chart-4` ochre | #9a6700 | #dcb05a | 4.9 / 6.6 |
| `@c5` `--chart-5` plum | #7151c4 | #b8a3f0 | 5.7 / 6.0 |
| `@c6` `--chart-6` rose | #b5446e | #e795b5 | 5.2 / 5.9 |
| `@faint` `--chart-faint` | #929088 (new) | #7f7d75 | 3.2 / 3.2 |
| ramp ends | #f3efe6 → #1d5bbf | #3a3936 → #8fb6f5 | low end 1.1 by design (lowest value); high end 6.4 / 6.4 |
| `warm`: fill `--chart-accent-soft`, stroke `--chart-1` | #f4dfd3 / #b5532a | #4d3429 / #e3936b | text 14.3 / 9.6; stroke 5.0 / 5.4 |
| `cool`: fill `--info-subtle`, stroke `--chart-3` | #e5eefb / #1d5bbf | #22314a / #8fb6f5 | text 15.8 / 10.9; stroke 6.4 / 6.4 |
| `alert`: fill `--destructive-subtle`, stroke `--destructive` | #fbe7e4 / #b42318 | #45282a / #f28b82 | text 15.5 / 11.1; stroke 6.6 / 5.5 |
| `ok`: fill `--success-subtle`, stroke `--success` | #e6f2e3 / #26702b | #24392a / #86c98a | text 16.0 / 10.4; stroke 6.1 / 6.8 |
| `muted`: fill `--muted`, stroke `--chart-faint`, text `--muted-foreground` | #f0eee6 / #929088 | #1f1e1d / #7f7d75 | text 5.2 / 7.3; stroke 3.2 / 3.2 |

Text on the filled nodes is `--foreground` (except `muted`). Marks are measured on `--card` (#ffffff
/ #30302e), the page of every figure. On `--chart-band` the six colours are 4.2–5.5 / 4.8–5.7.

### Subgraphs and the pixel pass

26. **Subgraph titles.** `flowchart.subGraphTitleMargin: { top: 4, bottom: 0 }` (the title leaves
    the border; measured gap to the first node stays 22 px). After `mermaid.render`, the parent
    moves every `g.cluster-label` to the end of its `g.root`, so it paints over the edges.
    `themeCSS` gives the label text a halo: `paint-order: stroke; stroke: <cluster fill>;
    stroke-width: 4px; stroke-linejoin: round`. `themeVariables.clusterBkg` is set to
    `--chart-band` so the halo and the fill cannot drift. *No Mermaid option reserves space.*
27. **Pixel pass.** A separate Opus reviewer measures the result after the web cards (card P1).

## Protocol and data changes

- `packages/protocol`: `ArtifactKind = z.enum(['html', 'react', 'mermaid', 'vega-lite'])`;
  `Artifact.kind = ArtifactKind`; `mime` goes; `ARTIFACT_FENCES`, `FIGURE_KINDS = ['vega-lite',
  'mermaid']`, `artifactKind`, `artifactTitle`, `artifactExt`. `tsc` finds any producer of the
  removed values.
- No WebSocket message changes. `chat.setModel` during a run is a server rule change (decision 15).
  The queue is browser state (decision 17).
- Sandbox messages (web only): frame to parent `{type: 'viz-size', height}`; parent to frame
  `{type: 'viz-svg', spec?}` (with `spec`: draw it off-screen and answer its SVG).
- `SANDBOX_CSP` and the sandbox page do not change. No database change.
- `ChatExport` keeps `version: 1`. Its artifact list gets shorter (no long code). Older files can
  hold `code`; no code in this repo reads an export back.
- Artifact ids of a message with long code blocks change (the index of A8). An open tab must reload
  before "Tallenna työkansioon" works for such a message.

## Task cards

One server implementer (S) and one web implementer (W) work in parallel. S1 lands first. Every card
ends with `pnpm typecheck` and `pnpm lint`.

| ID | Title | Owner | Files | Tests to write | Acceptance | Order |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Whitelist and helpers | server | `packages/protocol/src/index.ts` (+ test) | `artifactKind` maps the five fences only; `artifactTitle` per kind (partial JSON gives undefined); `artifactExt` (`tsx`, `jsx`, `mmd`, `json`, `html`) | Protocol tests pass; `code`, `file`, `mime` gone | first |
| S2 | Server artifacts | server | `apps/server/src/artifacts.ts`, `tree.ts`, `export.ts`, their tests | a 40-line `python` block is no artifact; the five fences are; masked and restored text give the same ids; save names use `artifactExt`; export lists no code | Server tests pass; no `KINDS`, `MIN_CODE_LINES`, `EXT` | after S1 |
| S3 | Model change during a run | server | `apps/server/src/bridge.ts`, a bridge test | `chat.setModel` during a run answers no error, writes the row, broadcasts `chat.updated`; the turn after settle runs on a rebuilt session with the new model; `chat.setDataPolicy` during a run still answers `failed` | Tests pass | any time |
| S4 | Prompt | server | `agents/prompts/assistant.md` | seed manifest tests still pass | Decision 25 text in Finnish; role names as in the table | after S1 |
| W1 | Figure module | web | new `render.ts`, new `components/Figure.tsx`, `ArtifactPanel.tsx` | existing `viz.test.ts` and panel e2e flows pass unchanged | Panel works as before; `ArtifactPanel.tsx` has no render or export code | first web |
| W2 | Inline figures and light export | web | `Figure.tsx`, `Sandbox.tsx` (`fit`, `useLayoutEffect`), `viz-runtime.ts` (size, off-screen SVG), `viz.ts` (`readTokens(root)`, `lightTokens`), `MessageView.tsx` | e2e: a chart and a diagram render inline with an accessible name; "Lataa PNG" in dark mode gives a PNG whose corner pixel is light; Tab reaches both actions; a lazy frame below the fold does not fall back after 30 s | Flows pass; one `exportFigure` | after W1, S1 |
| W3 | Fonts and Mermaid config | web | `viz.ts` (`mermaidConfig`, R2), `viz-runtime.ts` (R5), `render.ts` (cluster labels), `kit.css` | unit: `labelFont`/`titleFont` dropped; `secure` holds the theme keys; e2e: a diagram with `%%{init: {"themeVariables": {"fontFamily": "Courier New"}}}%%` computes Inter; the cluster label follows `edgePaths` in the DOM | Tests pass | after W1 |
| W4 | Colour | web | `tokens.css` (`--chart-faint`), `viz.ts` (roles, ranges, classes in `themeCSS`) | unit: `@c1`–`@c6` map; `config.range` has `ramp`, `heatmap`, `diverging`, `ordinal`; e2e: `:::alert` node fill is `--destructive-subtle` | Tests pass; the `ordinal` scheme array interpolates (else drop `ordinal`) | after W3 |
| W5 | Thread cards and streaming | web | `MessageView.tsx`, `thread.ts`, `CodeBlock` callers | unit (`thread.test.ts`): `settleTail` holds `"```ht"`; `endsInFence`; node text with annotation spans gives the full source; e2e: a streaming `html` block shows "HTML-sivu · kirjoittaa…" and no source; a 40-line `python` block shows as code with Kopioi and no "Avaa artefaktina" | Tests pass | after S1 |
| W6 | Panel ownership and versions | web | `store.ts`, `App.tsx`, `ArtifactPanel.tsx` | `store.test.ts`: a chat change clears `openArtifact`; an upsert of a newer artifact moves an open panel; a `chat.state` with a new id moves it; the first `chat.state` opens nothing; a figure upsert with a closed panel opens nothing; an `html` upsert opens the panel | Tests pass | after W1 |
| W7 | Queue and model chip | web | `store.ts`, `ws.ts`, `Composer.tsx`, `ModelPicker.tsx` | unit: the slot goes on idle; it returns to the composer after stop or failure; e2e: queue during a slow fake stream, see the row, cancel it; queue again and see it sent after the reply; the chip opens during a run | Tests pass | after S3 |
| P1 | Pixel pass | separate Opus reviewer | web files of W2–W7 | none new; fixes keep the gate green | Every check below holds at 390, 1024 and 1440, light and dark | after W2–W7 |
| U1 | Blind UI review | UI reviewer | screenshots | the screens of "UI review brief" | Every cell 4 or 5, no blocking finding | after P1 |

P1 checks (measure in the browser, not by eye):

- Inline figure: radius 12 px, 1 px `--border`, `--card` fill; left and right edges on the prose
  column (672 px at ≥768, 358 px at 390); 16 px above and below (the paragraph gap).
- Figure header: 36 px high (48 under 768), padding 16 left and 4 right, label micro 12/16
  muted; icon buttons 28 px with 4 px gap; under 768 each hit area is 44 × 44 with 8 px between.
- Figure page: padding 16; title Source Serif 4 21.6/28 at 600; subtitle 15/24 muted; caption
  13 px muted with 12 px above it; chart axis labels Inter 12 px; no label clipped at 390 px.
- Placeholder 240 px high before the first `viz-size`; no jump larger than the final height
  difference.
- Artifact card (also streaming): at least 48 px high, padding 8 8 8 16, icon 16, title 14/20
  one line with ellipsis, button 32 px (44 under 768); the streaming card has the same height.
- Composer: queued row padding 12 12 0, text 13/18 one line, "Peru" 24 px (44 under 768); the
  two run buttons 36 px (44 under 768) with 8 px between.
- Exported PNG from dark mode: light background, Inter text, 2× pixel ratio.

## UI review brief

The blind reviewer scores each screen at 390, 1024 and 1440 px, light and dark (brief section 7,
phase-19 rules, decisions 3, 8, 17 and 23–26):

1. `chart-inline`: a reply with a multi-series line chart inline (title, subtitle, caption,
   `@accent` series and `@faint` context series).
2. `mermaid-inline`: a flowchart inline with a subgraph titled "3. Numeerinen sääennustus (NWP)",
   edges into the subgraph, and `warm`, `cool` and `alert` nodes.
3. `artifact-streaming`: an `html` block while it streams (the writing card).
4. `composer-queue`: a streaming reply, a queued message row, the two run buttons, the model chip.
5. `artifact-panel`, `chart-artifact`, `mermaid-artifact`: the panel screens of phase 19, shot again.

## Gate

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass (all unit suites and the e2e `chromium`
   flows).
2. `pnpm --filter @pa/e2e exec playwright test --project screens` passes with strict axe.
3. The tests named in the task cards pass.
4. Docker image. On 2026-10-27 the disk of the local Docker VM (47 GB) filled with images and build
   cache, and the server crashed with `SQLITE_IOERR_SHMSIZE`. Before every image build, run
   `docker system df`. If the free space of the Docker disk is under 10 GB, run `docker builder
   prune -f` and `docker image prune -f` first. Then run `docker build -f infra/Dockerfile.server
   -t pa-server:phase20 .` and the compose smoke (`/healthz` answers).
5. P1 is done and U1 passes.

## Risks and ceilings

- `š` and `ž` are not in the latin subset; they fall back to the system font in figures.
- Each chart frame holds the 837 KB runtime and 186 KB of fonts. Lazy frames limit the cost; a
  chat with many charts still uses more memory.
- The queue lives in one tab. A closed tab loses it; two tabs can both send.
- A queued message that arrives before Pi's prompt promise resolves at settle steers into the old
  session (old model). The window is the time between `agent_settled` and the idle event.
- Safari has no scroll anchoring: a figure that grows above the viewport moves the text.
- The halo hides an edge under the title glyphs only; an edge can still run between words.
- WebKit was not measured.
