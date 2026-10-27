# Phase 9: production UI on shadcn/ui

Goal: the PWA looks and feels production-ready on a phone (390) and on a desktop (1024, 1440),
in light and dark. The gate is visual, judged from screenshots by a reviewer that did not write
the code.

Gate: the UI reviewer scores every screen at every breakpoint and scheme at 4 or 5 on each
criterion in section 5, with no open blocking or should-fix finding; `pnpm test` passes; the
axe accessibility scan reports no serious or critical violation on any screen.

## 1. Decisions

1. **Migrate, do not rewrite.** `store.ts`, `ws.ts`, `api.ts`, screens and e2e flows stay.
   Only the component layer changes. E2e selectors go by role and label, so most survive.
2. **shadcn/ui on the installed stack.** Components are generated into
   `apps/web/src/components/ui/` with the shadcn CLI (Tailwind 4 style). New npm dependencies:
   `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`, `sonner` (toasts),
   `@fontsource-variable/inter` or `geist` (the font ships in the bundle; no runtime font
   request, because the PWA is offline-first and private). Every pin obeys the 7-day rule.
3. **One design brief before code.** The reviewer agent writes a one-page brief from the current
   screenshots: type scale, spacing scale, radius, color roles (one neutral base, one accent,
   semantic colors), density, motion, empty and loading states. The implementer builds to the
   brief. The brief lives in this file, section 7, after round 0.
4. **Two agents, both Opus 5.5 at xhigh effort, both persistent.** The implementer keeps its
   context across rounds. The reviewer never sees the implementer's reasoning or diff: it gets
   screenshots and the criteria, and returns findings. Fable orchestrates and commits.
5. **Fast screenshot loop.** A Playwright project `screens` runs only `screens.spec.ts`
   (all breakpoints and schemes) in about two minutes. Flows run once per slice, not per round.
6. **Accessibility is in the gate.** `@axe-core/playwright` runs on each screen in
   `screens.spec.ts`. Serious or critical violations fail the test.
7. **iOS PWA details are in scope.** `viewport-fit=cover` with safe-area insets, `100dvh`,
   `theme-color` per scheme, no layout shift while a reply streams, keyboard-aware composer,
   reduced motion honoured.
8. **Agents screen stays read-only.** Decided in phase 7.

## 2. Component map

| Hand-rolled now | shadcn/ui |
|---|---|
| buttons, icon buttons | `Button` (variants default, secondary, ghost, destructive, icon) |
| inputs, textareas, selects | `Input`, `Textarea`, `Select` |
| settings dialog, confirm dialog | `Dialog`, `AlertDialog` |
| mobile drawer, artifact sheet | `Sheet` |
| sidebar row menus, agent picker | `DropdownMenu` |
| tooltips | `Tooltip` |
| vault, automations, topics tables | `Table` |
| topic chips, status pills | `Badge` |
| approval card, memory panes, integration row | `Card` |
| push toggle, vault never-detect | `Switch` |
| palette | `Command` (wraps the installed cmdk) |
| toasts | `Sonner` |
| loading states | `Skeleton` |
| mic level | `Progress` |
| long lists | `ScrollArea` |
| dividers | `Separator` |
| tabs in artifact panel | `Tabs` |

## 3. Slices

Each slice ends with: `screens` run, reviewer round(s) until PASS for that slice, flows run,
commit.

| # | Slice | Screens |
|---|---|---|
| 0 | Design brief; shadcn init; tokens (`tokens.css` rewritten to shadcn variables); font; `ui/` kit generated; axe wired into `screens.spec.ts` | none (brief + kit only) |
| 1 | Shell: sidebar and drawer, thread, message bubbles, tool rows, composer with mic and attachments, login | login, empty-chat, chat, chat-annotated, composer-attachments, tool-*, sidebar-*, voice-recording, message-actions |
| 2 | Dialogs and tables: settings (all sections), vault, topics, search results, confirm dialogs, toasts | settings-*, vault-*, topics-*, search-*, error-toast |
| 3 | Rich surfaces: approval card, subagent row, memory screen and chip, agents, automations, artifact panel, palette | approval-*, subagents-row, memory-*, settings-agents, settings-automations, artifact-panel, palette |
| 4 | Final: full-set review, axe clean, iOS details, PWA icons and splash, screenshot baselines | all 188+ |

## 4. Round protocol

1. Implementer applies the slice (or the fixes), runs `pnpm --filter @pa/e2e exec playwright
   test --project screens`, confirms the run is green, and reports the list of changed files.
2. Fable sends the reviewer the screen list for the slice. The reviewer views every
   screenshot of the slice in all six variants and returns one line per finding
   (`screen-width-scheme: severity problem. fix.`), a score table (section 5), and
   `SLICE: PASS` or `SLICE: FAIL`.
3. Fable forwards findings to the implementer. Blocking and should-fix items must be fixed;
   nice-to-have items are fixed unless the implementer gives a one-line reason.
4. Repeat 1 to 3. Budget: five rounds per slice. If a slice is still FAIL after five rounds,
   Fable stops and reports to the user with the open findings.
5. After PASS: implementer runs the full `pnpm test`, Fable commits the slice.

Reviewer independence: the reviewer gets screenshots, the brief and the criteria. It never gets
the diff, the implementer's report, or Fable's opinion of the result.

## 5. Criteria and scoring

Each screen, at each breakpoint and scheme, scores 1 to 5 on:

1. **Hierarchy**: one clear primary action; headings, body and meta text are distinct steps of
   the type scale.
2. **Rhythm**: spacing comes from one scale; aligned edges; no orphaned gaps.
3. **States**: hover, focus-visible, active, disabled, loading, empty and error states exist and
   are visible; empty states have one action.
4. **Fit**: nothing clipped, overlapped or truncated without intent; 44 px targets under 768;
   tables fit or scroll on purpose.
5. **Parity**: light and dark use the same layout; dark is not inverted light; contrast meets
   WCAG AA.
6. **Finish**: consistent radius, borders and shadows; icons one size and weight; Finnish copy
   correct and short; no 2023 defaults (grey-on-grey, equal-weight text, unlabelled icons).

Gate: every cell 4 or 5. A 3 is a should-fix finding; 1 or 2 is blocking.

## 6. Risks

- **Selector drift.** shadcn `Dialog` and `Sheet` change the DOM. Keep `aria-label`s and button
  names; fix selectors in `fixtures.ts` once, not per test.
- **Precache size.** Fonts add 100 to 300 KB. Keep the shell precache under 1.5 MB; check
  `vite build` output each slice.
- **Reviewer drift.** Scores inflate when the same reviewer sees the same screens many
  times. The round-4 full-set review runs on a fresh reviewer agent.
- **Pins.** The shadcn CLI generates source files, not a dependency, so only its npm
  dependencies fall under the 7-day rule. The implementer checks each pin with the registry
  date and lists them in its report.

