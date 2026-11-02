# README media

This folder holds the images for `README.md` and `docs/overview.md`. The table has one row for
each file. A Python and Pillow script made the composites, and an HTML page made
`social-preview.png`. Neither file is in the repository. Invariant 5 keeps Python out of this part
of the tree.

A source name is a Playwright baseline in `tests/e2e/screenshots/`, without `.png`. The 390 px
baselines are phone shots under touch emulation. All names and values in the shots are synthetic.
"More screens" is the folded block at the end of the README section "What it does".

| File | What it shows | Source baselines | README section | Caption |
|---|---|---|---|---|
| `admin.png` | Four management screens at desktop width: the agents and output modes ("Tilat") list, the automation editor, a proposed memory claim, and the usage page. | `settings-agents-1440-light`, `automation-editor-1440-light`, `memory-claims-1024-light`, `usage-month-1024-light` | What it does | Agents, output modes, automations, memory and usage each have a separate screen. |
| `approval-diff.png` | A `profile_edit` approval card with a diff of the assistant prompt, after a web search. | `approval-diff-1440-light` | What it does, "More screens". Also overview, "A tour". | The assistant wants to edit its own prompt. The card shows the diff and warns that the turn read content from outside the chat, such as a web page. |
| `approval-fetch.png` | A `fetch_url` approval card at 1440 px. | `approval-fetch-1440-light` | What it does, "More screens". Also overview, "A tour". | Fetching a URL you did not write requires approval on desktop and phone. |
| `approval-fetch-phone.png` | The same `fetch_url` card on a phone. | `approval-fetch-390-light` | What it does, "More screens". Also overview, "A tour". | The caption of `approval-fetch.png` covers both images. |
| `artifact-masked.png` | An HTML artifact from a chat that read web content. The thread card and the panel say that real values are hidden, and the page shows a surrogate. | `artifact-masked-1440-light` | Overview, "A tour" only | A page from a chat that read outside content runs on surrogates. "Näytä oikeat arvot" asks before it shows real values. |
| `artifact-panel.png` | The artifact panel with an HTML page: two figures, a note and a bar chart. | `kit-artifact-1440-light`, panel only | Overview, "A tour" only | HTML artifacts run in a sandboxed frame in the side panel, styled by a shared design kit. |
| `chart-search.png` | A `web_search` row, then a reply with an inline Vega-Lite line chart. | No baseline matches exactly. Phase 32 captured the `chart-inline` chat with a `web_search` row. The nearest baseline is `chart-inline-1440-light`. | Overview, "A tour" only | A web search, then a Vega-Lite chart inline in the reply, drawn with the app's theme. |
| `dark.png` | Dark mode: a chat with an HTML artifact in the side panel at 1440 px, and an approval card on a phone. | `kit-artifact-1440-dark`, `approval-card-390-dark` | What it does | Dark mode has its own color palette: an HTML page in the side panel, and an approval card on a phone. |
| `diagram-dark.png` | A Mermaid flowchart in the "Sarake" look, in dark mode. | `mermaid-inline-1440-dark`, an earlier capture | What it does, "More screens". Also overview, "A tour". | A Mermaid diagram in the app's own style, in dark mode. |
| `masking-action.png` | The message, the approved calendar tool and the reply show real names, and a tooltip shows the surrogate that the model saw. | Not a baseline. The MCP calendar flow in `tests/e2e/src/flows.spec.ts` (phase 32, decision 6). Keep this file as it is. | Not in the README. The banner strip is a crop of this shot. Overview, top. | None in the README. |
| `masking-action-model.png` | The same reply as the model wrote it, with surrogates. | Not a baseline. The same flow as `masking-action.png`. | How it keeps data private. Also overview, top. | The reply as the model wrote it. Your screen and your calendar show the real names. |
| `memory.png` | The memory screen, tab "Havainnot": proposed claims with evidence quotes and review buttons. | `memory-claims-1440-light` | Overview, "A tour" only | Memory is a list of claims with evidence quotes. A proposed claim waits for your review. |
| `phone.png` | Four phone screens: a chat with a `web_search` row and its sources, the drawer with a topic group, settings, and files. | `search-row-expanded-390-light`, `sidebar-topics-390-light`, `settings-top-390-light`, `files-tree-390-light` | What it does. Also overview, "A tour". | On a phone: a chat with its web sources, topics in the drawer, settings and files. |
| `settings.png` | Four phone screens: the lower half of settings (speech, notifications, integrations, data), an output mode in its editor, signed-in devices, and the encrypted full export. | `settings-notifications-390-light`, `modes-editor-390-light`, `devices-390-light`, `export-all-dialog-390-light` | What it does, "More screens". Also overview, "A tour". | Settings, an output mode in its editor, your signed-in devices and the encrypted full export. |
| `sizes.png` | The same chat with an inline chart at 390, 1024 and 1440 px, light. | `chart-inline-390-light`, `chart-inline-1024-light`, `chart-inline-1440-light` | What it does, first image. Also overview, "A tour". | One app, three widths: 390, 1024 and 1440 px. Every screen is tested at these widths, in light and dark, with strict accessibility checks. |
| `social-preview.png` | The banner and the GitHub social preview: the wordmark, the three zeros, the tool row and the reply. | Not a baseline. An HTML page (phase 32, decision 6). | Top of the README. Also the repository social preview on GitHub. | None. |
| `streaming.gif` | A reply streams in. The waiting line shows the queue, thinking and writing times, then the caret. | Not a baseline. A screenshot loop and ffmpeg (phase 32, decision 2). | Why I built it, after the bullets. Also overview, "A tour". | A reply streams in. The waiting line counts the queue, the thinking and the writing. |
| `thread-controls.png` | The find bar with its hits, a message with versions (2/2), the "Tila" menu above the composer, and the chat export dialog. | `find-bar-1440-light`, `version-switcher-1440-light`, `mode-menu-1440-light`, `export-dialog-1440-light` | What it does, "More screens" | Find text in a chat, switch between message versions, pick output modes and export a chat. |
| `thread.png` | A reply with an inline chart, an open thinking row, an expanded `read` tool row, and a `write` approval card. | `chart-inline-1440-light`, `thinking-open-1440-light`, `tool-expanded-1440-light`, `approval-card-1440-light` | What it does. Also overview, "A tour". | On a desktop: an inline chart, the model's thinking, a tool call with input and result, and an approval card. |
| `vault-add.png` | The vault screen ("Nimisuoja") with the "Lisää suojattava" form, at 1440 px and on a phone. | `vault-1440-light`, `vault-390-light` | How it keeps data private | Add a nickname once to mask it from then on. A weak detection like `Koski` stays masked until you confirm it as a name or dismiss it. |
| `vault.png` | The vault screen before the add form: real values, their type and surrogates, and one detection to confirm. | `vault-1440-light`, before phase 34 added the form | Overview, "A tour" only | The vault screen lists each real value and its surrogate. A weak detection stays masked until you confirm it. |

