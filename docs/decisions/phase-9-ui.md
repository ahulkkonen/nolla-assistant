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

Written by the reviewer in round 0 and pasted here by Fable.