## 7. Design brief

Written in round 0 from the current screenshots and `0006-ui-reference.md`. Each section ends with a "Source" line that separates research values from values the reviewer chose where the research had none ("chosen"). The implementer builds to these values; the reviewer judges against them.

### 7.1 Direction

The app feels calm, warm and text-first: a cream canvas in light, a warm charcoal canvas in dark, one centered column of serif prose, and controls that stay quiet until they are needed. Color only carries meaning: ink for the one primary action, blue for focus and links, and tints for state, masked text and approvals. Management screens (vault, automations, memory) are denser than the thread, but they use the same type scale, radii and tokens.

- **From Claude Web:** warm neutral token ladder; gray (not black) dark mode where higher surfaces get lighter; serif assistant replies with sans user text; lower font weights in dark; message actions revealed on hover; artifacts in a side panel; named z-index layers.
- **From ChatGPT:** composer state machine (send / stop / recording); monochrome ink primary button; 42rem measure; sr-only turn headings; actions always visible under the latest reply; Cmd/Ctrl+K palette; collapsed inline rows for tools and reasoning.
- **Own:** lilac masked-text annotation; inline approval card with a warning outline; subagents row built as a tool-row variant; tinted memory diff without strike-through; red hold-to-record mic with timer; vault and automations tables that turn into cards on the phone; Finnish copy rules.

### 7.2 Typography

Fonts ship in the bundle; no runtime font request. Precache only the `latin` subset `wght` files (Finnish ä, ö, å are in it); fonts total ≤ 250 KB of the 1.5 MB shell precache.

| Role | Package | Family token |
|---|---|---|
| UI, user messages, tables | `@fontsource-variable/inter` | `--font-sans: "Inter Variable", system-ui, sans-serif` |
| Assistant prose, empty-state greeting | `@fontsource-variable/source-serif-4` (normal + italic) | `--font-serif: "Source Serif 4 Variable", Georgia, serif` |
| Code, tool args, memory panes, diff, identifiers | `@fontsource-variable/jetbrains-mono` | `--font-mono: "JetBrains Mono Variable", ui-monospace, monospace` |

Text roles. Rename `--text-secondary` to `--text-meta`, so that `--color-secondary` can exist.

| Token | Font | ≥768 px | <768 px | Weight light / dark | Use |
|---|---|---|---|---|---|
| `--text-display` | serif | 28/36 | 24/32 | 400 / 380 | empty-state greeting only |
| `--text-title` | sans | 20/28 | 18/26 | 600 / 560 | page h1, dialog title, login title |
| `--text-heading` | sans | 16/24 | 16/24 | 600 / 560 | section h2, card title, approval title |
| `--text-prose` | serif | 17/28 | 16/26 | 400 / 380 | assistant reply body |
| `--text-body` | sans | 15/24 | 15/24 | 400 / 380 | user bubble, list rows, labels, table cells |
| `--text-ui` | sans | 14/20 | 14/20 | 500 / 480 (buttons, tabs), 400 / 380 (rows, menu items) | controls, sidebar rows |
| `--text-meta` | sans | 13/18 | 13/18 | 400 / 400 (table header 500) | counters, helper text, tool rows, timestamps |
| `--text-micro` | sans | 12/16 | 12/16 | 500 / 480 | badges, kbd, sidebar group labels, tooltips |
| `--text-code` | mono | 14/22 | 13/20 | 400 / 400 | code blocks; inline code 0.875em |

- Every input and textarea is 16 px under 768 px (iOS zooms on smaller input text).
- Markdown in replies: h1 20/28, h2 18/26, h3 17/28, all serif 600 (dark 560); paragraph gap 16; list indent 24, item gap 4; blockquote 2 px `--border` left rule, padding-left 16, `--muted-foreground`.
- Numbers in counters, tables and timers use `font-variant-numeric: tabular-nums`. Mono uses `font-variant-ligatures: none`.
- Finnish: `<html lang="fi">`. `hyphens: auto` and `text-wrap: pretty` on prose, user bubbles and helper paragraphs. `overflow-wrap: anywhere` on bubbles and table cells (URLs, hetu). `hyphens: manual` on headings, buttons, labels, sidebar rows, mono and code. Headings use `text-wrap: balance`. Code blocks get `translate="no"`.

Source: font families, serif-for-replies, code 14 px, prose about 16/1.6, dark weight drop 400 → 380 and `lang`/`hyphens` are research. All other sizes and weights are chosen.

### 7.3 Color

Neutral base: warm gray. One accent: blue, for focus ring and links only. The primary action is ink, not blue. Dark mode is structurally different: the canvas is warm charcoal, elevation goes lighter (sidebar < canvas < card), recessed surfaces go darker, the primary button turns cream, accents get lighter, and weights drop 20 to 40 units. No pure black surface; pure white only for light cards, popovers and the artifact page.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | #faf9f5 | #262624 | canvas, thread, top bar |
| `--foreground` | #141413 | #ecebe4 | text |
| `--card` / `--card-foreground` | #ffffff / #141413 | #30302e / #ecebe4 | cards, composer, inputs, dialogs |
| `--popover` / `--popover-foreground` | #ffffff / #141413 | #30302e / #ecebe4 | menus, palette, toasts (border + shadow) |
| `--primary` / `--primary-foreground` | #1f1e1d / #faf9f5 | #ecebe4 / #1f1e1d | one primary button, send, tooltip |
| `--secondary` / `--secondary-foreground` | #ebe9e0 / #141413 | #3a3936 / #ecebe4 | user bubble, secondary button |
| `--muted` / `--muted-foreground` | #f0eee6 / #64635d | #1f1e1d / #aeaca3 | code, tool output, skeleton / meta text, placeholder |
| `--accent` / `--accent-foreground` | #ebe9e0 / #141413 | #3f3e3a / #ecebe4 | hover and highlighted item (shadcn meaning) |
| `--destructive` / `--destructive-foreground` | #b42318 / #ffffff | #f28b82 / #1f1e1d | delete, error, recording |
| `--border` | #1f1e1d1f (12 %) | #ecebe41f (12 %) | dividers, card and input borders |
| `--input` | #8a8880 | #85837b | checkbox, radio, switch-off outline; hovered input border |
| `--ring` | #2563c9 | #7eaaf2 | focus ring |
| `--link` | #1d5bbf | #8fb6f5 | text links, "Näytä lisää" |
| `--sidebar` / `--sidebar-foreground` | #f3f1ea / #141413 | #1f1e1d / #ecebe4 | sidebar, drawer, rail |
| `--sidebar-accent` / `-accent-foreground` | #e8e6dd / #141413 | #302f2c / #ecebe4 | row hover, active row |
| `--sidebar-primary` / `-primary-foreground` | #1f1e1d / #faf9f5 | #ecebe4 / #1f1e1d | not used unless a filled sidebar button exists |
| `--sidebar-border` / `--sidebar-ring` | #1f1e1d1a / #2563c9 | #ecebe414 / #7eaaf2 | sidebar edge / focus |
| `--success` / `--success-subtle` | #26702b / #e6f2e3 | #86c98a / #24392a | done, diff added |
| `--warning` / `--warning-subtle` | #8a5300 / #fbefd9 | #e6b45e / #3d3220 | waiting, near cap, search match |
| `--warning-line` | #b7791f | #e6b45e | approval card outline |
| `--info` / `--info-subtle` | #1d5bbf / #e5eefb | #8fb6f5 / #22314a | running, notices, "Näytetään mitä malli näki" bar |
| `--destructive-subtle` | #fbe7e4 | #45282a | diff removed, inline error |
| `--mask` / `--mask-line` | #ece4fb / #7151c4 | #3e3557 / #b8a3f0 | masked-text highlight / dotted underline |