## Layout of the composites

- The background is the app canvas: `#faf9f5` in light, `#262624` in dark.
- Each shot has a 1 px border in the app border colour over the canvas: `#dfdedb` in light,
  `#3e3e3b` in dark. These values come from the baselines.
- The gutter between shots and the outer margin are 24 px.
- The composites have no shadows, no device frames and no text. The captions go in the README.
- One composite uses one theme only.
- The pixels are native, except in `sizes.png` and `dark.png` (see the crops).
- The composites are 1,450 to 1,820 px wide. GitHub scales them to the README column, so they show
  at about 2x on a high-density screen.

## Crops of the composites

A box is `x0, y0, x1, y1` in source pixels.

- `thread.png`: `chart-inline-1440-light` `500, 56, 1204, 930`. `thinking-open-1440-light`
  `500, 144, 1204, 351`. `tool-expanded-1440-light` `500, 144, 1204, 404`.
  `approval-card-1440-light` `500, 144, 1204, 499`.
- `thread-controls.png`: `find-bar-1440-light` `500, 56, 1204, 338`.
  `version-switcher-1440-light` `500, 56, 1204, 443`. `mode-menu-1440-light`
  `500, 579, 1204, 900`. `export-dialog-1440-light` `368, 276, 1072, 624`.
- `admin.png`: the two 1440 shots `472, 0, 1232, 665`. The two 1024 shots `264, 0, 1024, 440`.
  The 1024 baseline shows the automation editor scrolled down, so the editors come from 1440.
- `vault-add.png`: `vault-1440-light` without rows 532 to 575, then `356, 0, 1348, 681`.
  `vault-390-light` without rows 665 to 758, then `0, 0, 390, 681`. The removed rows hold the
  identity code row, because phase 32 keeps identity codes out of the media.
- `sizes.png`: the full shots, each scaled to a height of 560 px.
- `dark.png`: `kit-artifact-1440-dark` scaled to a height of 844 px. `approval-card-390-dark` at
  native size.
- `phone.png` and `settings.png`: the full 390 × 844 shots.

Use these crops to make the composites again after the baselines change.
