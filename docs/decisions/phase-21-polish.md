# Phase 21: diagram look, export typography, newest models, confidence trial, tool rows

Date: 2026-10-28. Follows phase 20 (`phase-20-thread.md`). The user chose these after three demo
pages of diagram styles and a written discussion.

## Decisions

1. **Diagram look "Sarake".** Flowcharts keep the studio-flat colour language: 1 px hairline in
   the role hue, a light tint fill, label text in a dark step of the same hue, weight 500, 14/20.
   Every node is 212 px wide (phones: 184 px) with evenly wrapped centred text. Branch edges are
   right-angle connectors with 10 px rounded corners. Edge labels are small uppercase (11 px,
   letter-spacing 0.06em). The decision node is a neutral node with a dashed hairline. The role
   colours are tuned in OKLCH so tint, hairline and text share lightness and chroma across roles,
   in both themes. The post-render pass in `render.ts` (`finishDiagram`) grows: it wraps labels,
   sizes the emoji, snaps nodes to the pixel grid, aligns rows and redraws edges. Reference demo:
   the designer's variant B in the session scratchpad (`diagram-styles-demo-3.html`); its DOM pass
   is the starting point.
2. **Export typography.** `framedSvg` wraps the title and the caption into `tspan` lines measured
   with the loaded fonts (canvas `measureText`). The sheet is at least 560 px wide, margin 24 px.
   Title Inter 600 17/24 letter-spacing -0.012em; caption 13/18 muted, at most 68ch. The export
   sanitiser keeps `url(#id)` fragments and removes only external `url(…)`.
3. **"Uusimmat" in the model catalog.** The catalog fetch keeps OpenRouter's `~author/family-latest`
   aliases and reads `alias_target` and `created`. The picker shows a section "Uusimmat" above
   "Kaikki mallit": one row per lab (anthropic, openai, google, x-ai, deepseek, meta-llama,
   mistralai), the alias target resolved to its concrete catalog model; a lab without an alias
   shows its newest model by `created`. A chat stores the concrete id, never an alias.
4. **Confidence trial, inline markers.** A per-chat toggle `confidence` (chats column, default
   off). When on, the system prompt gets a paragraph: after every sentence of prose the model writes
   `⟦N⟧`, N from 1 (guess) to 9 (certain); never inside code blocks or tables. Pi's stored text keeps
   the markers (the model sees its own markers in later turns). The web renders them: a rehype
   plugin wraps the sentence before each marker in a span with `--conf`, colour
   `color-mix(in oklch, var(--foreground) P%, var(--muted-foreground))` where P runs from 35 (N=1) to
   100 (N=9), tooltip "Luottamus N/9". Copy, export and search strip the markers with one shared
   protocol helper `stripConfidence`. A marker that is still streaming (`⟦` without `⟧`) is hidden.
   Final floor: P = 35. At N=1 the text reaches 9.1:1 on `--background` (light) and 8.5:1 (dark),
   so axe passes and the floor stays.
5. **Tool row icons.** The row shows a tool icon before the name: recall and memory `Brain`,
   read `FileText`, write and edit `FilePen`, bash `Terminal`, web_search `Globe`, MCP tools
   `Plug`, others `Wrench`. The status icon stays where it is.
6. **Thinking box.** `thinkingOf` trims the joined text; no empty last line under `pre-wrap`.
7. **Auto-approve ("yolo") per chat.** `chat.setAutoApprove { chatId, on }` sets the approval
   gate's existing `unattended` map for that chat to the agent's `approval.always` tools minus MCP
   writes and minus `web_search` (entity queries still ask). The composer shows a toggle "Hyväksy
   automaattisesti" with a warning badge while on. The setting is per chat and not stored: a
   server restart turns it off.
8. **Skill-runner image.** Built on this machine with `scripts/build-skill-runner.sh`. The error
   `No such image: pa-skill-runner:latest` means the image is missing on the host, not a bug.

## Status

Open. Work split in four worktrees: viz (1, 2), models (3), conf (4), tools (5, 6, 7).