No chart tokens: the app has no charts. Contrast ratios (WCAG 2.x), light | dark:

| Pair | Ratio | Pair | Ratio |
|---|---|---|---|
| foreground on background | 17.5 / 12.7 | muted-fg on background | 5.7 / 6.7 |
| foreground on card | 18.4 / 11.1 | muted-fg on card | 6.0 / 5.8 |
| foreground on sidebar | 16.3 / 13.9 | muted-fg on sidebar | 5.3 / 7.3 |
| foreground on secondary | 15.2 / 9.7 | muted-fg on muted | 5.2 / 7.3 |
| foreground on accent | 15.2 / 9.0 | muted-fg on secondary | 5.0 / 5.1 |
| foreground on sidebar-accent | 14.7 / 11.2 | muted-fg on accent | 5.0 / 4.7 |
| foreground on mask | 15.0 / 9.5 | muted-fg on sidebar-accent | 4.8 / 5.9 |
| primary-fg on primary | 15.8 / 13.9 | destructive-fg on destructive | 6.6 / 7.0 |
| destructive on background | 6.2 / 6.3 | destructive on destructive-subtle | 5.5 / 5.5 |
| link on background | 6.0 / 7.3 | link on card | 6.4 / 6.4 |
| success on background | 5.8 / 7.8 | success on success-subtle | 5.3 / 6.3 |
| warning on background | 6.0 / 8.0 | warning on warning-subtle | 5.6 / 6.6 |
| info on info-subtle | 5.4 / 6.3 | foreground on success- / destructive-subtle | 16.0 / 10.4, 15.5 / 11.1 |
| ring on background (non-text) | 5.4 / 6.4 | input on card (non-text) | 3.6 / 3.5 |
| warning-line on card (non-text) | 3.6 / 7.0 | mask-line on background (non-text) | 5.4 / 6.9 |

Primary hover: light #3a3936, dark #d6d4cb (text stays ≥ 10:1). Destructive hover: light #9a1d14, dark #f4a19a (8.2:1 with its text). Disabled controls: opacity 0.5 (exempt from contrast). Meta text never drops below `--muted-foreground`.

Migration: `tokens.css` drops `--color-bg*`, `--color-fg*`, `--color-accent*`, `--color-user-bubble`; `@theme inline` maps every token above to `--color-<name>` (now including `--color-secondary`, `--color-accent`, `--color-destructive`, `--color-border`, sidebar and semantic tokens). Dark values stay in the existing `html[data-theme="dark"]` and `prefers-color-scheme` blocks.

Source: background, foreground, card, dark sidebar, border alpha, ink primary, "no pure black" and the blue-for-focus rule are research. Muted-foreground values are darkened from research to pass 4.5:1 on every surface. Ring, link, semantic, mask, accent and input values are chosen.

### 7.4 Spacing and shape

- **Spacing steps (px):** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. 2 px only inside badges and kbd. Turn gap 24; gap inside a turn 8; section gap on pages 32; label-to-control 8; page title to content 24.
- **Radius:** 4 checkbox and thumbnails inside chips; 8 buttons, inputs, selects, menu items, sidebar rows, tool output, attachment chips; 12 cards, code blocks, approval card, popovers, dropdowns, toasts, palette, artifact page; 16 user bubble, dialogs, sheets (inner edge); 24 composer; full for circular icon buttons (send, mic), badges, switches, status dots. Nested radius = outer radius − padding. Set the shadcn scale explicitly: `--radius-xs 4px`, `--radius-sm 8px`, `--radius-md 8px`, `--radius-lg 12px`, `--radius-xl 16px`, `--radius-2xl 24px`; Card uses `rounded-lg`.
- **Borders:** 1 px only, color `--border`. Cards, the composer, inputs and floating elements have a border; list rows, bubbles, tool output and code blocks do not. No double borders: an element inside a card uses a fill change, not a border.
- **Shadows (light):** `--shadow-sm: 0 1px 2px rgb(20 20 19 / 0.05)` only on the composer and the login card; `--shadow-md: 0 1px 3px rgb(20 20 19 / 0.06), 0 4px 16px rgb(20 20 19 / 0.08)` menus, popovers, toasts, palette; `--shadow-lg: 0 16px 48px rgb(20 20 19 / 0.16)` dialogs and sheets. **Dark:** no `--shadow-sm`; floating elements use `0 8px 32px rgb(0 0 0 / 0.45)`. Other resting elements have no shadow.
- **Z layers (Tailwind `@theme`):** header 20, sidebar 30, overlay and modal 40, dropdown and tooltip 50, toast 60.
- **Icons:** lucide-react, 16 px in controls and rows, 20 px in the top bar and rail, stroke 1.75 everywhere.
- **Measure:** `--thread-max: 42rem` (672 px) for thread, composer, search, topics, agents. `--page-max: 60rem` (960 px) for vault, automations, memory. Page title, content and the first table column share one left edge.

| | Phone 390 (<768) | 1024 (1024–1279) | 1440 (≥1280) |
|---|---|---|---|
| Sidebar | drawer, `min(85vw, 320px)` = 320 | docked 264 | docked 264 |
| Rail | none | 56 while a side panel is open or after the user collapses the sidebar (768–1023: rail 56 by default, sidebar opens as a 320 overlay) | 56 only after the user collapses the sidebar |
| Side panel (artifact) | full-screen Sheet | docked 440; thread area 528 | docked `clamp(440px, 40vw, 640px)` = 576; thread area 600 |
| Thread | full width, padding 16 | 672 centered in 760 | 672 centered in 1176 |
| Top bar | 48 + safe-area top | chat only (phase 16): 48, title `--text-ui` 500 truncated at left, chat cost in meta muted at right (tooltip: token parts, cache rate); none on other screens or in an empty chat (title as sr-only h1) | as 1024 |
| Composer | full width − 32, bottom gap 8 + safe-area | 672, bottom gap 16 | 672, bottom gap 16 |

Thread minimum width is 480; under that the side panel becomes a full-screen Sheet.

