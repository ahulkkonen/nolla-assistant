# README media

This folder holds the images for `README.md` and `docs/overview.md`. The table has one row for
each file. The column "New" marks the eight composites from 2026-11-01.

A source name is a Playwright baseline in `tests/e2e/screenshots/`, without `.png`. The 390 px
baselines are phone shots under touch emulation. All names and values in the shots are synthetic.

| File | New | What it shows | Source baselines | README section | Caption |
|---|---|---|---|---|---|
| `admin.png` | yes | Four management screens at desktop width: the agents and output modes ("Tilat") list, the automation editor, a proposed memory claim, and the usage page. | `settings-agents-1440-light`, `automation-editor-1440-light`, `memory-claims-1024-light`, `usage-month-1024-light` | What it does | Agents, output modes, automations, memory and usage each have a screen of their own. |
| `approval-diff.png` | no | A `profile_edit` approval card with a diff of the assistant prompt, after a web search. | `approval-diff-1440-light` | How it keeps data private | `profile_edit` waits for a card with the diff, and the card warns because the turn read outside content. |
| `approval-fetch.png` | no | A `fetch_url` approval card at 1440 px. | `approval-fetch-1440-light` | How it keeps data private | A `fetch_url` call to an address that you did not write waits for a card. |
| `approval-fetch-phone.png` | no | The same `fetch_url` card on a phone. | `approval-fetch-390-light` | How it keeps data private | The same card on a 390 px phone. |
| `artifact-masked.png` | no | An HTML artifact from a chat that read web content. The thread card and the panel say that real values are hidden, and the page shows a surrogate. | `artifact-masked-1440-light` | overview, "A tour" | A page from a chat that read outside content runs on surrogates. |
| `artifact-panel.png` | no | The artifact panel with an HTML page: two figures, a note and a bar chart. | `kit-artifact-1440-light`, panel only | overview, "A tour" | HTML artifacts run in a sandboxed frame in the side panel. |
| `chart-search.png` | no | A `web_search` row, then a reply with an inline Vega-Lite line chart. | No baseline matches exactly. Phase 32 captured the `chart-inline` chat with a `web_search` row. The nearest baseline is `chart-inline-1440-light`. | overview, "A tour" | A web search, then a Vega-Lite chart inline in the reply, drawn with the app's theme. |
| `dark.png` | yes | Dark mode: a chat with an HTML artifact in the side panel at 1440 px, and an approval card on a phone. | `kit-artifact-1440-dark`, `approval-card-390-dark` | What it does | Dark mode: an HTML artifact in the side panel, and an approval card on a phone. |
| `diagram-dark.png` | no | A Mermaid flowchart in the "Sarake" look, in dark mode. | `mermaid-inline-1440-dark`, an earlier capture | How it keeps data private | A Mermaid diagram in the "Sarake" look, in dark mode. |
| `masking-action.png` | no | The hero: the message, the approved calendar tool and the reply show real names, and a tooltip shows the surrogate that the model saw. | Not a baseline. The MCP calendar flow in `tests/e2e/src/flows.spec.ts` (phase 32, decision 6). Keep this file as it is. | Not in the README since the banner rewrite. The banner strip is a crop of this shot. | None. |
| `masking-action-model.png` | no | The same reply as the model wrote it, with surrogates. | Not a baseline. The same flow as `masking-action.png`. | How it keeps data private | The reply as the model wrote it. Your screen and your calendar show the real names. |
| `memory.png` | no | The memory screen, tab "Havainnot": proposed claims with evidence quotes and review buttons. | `memory-claims-1440-light` | overview, "A tour" | Memory is a list of claims with evidence quotes, and each proposed claim waits for your review. |
| `phone.png` | yes | Four phone screens: a chat with a `web_search` row and its sources, the drawer with a topic group, settings, and files. | `search-row-expanded-390-light`, `sidebar-topics-390-light`, `settings-top-390-light`, `files-tree-390-light` | What it does | On a 390 px phone: a chat with sources, topics in the drawer, settings and files. |
| `settings.png` | yes | Four phone screens: the lower half of settings (speech, notifications, integrations, data), an output mode in its editor, signed-in devices, and the encrypted full export. | `settings-notifications-390-light`, `modes-editor-390-light`, `devices-390-light`, `export-all-dialog-390-light` | What it does, or overview, "A tour" | Settings, an output mode in its editor, your signed-in devices and the encrypted full export. |
| `sizes.png` | yes | The same chat with an inline chart at 390, 1024 and 1440 px, light. | `chart-inline-390-light`, `chart-inline-1024-light`, `chart-inline-1440-light` | What it does, first bullet | One chat at 390, 1024 and 1440 px. |
| `social-preview.png` | no | The GitHub social preview: the wordmark, the three zeros, the tool row and the reply. | Not a baseline. An HTML page in the phase 32 session scratchpad (decision 6). | Top of the README, the light image of the `<picture>` element. Also the repository social preview on GitHub. | None. |
| `social-preview-dark.png` | no | The same banner on the dark canvas, with a dark-mode capture of the same reply. | Not a baseline. The same HTML page with dark tokens and the MCP calendar flow in dark mode. | Top of the README, the dark image of the `<picture>` element. | None. |
| `streaming.gif` | no | A reply streams in. The waiting line shows the queue, thinking and writing times, then the caret. | Not a baseline. A screenshot loop and ffmpeg (phase 32, decision 2). | Why I built it, after the bullets | A reply streams in. The waiting line counts the queue, the thinking and the writing. |
| `thread-controls.png` | yes | The find bar with its hits, a message with versions (2/2), the "Tila" menu above the composer, and the chat export dialog. | `find-bar-1440-light`, `version-switcher-1440-light`, `mode-menu-1440-light`, `export-dialog-1440-light` | What it does | Find text in a chat, switch between message versions, pick output modes and export a chat. |
| `thread.png` | yes | A reply with an inline chart, an open thinking row, an expanded `read` tool row, and a `write` approval card. | `chart-inline-1440-light`, `thinking-open-1440-light`, `tool-expanded-1440-light`, `approval-card-1440-light` | What it does | A chart inline in the reply, the model's thinking, a tool call with its input and result, and an approval card. |
| `vault-add.png` | yes | The vault screen ("Nimisuoja") with the "Lisää suojattava" form, at 1440 px and on a phone. | `vault-1440-light`, `vault-390-light` | How it keeps data private | Add a nickname or another value on the vault screen once, and it is masked from then on. |
| `vault.png` | no | The vault screen before the add form: real values, their type and surrogates, and one detection to confirm. | `vault-1440-light`, before phase 34 added the form | overview, "A tour" | The vault screen lists each real value and its surrogate. |

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

## Crops of the new files

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

A Python and Pillow script made the composites. The script is not in the repository, because
invariant 5 keeps Python out of this part of the tree. Use the crops above to make the set again
after the baselines change.