Source: spacing scale, radii 8/12/16/24, z layers, 42rem thread, 264 sidebar, 56 rail and phone padding 16 are research. Radius 4, shadows, icon stroke, `--page-max`, panel widths and drawer width are chosen.

### 7.5 Components

**Buttons (`Button`).** Sizes: `sm` 32 h, `default` 36 h, `lg` 44 h (phone primary, login), `icon` 36 (32 in message actions, 28 in rows). Under 768 every hit area is ≥ 44 × 44 (pad or extend with `::after`). `default` (ink) appears once per region; `outline` for secondary actions; `ghost` for toolbars; `destructive` only to confirm a delete; `link` for inline text actions. Hover: ghost and outline get `--accent`; default gets primary hover. Pressed toggles use `--accent` bg. Disabled: opacity 0.5, no hover. Every icon-only button has a Finnish `aria-label` and a `Tooltip` (desktop only).

**Inputs (`Input`, `Textarea`, `Select`).** 36 h desktop, 44 h phone, radius 8, bg `--card`, border `--border`; hover border `--input`; focus border `--ring` plus 1 px inner ring; invalid border `--destructive` with a 13/18 message and `AlertCircle` below. Booleans that apply at once use `Switch` (push toggle, "Näytä mitä malli näki", never-detect). Row selection in tables keeps `Checkbox`.

**Thread messages.** User: right-aligned bubble, max 80 % (85 % on phone), bg `--secondary`, radius 16, padding 10/16, `--text-body`. Assistant: no bubble, no avatar, `--text-prose`, full thread width. Under each turn an action row 32 h: user Kopioi, Muokkaa; assistant Kopioi, Yritä uudelleen, the eye toggle. With hover devices the row is opacity 0 until hover or `focus-within`, except under the latest assistant turn, where it always shows. On touch it shows under the latest user and the latest assistant turn only. Reserve the 32 px row while streaming so nothing jumps. Before the first token: three 6 px dots in `--muted-foreground`. While streaming: a caret block 0.5em × 1em in `--foreground` after the last character. Failed reply: inline alert in the turn (bg `--destructive-subtle`, `AlertCircle` in `--destructive`, text `--foreground`, `outline` button "Yritä uudelleen"). Masked text: bg `--mask`, 1 px dotted underline `--mask-line` offset 3 px, radius 4, padding 0 2 px, `box-decoration-break: clone`, focusable; `Tooltip` "Malli näki: …" on hover and focus, tap toggles it on touch. The "Näytetään mitä malli näki" bar sits 8 px above the composer: bg `--info-subtle`, `Eye` 16, 13/18 text, close button "Sulje". Jump to latest (phase 16): when the user scrolls up, auto-follow stops at once. When the user is > 80 px from the bottom, a pill shows 12 px above the composer, centered on the thread column: `outline` button, radius full, bg `--card`, text `--foreground`, `--shadow-sm` (dark: the floating shadow), 36 h (44 on phones), `ArrowDown` 16 and "Uusimpaan". When more than one new message arrived while the user was scrolled up, the pill adds "· 2 uutta" in `--muted-foreground`. A click on the pill, or `End` in the thread, scrolls to the bottom. The scroll is smooth, but it is a jump with reduced motion. Then auto-follow starts again. When the user scrolls back to the bottom, auto-follow also starts again and the pill goes away. A sent message or another chat also starts auto-follow again.

**Tool rows.** `Collapsible` trigger: 32 h (44 on touch), 16 px status icon (`Loader2` muted while running, `Check` `--success`, `X` `--destructive`, `Clock` `--warning`), tool name in mono 13, " · " and status word in `--text-meta` muted, chevron 16 that rotates 90°. Content: 8 px below, bg `--muted`, radius 8, padding 12, mono 13/20, max-height 320 then scroll (focusable region with `aria-label`). Consecutive tool rows stack with 4 px gap.

**Approval card (`Card`).** Inline in the thread, never a modal. Radius 12, bg `--card`, 1 px `--warning-line` border, padding 16. Header: `ShieldAlert` 16 in `--warning` + title in `--text-heading` ("Hyväksytäänkö työkalu `write`?"). Args: grid `max-content 1fr`, gap 4/12, keys mono 13 muted, values mono 13 foreground, clamp at 6 lines with a fade and a `link` "Näytä lisää". Footer: `Clock` + "Vanhenee klo 17.20" in meta at left; `outline` Hylkää and `default` Hyväksy at right, 36 h. Phone: buttons in one row below the meta line, 50 % each, 44 h, Hyväksy on the right. Do not move focus to the card (a typed Enter must never approve); announce it (7.8). After a decision the card collapses into its tool row with status Hyväksytty / Hylätty / Vanhentunut.

**Subagents row.** Same trigger as a tool row: spinner + "3 aliagenttia jonossa". Content box like tool output, one 32 px row per agent: status icon 16, name `--text-ui` 400, status `Badge` right (Jonossa secondary, Käynnissä info, Valmis success, Virhe destructive).

**Composer.** Card radius 24, bg `--card`, border `--border`, `--shadow-sm` in light, none in dark. Focus-within: border `--input`, no blue border. Rows: attachment chips (8 gap, padding 12 12 0), textarea (padding 12 16, min one line, grows to `min(40dvh, 320px)` then scrolls), toolbar 48 h (padding 6 8). Toolbar left: Liitä (`Paperclip`, ghost icon, circle) and the agent chip (ghost, 32 h, radius full, visible "Avustaja ▾", `aria-label` "Agentti: Avustaja"). Toolbar right: mic, then send. Send is a 36 px circle (44 on phone): disabled `--primary` at 0.5 when empty; `--primary` with `ArrowUp` when text or files exist ("Lähetä"); `Square` while streaming ("Pysäytä"). Attachment chip: 40 h, radius 8, border, thumb 32 radius 4, name 13/18 truncated at 160 px, remove button "Poista liite" 24 (44 on phone), upload `Progress` 2 px at the bottom edge, failed upload border `--destructive`. Drop anywhere on the thread shows a full-window overlay "Pudota tiedostot tähän" (bg `--background` at 90 %, dashed 2 px `--border` inset 16, radius 16).

**Mic states.** Idle: ghost circle, `Mic`. Hover: `--accent`. Recording (pointer held or Space held): circle bg `--destructive`, icon `--destructive-foreground`, a 2 px `--destructive` ring pulsing outward; the textarea row is replaced by an 8 px red dot, "Kuuntelee 0:07" (14/20, tabular) and a 64 × 4 `Progress` level meter; hint in meta: "Vapauta lähettääksesi · Esc peruu" (desktop) or "Vapauta lähettääksesi · liu'uta vasemmalle peruaksesi" (touch). Cancel armed (slid > 64 px left): circle `--muted`, hint "Vapauta peruaksesi". Transcribing: spinner + "Litteroidaan…", mic disabled. Permission denied: `MicOff`, tooltip "Mikrofoni on estetty". A short tap shows the tooltip "Pidä painettuna". No tooltip covers the textarea while recording.

**Sidebar.** bg `--sidebar`, right border `--sidebar-border`. Header 56: "Uusi keskustelu" ghost button (icon + label, 36 h) and icon buttons for shortcuts and collapse. Search field 36 h, radius 8, `aria-label` "Hae keskusteluja", `⌘K` kbd at the right (desktop). Group label: 12/16 500 muted, padding 16 12 4; collapsible topic groups add a 16 px chevron and a right-aligned count. Rows: 36 h (44 in the drawer), radius 8, padding 0 12, `--text-ui` 400, one line with ellipsis. Hover `--sidebar-accent`. Active: `--sidebar-accent` bg and weight 500 (no blue text). On hover or focus a 28 px ⋯ button replaces the row end; it opens a `DropdownMenu` (Kiinnitä, Nimeä uudelleen, Arkistoi, Poista). If an e2e flow clicks an inline row icon, that one icon stays inline. Footer 52: "Arkistoidut" row and the "Asetukset" icon button. Rail: 40 px icon buttons with 20 px icons, tooltips on the right.

**Drawer (`Sheet`, left).** Width 320, bg `--sidebar`, contents of the sidebar, safe-area padding top and bottom, close button "Sulje" 44. Scrim black 40 % (light) / 60 % (dark). Closes on scrim tap, Esc, swipe left, and row select.

**Settings (`Dialog`).** ≥768: width 560, max-height 85dvh, radius 16, padding 24, sticky header (title + close 32), body in `ScrollArea`. <768: full screen, radius 0, header 56, safe-area padding. Order: Teema (segmented control 36 h: track `--muted`, selected item `--card` + `--shadow-sm` + foreground, icon 16 + label), privacy switch, Hallinta group, Puhe, Ilmoitukset, Integraatiot, Avaimet. Section heading `--text-heading` with 24 gap above; setting rows min 48 h, label left (`--text-body`), control right (Select 160 wide), helper text in meta under the label, 1 px dividers between rows. Hallinta group: one bordered list, radius 12, rows 48 h with icon 16 muted, label, `ChevronRight` 16 muted, dividers; rows Nimisuoja, Muisti, Aiheet, Agentit, Automaatiot. Confirm (`AlertDialog`): width 420, title "Poistetaanko keskustelu ”Verot 2026”?", one line of body, Peruuta (`outline`, focused) and Poista (`destructive`) at right; phone: both 44 h, 50 % each.

**Tables (`Table`).** Vault and automations at ≥768. Header row 36 h, 13/18 500 muted, sticky, bottom border. Body rows 44 h, `--text-body`, divider `--border`, hover `--accent` at 50 %. Numbers right-aligned, tabular. Type and state cells use `Badge`. Row actions: at most two 28 px icon buttons visible on hover or focus, the rest in a ⋯ `DropdownMenu`; every action has a label. The bulk bar (merge) sits above the table: bg `--muted`, radius 12, padding 8 12, count in meta, Select, `default` button. Wider than the page: the table scrolls inside a focusable region, never the page. <768: each row is a `Card` (radius 12, padding 12 16): primary value `--text-body` 500, meta line below, checkbox left, ⋯ right.

**Memory screen.** `--page-max`. Header: title + `outline` "Tiivistä nyt" right. Two `Card` panes, side by side at ≥1280 (24 gap), stacked below. Pane header: "Käyttäjä (USER.md)" in `--text-heading` + counter in meta tabular; counter `--warning` at ≥ 90 % of the cap, `--destructive` over it. `Textarea` mono 14/22, min-height 240, resize vertical. Footer: `default` "Tallenna", disabled until changed; success gives a "Tallennettu" toast. Consolidation proposal: `Card` above the panes, title "Tiivistysehdotus", file label in micro muted, diff in mono 13/20: context lines plain, removed lines bg `--destructive-subtle` with "−" in `--destructive`, added lines bg `--success-subtle` with "+" in `--success`, no strike-through, sr-only "Poistettu" / "Lisätty" per line. Actions right: `ghost` Hylkää, `outline` Muokkaa, `default` Hyväksy; phone: three equal buttons, 44 h. While a proposal is open, the panes are read-only with bg `--muted` and an info alert "Ratkaise tiivistysehdotus ennen muokkausta." above them. Thread memory chip: 32 h row, `Brain` 16, "Muisti päivitetty" meta, `link` "Avaa muisti", added lines below in the diff style.

**Badges and chips.** `Badge`: 22 h, padding 0 8, radius full, `--text-micro`; variants secondary, outline, success, warning, info, destructive (subtle bg + strong text). Interactive chips (attachment, agent, memory) are buttons, not badges.

**Palette (`Command` in `Dialog`).** Width 560, top at 15vh, radius 12, `--shadow-md`. Input 48 h with `Search` 16. List max-height `min(60dvh, 420px)`, ends on a whole row (no half rows). Group heading micro muted; items 40 h (44 on phone), radius 8, icon 16 + label + right-aligned shortcut kbd. Footer 32 h (desktop): "↑↓ liiku · ↵ valitse · Esc sulje". Phone: inset 8 from the top and sides, list max-height 50dvh.

**Artifact panel.** Docked right per 7.4, left border `--border`, bg `--card`; <1024 a full-screen `Sheet`. Header 48: title `--text-ui` 600 truncated (not a pill), `Tabs` Esikatselu / Koodi, icon buttons Kopioi, Lataa, Avaa uudessa ikkunassa, Sulje (32, tooltips). Body: the sandbox iframe inset 12 with radius 12 and 1 px border; `title` attribute set. Artifacts follow the app theme (phase 19 decision, not a regression): a dark page in dark mode, the `--card` surface and the kit typography. In-thread code block: bg `--muted`, radius 12, header 36 with language (micro muted) and Kopioi / Avaa paneelissa, body padding 16, horizontal scroll.

**Toasts (`Sonner`).** Width 360 desktop, full width − 32 on phone; radius 12; bg `--popover`, border, `--shadow-md`; icon 16 in type color; title 14/20 500; description meta; optional `outline` sm action. Desktop bottom-right, 16 from edges. Phone bottom-center, above the composer + 8, or 16 + safe-area where no composer. Never at the top over the thread. 4 s default, 6 s with an action or for errors; errors show a close button.

**Empty states.** Centered in the content area, max width 360: optional icon 20 in a 40 px `--muted` circle, title `--text-heading`, one line meta (≤ 80 chars), at most one button with a label that no other element on the screen has. New chat: greeting "Mitä tänään tehdään?" in `--text-display`, composer centered at 40 % height, no extra buttons. Search with no hits: "Ei tuloksia haulle ”…”" + `outline` "Tyhjennä haku".

**Skeletons (`Skeleton`).** Only after 300 ms of loading, only for lists: sidebar (6 rows, bar 12 h at 60–85 % width), vault and automations (5 rows), topics, memory panes (one 240 h block). bg `--muted`, radius full for bars. Never in the thread.

**Other screens.** Login: phone without a card (padding 24, top at 20dvh); ≥768 a card 400 wide, padding 32, radius 16, border + `--shadow-sm`. App name in `--text-title`, input 44 h, `lg` "Kirjaudu" full width (disabled = primary at 0.5, not gray), `outline` "Käytä avainta" with `KeyRound`, error under the input in `--destructive` with `role="alert"`. Topics, agents, search results: list rows 56 h (title `--text-body` 500, meta line, right-aligned count `Badge` or chevron), dividers, no card per row; topic suggestions are `Card`s with ⋯. Search matches: `<mark>` bg `--warning-subtle`, foreground text, radius 2.

Source: bubble shape, flat assistant text, hover actions, tool and subagent rows, inline approval card, composer states, hold-to-record behavior, vault card fallback, toast placement and durations, the greeting and the skeleton scope are research. Heights, paddings, the memory pane layout, the no-focus-steal rule for approvals and the settings grouping are chosen.

### 7.6 Motion

| What | Duration | Easing |
|---|---|---|
| Drawer, side panel, sheet enter | 240 ms | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Same, exit | 200 ms | `cubic-bezier(0.4, 0, 1, 1)` (chosen) |
| Sidebar ↔ rail width | 200 ms | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Dialog, palette | 150 ms fade + scale 0.98 → 1 | `ease-out` |
| Dropdown, popover, tooltip | 120 ms fade + scale 0.97 → 1 from the trigger side (chosen) | `ease-out`; tooltip open delay 500 ms, close 0 |
| Collapsible (tool rows) | 150 ms height | `ease-out` (chosen) |
| Message appear | 150 ms opacity only, no slide | `ease-out` |
| Streaming caret | blink 1 s `steps(2)` | — |
| Hover color | 100 ms | `ease-out` |
| Recording ring | 1.2 s loop, scale 1 → 1.35, opacity 0.6 → 0 | `ease-out` (chosen) |
| Skeleton | 1.5 s opacity pulse | `ease-in-out` |

Not animated: per-token text, thread scroll during streaming (jump, not smooth), composer height growth, table and vault row changes, theme switch (disable transitions for one frame), route changes. Reduced motion (`prefers-reduced-motion: reduce`): every duration 0 except opacity fades ≤ 100 ms; spinners, caret, skeleton pulse and recording ring stop; the recording state shows a static red dot; status text carries the meaning.

Source: no motion value was verifiable in either app; unmarked values are the research recommendation, marked ones are chosen.

### 7.7 Mobile PWA

- Viewport: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`. Never `maximum-scale` or `user-scalable=no`.
- `theme-color`: `#faf9f5` with `media="(prefers-color-scheme: light)"`, `#262624` with `media="(prefers-color-scheme: dark)"`; when `data-theme` overrides the OS, JS sets both metas to the active value. `apple-mobile-web-app-status-bar-style: default` (verify on device).
- Safe areas: top bar `padding-top: env(safe-area-inset-top)`; composer wrapper `padding-bottom: max(env(safe-area-inset-bottom), 8px)`, 8 px while the keyboard is open; shell `padding-inline: env(safe-area-inset-left/right)`; drawer and full-screen dialogs pad both ends; toasts add the bottom inset.
- Height: shell `height: 100dvh`; `body { overscroll-behavior: none }`; thread `overscroll-behavior-y: contain`; `html { -webkit-tap-highlight-color: transparent }`; buttons `touch-action: manipulation`.
- Keyboard: listen to `visualViewport` resize and scroll; set `--kb` to the covered height and lift the composer by it; scroll the thread to the bottom on focus only if it was already at the bottom; no layout shift of the thread while the keyboard animates.
- Touch: long-press 500 ms on a message opens a bottom `Sheet` (Kopioi, Muokkaa, Yritä uudelleen); long-press on a sidebar row opens its ⋯ menu. Edge swipe (first 20 px) opens the drawer; swipe left closes it. No swipe-to-delete. `-webkit-touch-callout: none` on the mic and action buttons only, never on text.
- Targets: ≥ 44 × 44 for every control under 768 px, 8 px minimum between adjacent targets.
- Phone top bar (48 + inset, bg `--background`, bottom border `--border`): left "Valikko" (☰, 44), center the chat title or screen name (16/24 600, one line, ellipsis, it is the h1), right "Uusi keskustelu" (✎, 44).

Source: safe-area, theme-color pair, status-bar style, `dvh`, overscroll, long-press 500 ms and edge swipe are research recommendations (not observed in either app). `interactive-widget`, the 20 px swipe zone and the 8 px target spacing are chosen.

### 7.8 Accessibility

- Focus-visible: `outline: 2px solid var(--ring); outline-offset: 2px` on every control; text fields use border `--ring` + 1 px inner ring instead; the composer shows border `--input`. Never `outline: none` without a replacement.
- Landmarks: `nav` (sidebar, `aria-label` "Keskustelut"), `main`, top bar `header`. One h1 per screen (top bar title on phone, page title or sr-only chat title on desktop). Headings in order.
- Thread: a `section` with `aria-label` "Keskustelu"; each turn is an `article` with an sr-only h2 "Sinä sanoit" or "Avustaja sanoi". Do not virtualize the thread.
- Live regions (one polite, one assertive, both visually hidden): polite "Avustaja vastaa" at stream start and "Vastaus valmis" at the end (never per token); tool and subagent status changes ("Työkalu read valmis"); toasts. Assertive: "Hyväksyntä odottaa: write" and errors.
- Tool and subagent triggers are `button` with `aria-expanded` and `aria-controls`. Masked spans are focusable and expose the tooltip by `aria-describedby`. Scrollable regions (tool output, wide tables, code) are focusable with a label.
- Keyboard: Enter sends on keyboards and Ctrl/Cmd+Enter sends too (e2e uses it); Shift+Enter newline; on touch devices Enter inserts a newline and only the send button sends; Esc stops streaming, cancels recording, or closes the top overlay; Space held on the focused mic records; ↑ in an empty composer edits the last message; Cmd/Ctrl+K palette; Cmd/Ctrl+Shift+O new chat; Shift+Esc focuses the composer; Tab reaches every row action and approval button. The shortcuts dialog lists exactly the shipped set.
- Reduced motion per 7.6.
- axe: zero violations of any impact for `color-contrast`, `button-name`, `link-name`, `label`, `select-name`, `aria-allowed-attr`, `aria-valid-attr-value`, `aria-required-children`, `aria-required-parent`, `aria-hidden-focus`, `nested-interactive`, `scrollable-region-focusable`, `frame-title`, `image-alt`, `html-has-lang`, `html-lang-valid`, `meta-viewport`, `document-title`, `landmark-one-main`, `region`, `page-has-heading-one`, `heading-order`, `list`, `listitem`, `duplicate-id-aria`, `td-headers-attr`, `th-has-data-cells`.

### 7.9 Copy

- Tone: direct, calm, second person singular where a person is addressed; no exclamation marks; no "Virhe:" prefix.
- Buttons: imperative verb, 1–2 words, ≤ 16 characters (Tallenna, Lähetä, Yhdistä, Yritä uudelleen). Titles: noun phrases (Asetukset, Muisti). Status: passive participle (Tallennettu, Kopioitu). Confirmation titles: passive question with the object name in ”…”.
- Errors: what happened + what to do, ≤ 2 short sentences ("Mallin kutsu epäonnistui. Yritä uudelleen."). Toasts ≤ 60 characters. Empty-state line ≤ 80 characters.
- Sentence case; no period in buttons, labels, titles or menu items; full sentences end with a period.
- Formats: time "klo 17.20", date "25.10.2026", decimal comma, "42 %" with a space, "…" as one character, " – " en dash. Tool names, file names and agent ids stay as code in mono; all other UI text is Finnish.
- Keep these accessible names unchanged (e2e uses them), and never give a second element on the same screen one of them: "Uusi keskustelu", "Viesti", "Kirjaudu", "Salasana", "Asetukset", "Nimisuoja", "Aiheet", "Agentit", "Automaatiot", "Muisti", "Valikko", "Hae keskusteluja", "Hyväksy", "Hylkää", "Agentti: Avustaja", "Tutkija", "Toiminnot", "Lisää". The palette group stays "Komennot", so "Toiminnot" keeps one owner.

### 7.10 Review rubric notes

1. **Hierarchy.** (a) Each region shows at most one filled ink button; other actions are outline, ghost or link. (b) Page title 20/600, section heading 16/600, body 15/400, meta 13 muted are visibly different steps; assistant prose is serif and user text is sans. (c) Meta text (counters, timestamps, tool status) is muted, never foreground.
2. **Rhythm.** (a) Measured gaps come from the 7.4 scale; turn gap 24, in-turn gap 8, page sections 32. (b) Page title, content and the first table column share one left edge; thread and composer share one width (672). (c) No empty gap > 48 px between related blocks and no stray helper text far from its control.
3. **States.** (a) The composer shows the right state: disabled send when empty, ink send with text, Stop while streaming, red mic with timer while recording. (b) Empty states have title, one line and at most one action; lists load with skeletons; the thread loads with dots; errors are inline with "Yritä uudelleen". (c) Focus-visible is a 2 px blue ring; on touch screenshots the latest assistant actions are visible; tool, subagent and approval rows show distinct icons per status.
4. **Fit.** (a) At 390 no horizontal scroll, every target ≥ 44 px, titles end in ellipsis, tables are cards. (b) No overlay covers content it should not: tooltips never cover the textarea, toasts never cover messages or the composer, the palette list never ends mid-row. (c) At 1024 and 1440 with the side panel open the thread is ≥ 480 px wide; tables fit `--page-max` or scroll inside their own region.
5. **Parity.** (a) Light and dark have the same layout; dark surfaces step sidebar #1f1e1d < canvas #262624 < card #30302e, with no pure black. (b) The primary button is ink in light and cream in dark (never light blue); semantic tints switch to their dark values; text pairs meet the ratios in 7.3. (c) Dark text does not look heavier than light.
6. **Finish.** (a) Radii come only from 4 / 8 / 12 / 16 / 24 / full; cards 12, buttons 8, bubble 16, composer 24. (b) Icons are lucide, 16 or 20 px, stroke 1.75; every icon-only button has a label and a desktop tooltip; no row with more than two visible icon actions. (c) Copy is Finnish, sentence case, short, with Finnish number and time formats; no English UI words except identifiers.

### 7.11 Export

The user exports one chat to a file. The export has two forms. The masked form has the text that the model saw, with surrogates, so the user can share it. The open form has the real values from the vault, as the thread shows them.

- **Menu.** The chat row menu has the item "Vie…" (`FileDown` 16) after "Nimeä uudelleen". On desktop it is in "Lisää: …", in the drawer it is in "Toiminnot: …". While a chat is open, the palette has "Vie keskustelu…" in the group "Komennot". Each item opens the same dialog for its chat.
- **Dialog.** `Dialog` 420 wide, radius 16, padding 24, gap 24, no close icon (Peruuta and Esc close it). Title "Vie keskustelu" in `--text-title`. Under the title, the chat name in ”…” in `--text-ui` muted, one line with ellipsis.
- **Body.** Two setting rows as in Settings (7.5): min 48 h, label left in `--text-body`, control right, 1 px divider.
  1. "Muoto": `Select` 160 wide with the items "Markdown" and "JSON". Markdown is the default.
  2. "Näytä oikeat nimet": `Switch`, off each time the dialog opens. A meta line under the label tells what the file holds. Off: "Nimet niin kuin malli näki ne. Tiedoston voi jakaa." in `--muted-foreground`. On: `TriangleAlert` 16 and "Tiedostossa on henkilötietoja." in `--warning`. The two lines share one grid cell, so the row keeps its height and the layout does not move. The switch refers to the visible line with `aria-describedby`.
- **Footer.** `outline` Peruuta and `default` (ink) Lataa at the right, 36 h. Phone: the dialog has a 16 px inset. Peruuta is at the left and Lataa at the right, 50 % each and 44 h, as in the confirmation dialog (7.5).
- **States.** The dialog disables Lataa while the file loads. After the download the dialog closes. If the user closes the dialog first, the dialog stops the request and saves no file. An error shows a toast, and the dialog stays open:
  - Vault down or not configured: "Pseudonymisointipalvelu ei vastaa. Vie ilman oikeita nimiä."
  - More than 2000 messages: "Keskustelu on liian pitkä vietäväksi."
  - Other errors: "Vienti epäonnistui. Yritä uudelleen."
- **File name.** `<title-slug>-<yyyy-mm-dd>-<masked|avoin>.md|json`. The slug is lower case ASCII: ä, ö and å become a, o and a, and each run of other characters becomes `-`. The slug has at most 60 characters, and an empty slug becomes `keskustelu`. The masked file uses the masked title, the open file uses the real title, and an untitled chat uses its first user line. The date is the day the chat started, in Europe/Helsinki.
- **Route.** `GET /api/chats/:id/export?format=md|json&unmask=0|1`. The auth cookie is necessary (`requireUser`, as `/api/files/:id`). The chat of another user gives 404, a bad query gives 400, and a chat with more than 2000 messages gives 413 `too_large`. The response has `Content-Disposition: attachment; filename="…"`, `Cache-Control: no-store` and `text/markdown` or `application/json` with `charset=utf-8`.
- **Unmasking.** `unmask=1` uses the restorer of `history()`, the path that `chat.open` uses for the thread, with 8 sidecar calls at a time. If the sidecar fails or is not configured, the route gives 503 `pseudo_down`. `unmask=0` does not call the sidecar, so the masked export works while the sidecar is down.
- **Content.** The file starts with the title, the date and the agent, each on one line. The open form also has the topic. The masked form has no topic, because a topic name has no masked form. Then each message follows with its role and time as a `##` heading. Its text follows as a blockquote, so a heading in a message cannot look like a heading of the file. The file lists the attachments by name and does not embed them. It lists the tool calls with name and status word. Artifacts stay in the message text as fenced code blocks. The JSON form also lists them per message. The masked form has the masked title and the document names that the model saw. It has no image names, because the model never saw them. The JSON shape is `ChatExport` in `packages/protocol` with `version: 1`.

## 8. Status (2026-10-25)

Slices 0 to 4 passed the UI review. A fresh reviewer then scored all 196 screenshots. The round after that review fixed its findings and added 12 screenshots (`toast`, `settings-top` and `skeleton`). The `screens` project now has 192 tests and 208 screenshots.

### Component map as built

| Before | Now |
|---|---|
| Buttons, icon buttons | Kit `Button` with the variants default, outline, secondary, ghost, destructive and link. `IconButton` wraps it with a label and a desktop tooltip. |
| Inputs, textareas, selects | Kit `Input`, `Textarea` and `Select`. |
| Settings dialog, confirmation dialog | Kit `Dialog` and `AlertDialog`. `ConfirmDialog` wraps the alert dialog. |
| Mobile drawer, artifact sheet | Kit `Sheet`. The long-press action sheet on a message also uses it. |
| Sidebar row menus, agent picker | Kit `DropdownMenu`, not modal, so the page stays readable to screen readers. |
| Tooltips | Kit `Tooltip`, desktop only. |
| Vault, automations tables | Kit `Table`. Below 768 px each row is a card. |
| Topics list, agents list, search results | Rows of 56 px with dividers, as 7.5 says, not tables. |
| Topic chips, status pills | Kit `Badge` with the variants secondary, outline, success, warning, info and destructive. |
| Approval card, memory panes, integration row | Bordered sections with the card tokens. We did not use the kit `Card` and removed it. |
| Push toggle, model-saw toggle | Kit `Switch`. |
| Palette | `cmdk` directly inside the kit `Dialog`. The kit `Command` did not match the brief, so we removed it. |
| Toasts | Kit `Sonner`. |
| Loading states | Kit `Skeleton` through `ListSkeleton` and `useSlow` in `Page.tsx`. |
| Mic level | A 64 × 4 bar. The recorder writes its width every frame, so it does not use the kit `Progress`. We removed the kit `Progress`. |
| Long lists | Kit `ScrollArea` in the settings dialog. The other lists use the native scroll. |
| Dividers | Borders and `divide-y`. We removed the kit `Separator`. |
| Tabs in the artifact panel | Kit `Tabs` (Esikatselu, Koodi). |

### Dependencies

Every pin is at least 7 days old on 2026-10-25.

| Package | Version | Published | Use |
|---|---|---|---|
| class-variance-authority | 0.7.1 | 2024-11-26 | kit variants |
| cn | 0.5.0 | 2026-10-16 | class merge (the shadcn CLI 4.22 code imports it) |
| sonner | 2.0.8 | 2026-08-09 | toasts |
| @fontsource-variable/inter | 5.3.0 | 2026-07-19 | UI font |
| @fontsource-variable/source-serif-4 | 5.3.1 | 2026-10-11 | assistant prose |
| @fontsource-variable/jetbrains-mono | 5.3.0 | 2026-07-19 | code |
| tw-animate-css (dev) | 1.4.0 | 2025-09-24 | kit animations |
| @axe-core/playwright (e2e, dev) | 4.14.0 | 2026-10-15 | accessibility scan |

The shadcn CLI 4.22.0 generated the kit. It is not a dependency. We removed `@tanstack/react-virtual` and `clsx`. `cn` replaces `tailwind-merge` because the generated components import it.

### Size

The shell precache is 18 entries and 1376.42 KiB, under the 1.5 MB limit. The latin `wght` font files are 191 KB of it. The other font subsets load when a page needs them.

### Deviations from the brief

1. The table header is sticky only inside the table's own scroll container. The page scroll belongs to an outer element.
2. The agent picker shows the model and the subagent setting under each name. Agent profiles have no description field.
3. The name of the artifact close button is "Sulje artefaktit", not "Sulje". An e2e flow uses the name, and a second "Sulje" can be on the same screen.
4. The `[` key toggles the sidebar. An e2e flow uses it, and the shortcuts dialog lists it.
5. Mermaid artifacts use the light theme in both schemes, because the artifact keeps its own white page.
6. The axe scan ignores the `region` rule on the Radix popper wrapper only. Radix portals open menus and tooltips to `<body>`, outside every landmark.
7. The tool row of an expired approval shows `TimerOff` in the muted colour. The brief names only the waiting `Clock`.
8. Vault row selection uses a native checkbox. The kit has no `Checkbox`.
9. The settings dialog has a fixed height of 85dvh. The `ScrollArea` needs a fixed height to scroll.
10. When the side panel holds the sidebar at the rail (1024–1279 px), "Avaa sivupalkki" closes the panel. The thread then keeps its 480 px.
11. The composer does not scroll the thread on focus when the keyboard opens. The thread follows the bottom only while the user has not scrolled up.

### Test infrastructure

The 390 px screenshots emulate a phone with `hasTouch` and `isMobile`. They show the touch states: the actions of the latest turns without hover, the touch recording hint, and a tap that opens the masked-text hint. No hover state stays after a tap. The 1024 and 1440 px screenshots emulate a mouse.

The axe scan runs on every screenshot. A violation fails the test. The environment variable `AXE_STRICT=0` turns the failure into a printed warning.

The fake LLM has an optional `match` on a scripted turn. A call takes the first turn whose `match` fits its last user message, else the first turn without `match`. The `holdAfter` helper in `screens.spec.ts` now holds once. Before, a later frame after the release started a new hold, so `subagents-row` failed under load.

### Checks on a device

These checks need an iPhone with the PWA on the home screen:

1. The keyboard animation. The composer must stay above the keyboard (`--kb`), and the thread must not jump.
2. The status bar style `default` against both canvas colours.
3. The `theme-color` of the browser chrome in light, in dark and after a manual theme choice.
4. The safe areas in portrait and landscape.
5. The edge swipe that opens the drawer, and the long press on a message and on a sidebar row.

The new icons are a cream ring on ink in the brief's palette: 192, 512, maskable 512 and apple-touch-icon 180. A one-off Pillow script made them. The ring is 30 % of the side (20 % inside), and 24 % (16 %) on the maskable icon.
