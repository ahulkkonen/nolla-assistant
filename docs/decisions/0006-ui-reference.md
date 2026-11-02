# Claude Web and ChatGPT: UI design reference for a Finnish single-user assistant PWA (October 2026)

> This is a research report from the planning stage.
> Where it differs from the brief in [phase-9-ui.md](phase-9-ui.md) section 7, the brief decides.

Base the thread, color and typography systems on Claude Web, and the composer, keyboard model and inline content blocks on ChatGPT. Most pixel values for both apps are not public, though. Only Claude's shipped color, font and weight tokens and a few ChatGPT width, size and theme tokens come from real CSS. Spacing, motion and iPhone keyboard behavior must be measured on devices before the reviewer treats them as targets.

## TL;DR
- Claude Web publishes a complete HSL token ladder in its production CSS (warm cream #faf9f5 canvas, near-black #141413 text, coral brand #d97757, blue focus ring #2c84db). It sets assistant replies in a serif ("Anthropic Serif") and user messages in a sans ("Anthropic Sans"), and it lowers font weights in dark mode. This is the most reusable, best-documented system of the two.
- ChatGPT has the better-documented composer and keyboard model: Enter/Shift+Enter, Shift+Esc to focus, Cmd/Ctrl+K search, Cmd/Ctrl+Shift+O new chat. It also has a four-state primary button (voice, send, stop, stop dictation) and inline writing and code blocks. OpenAI's May 28, 2026 model release note says "canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking." Its dark theme went to pure black (#000000) in May 2026; an OpenAI Community thread opened May 9, 2026 calls it "much darker and closer to pure black compared to the previous gray-toned dark mode," and OpenAI support replied "I can't share a timeline right now."
- For the Finnish app, use Claude's layered warm neutrals with a gray (not black) dark mode, a 40–48rem thread, and ChatGPT-style inline blocks for tool output and approvals. Add sr-only "Sinä sanoit" / "Avustaja sanoi" headings and live-region announcements. Both apps have publicly reported screen-reader defects on exactly these points.

## Summary
1. Source quality is uneven. Claude's production stylesheet (assets-proxy.anthropic.com) exposes real tokens. ChatGPT values come mostly from userscripts, a third-party page dump, open-source clones and OpenAI release notes.
2. Typography: Claude uses Anthropic Sans for UI and user text, Anthropic Serif for replies, and Anthropic Mono for code. ChatGPT uses OpenAI Sans; its exact CSS stack was not found.
3. Width: ChatGPT's thread column is `--thread-content-max-width: 40rem` (640px). Claude's main column used `max-w-3xl` (768px) in a userscript selector of unknown date.
4. Thread: both put the user's message in a right-aligned bubble and render assistant text flat, with no bubble and no avatar. Claude hides message actions until hover or focus; ChatGPT keeps the assistant action bar always visible.
5. Composer: ChatGPT is a pill of about 26–28px radius that caps at 25dvh on md+ screens. Claude is a flatter bordered card of about 16px radius (clone value), with the model picker beside the send button.
6. Artifacts and Canvas: Claude's artifacts still open in a side panel and are collected in an Artifacts sidebar tab. ChatGPT replaced Canvas with inline writing and code blocks (May 28, 2026) and added full-screen writing blocks (June 8, 2026).
7. Color: Claude's dark mode is warm charcoal (#262624 / #1f1e1d) with cream text (#faf9f5). ChatGPT's current dark mode is pure black (#000000) with #212121 cards.
8. Motion and mobile PWA details (durations, theme-color, haptics, long-press) are not publicly documented for either app; every value in those sections is a recommendation, not an observation.
9. Accessibility: University of Chicago Academic Technology Solutions (Sept 8, 2026) reports that with NVDA in Chrome, Claude Web "did not announce a response it had completed, nor was it possible to use the Keyboard Shortcuts dialog with a screen reader," and a GitHub issue reports unlabeled buttons. ChatGPT drops off-screen messages from the DOM (virtualization) and has misleading roles on reasoning and source controls.
10. Recommendation: copy Claude's token structure and restraint, ChatGPT's composer state machine and shortcuts, and fix both apps' screen-reader gaps from day one.

## Typography

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| UI font and fallback | `"Anthropic Sans", system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`, variable weight 300–800 | OpenAI Sans (bespoke typeface from OpenAI's February 2025 rebrand; Wallpaper*: "A new typeface, word mark, symbol and palette underpin all the ways in which OpenAI's technology interacts with the real world"). Exact 2026 CSS stack not found. An undated DevTools reading shows `ui-sans-serif, -apple-system, system-ui, Segoe UI, Helvetica, Apple Color Emoji, Arial, sans-serif` (pre-OpenAI Sans) | Claude: documented. ChatGPT: documented (brand), estimated (stack) |
| Assistant reply font | `--font-claude-response: var(--font-anthropic-serif)` = "Anthropic Serif", Georgia, "Times New Roman", Times, serif (plus CJK fallbacks). User messages use `--font-user-message: var(--font-ui)` (sans) | Same sans for user and assistant (no separate response font found) | Claude: documented. ChatGPT: estimated |
| Alternative fonts | `--font-system: system-ui` and `--font-dyslexia` (OpenDyslexic, 400/700) are shipped, which points to a user-selectable chat font | No user font choice found | Claude: documented (CSS). ChatGPT: estimated |
| Code font | `"Anthropic Mono", ui-monospace, monospace`; ligatures disabled (`font-variant-ligatures: none`, `"calt" 0, "liga" 0`); `code, pre` at `font-size: 1em` | Not found. Code-block text was 12.5px as of May 2026 (userscript author calls it "unreadable" and overrides to 14px) | Claude: documented. ChatGPT: documented (third party) |
| Base size / line height | Root `line-height: 1.5`. User message grid `text-[0.9375rem] leading-6` = 15px/24px (userscript selector, date unknown). The assistant-ui Claude clone uses `leading-[1.65rem]` for replies | Root font-size 16px (third-party claim). Message font-size and line-height not found in any primary source | Claude: documented (line-height), estimated (15/24). ChatGPT: estimated |
| Weights | Light mode: normal 430, medium 550, semibold 580, bold 600. Dark mode: normal 400, medium 510, semibold 540, bold 530; reply body 360, reply heading 530 | Not found | Claude: documented. ChatGPT: not found |
| Heading scale | Classes exist: `font-claude-response-title`, `-heading`, `-subheading`, `-small`, `font-display`, `font-xl`, `font-large`. Their sizes were not in the fetched CSS. Clone empty-state heading `text-3xl` (30px). The 64/48/36/28px Copernicus scale belongs to the marketing site, not the app | Clone empty-state heading 24px / weight 400 | Claude: documented (names), estimated (sizes). ChatGPT: estimated |
| Meta / timestamps | No persistent per-message timestamps in clones | No persistent timestamps; the reasoning row shows a duration, "Thought for [duration]" | Both: estimated; ChatGPT duration: documented |
| Max line length of assistant text | 768px column minus `px-4` padding gives about 736px of text. At about 0.5em average glyph width and 16–17px, that is roughly 85–90 characters | 640px column gives roughly 75–80 characters at 16px | Both: estimated (derived from documented widths, ±10 characters) |

Recommendation: use Inter or a similar variable sans for UI and user text and Source Serif 4 or Newsreader for assistant replies. Ship a "Fontti: Oletus / Järjestelmä / Lukihäiriöystävällinen" setting the way Claude does. Set body text at 16px/1.6 and code at 14px (not 12.5px), and keep the thread at 40–44rem so Finnish compound words wrap at about 70–80 characters. Add `lang="fi"` and `hyphens: auto` to message prose, because long Finnish compounds otherwise overflow narrow bubbles at 390px. Copy Claude's idea of a slightly lower weight in dark mode (for example 400 in light, 380 in dark on a variable font).

## Layout and spacing

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Thread max width | `max-w-3xl` = 48rem / 768px on the main column (userscript selector `div.relative.mx-auto.flex.h-full.w-full.max-w-3xl…`) | `--thread-content-max-width: 40rem` (640px) on message turns and on the composer container; older builds used `xl:max-w-[48rem]` | Claude: documented (third party, undated). ChatGPT: documented (third party, 2026) |
| Breakpoints | Tailwind container steps 640 / 768 / 1024 / 1280 / 1536px in shipped CSS | Container queries `@container (min-width: 768px)` and `(min-width: 850px)` on the thread; `md` = 768px | Both: documented |
| Spacing scale | Tailwind 4px-based steps visible in CSS: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48px, plus custom tokens `--p3…--p8`, `--g3…--g8`, `--h3…--h8`, `--chat-turn-gap`, `--chat-item-gap` (values not in the fetched portion) | Tailwind 4 variable syntax (`w-(--sidebar-width)`, `max-w-(--thread-content-max-width)`, `px-(--thread-content-margin)`); values not found | Claude: documented (steps), not found (token values). ChatGPT: documented (names) |
| Radius: user bubble | `rounded-xl` = 12px (userscript selector, undated); assistant-ui clone uses `rounded-2xl` = 16px | assistant-ui clone `rounded-[22px]`; a third-party theming PR read r=13px from computed styles. These conflict | Both: estimated |
| Radius: composer | Clone `rounded-2xl` = 16px, 1px border, no shadow | Shell `[data-composer-dark]` r=26px, or r=28px on `[data-composer-body]` depending on variant (computed styles, third party); clone `rounded-[28px]` | Claude: estimated. ChatGPT: measured (third party) |
| Radius: buttons / chips | Clone mode tabs `rounded-lg` = 8px | Composer controls are 36px circles; action-bar buttons 32px with 8px radius (clone) | Both: estimated |
| Radius: dialogs / cards | Not attributable (many radius classes in CSS) | Not found | Not found |
| Z-index layers | `z-header 20`, `z-sidebar 30`, `z-modal 40`, `z-dropdown/overlay/tooltip 50`, `z-toast 60` | Not found | Claude: documented |
| 390px | Sidebar becomes an off-canvas drawer; full-width thread with about 16px side padding; composer pinned to the bottom | Same pattern; mobile-web sidebar action fixes shipped Feb 27, 2026 | Estimated (ChatGPT fix: documented) |
| 1024px | Sidebar docked or collapsible; an open artifact panel squeezes the thread | Sidebar can stay pinned beside an active panel "if enough space is available" (Nov 22, 2024 note); otherwise it floats | Claude: estimated. ChatGPT: documented (2024) |
| 1440px | Docked sidebar plus centered 768px column, or chat plus artifact side by side | Docked 260px sidebar plus centered 640px column | Estimated |

Recommendation: define one `--thread-max: 42rem` token and three layouts. At 390px, use a drawer, `px-4`, and a sticky composer. At 1024px, collapse the sidebar to a rail when a side panel opens. At 1440px, dock a 260px sidebar plus the thread, with an optional 45% panel. Use the 4px Tailwind scale and only these radii: 8px (buttons, chips, table cells), 12px (cards, code blocks, the tool-approval card), 16px (user bubble), 24px (composer), 16px (dialogs). Adopt Claude's named z-index layers as Tailwind 4 `@theme` tokens.

## Thread

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| User vs assistant | User: right-aligned bubble with a subtle gradient `from-bg-300 to-bg-400` (userscript selector); clone uses #E5E0D6 light / #393937 dark at max 80% width. Assistant: flat serif prose, no bubble, no avatar | User: right-aligned bubble, `--color-background-user-message` rgb(233 233 233 / 50%) light and rgb(50 50 50 / 85%) dark (page dump). Assistant: flat, no bubble. The clone's black #0d0d0d bubble with white text contradicts the dump | Claude: documented (third party) / estimated. ChatGPT: documented (third party dump) |
| Vertical gap | `--chat-turn-gap` (between turns) and `--chat-item-gap` (inside a turn) tokens exist; values not found | Not found | Claude: documented (names) |
| Code blocks | highlight.js "atom one dark"-style theme in CSS: background #282c34, text #abb2bf, keywords #c678dd, strings #98c379; `pre code` padding 1em | Language label, Copy, edit on supported blocks, full screen, Code/Preview switch (help-center summary); sticky header bar excluded from copy (`data-markdown-copy="exclude"`); interactive split-screen review since Feb 19, 2026 | Claude: documented. ChatGPT: documented |
| Tables / lists | Not found beyond prose defaults | Tables rendered in prose; a userscript adds table margins (defaults judged too tight); writing blocks expose stray "⋮⋮" table handles to screen readers | ChatGPT: documented (third party) |
| Streaming cue | Animated orange spark at the end of the streaming answer | Older builds animated dots in the send button; the stop button replaces send while running | Claude: estimated. ChatGPT: documented (older study) |
| Thinking / tool rows | Collapsed "thinking" row with a summary line that expands to the full reasoning | Collapsible button "Thought for [duration]" after reasoning; the current activity line during reasoning; GPT-6 adds intermediate commentary turns; Python analysis cards stay separate | Claude: estimated. ChatGPT: documented |
| Hover actions | User: Edit, Copy. Assistant: Copy, Good, Bad, Retry. Hidden until hover or `focus-within` (opacity transition) | Assistant bar always visible: Copy, Good, Bad, Read aloud, Share, Regenerate, More. User: Copy and Edit below the bubble on hover. Controls 32px | Both: estimated (clones) |
| Edit and retry | ↑ in an empty composer edits the last message; edits create versions with "‹ 1/2 ›" arrows | ↑ edits the last prompt; edits and regenerations create branches with arrows | Estimated (third-party lists) |
| Scroll-to-bottom | Round button that fades in when not at the bottom | Round "Scroll to bottom" button above the composer | Estimated |
| Screen-reader headings | No turn headings reported | Visible-to-AT headings "You said" / "ChatGPT said" per turn | ChatGPT: documented |

Recommendation: use the user bubble at 16px radius, max 80% width, and `bg-secondary` (warm gray), and keep assistant text flat. Hide actions until hover or focus on desktop, and always show them under the latest assistant message on touch. Actions: Kopioi, Muokkaa, Yritä uudelleen, Hyvä/Huono, and a More menu. Render tool calls as collapsed rows reading "Haettiin muistista · 3 tulosta ›" and reasoning as "Mietti 12 s ›". Put the **approval card** inline in the thread as a 12px-radius bordered card with tool name, arguments in mono, and Hyväksy (primary) / Hylkää (secondary) buttons; never use a modal. Render the **subagents status row** as one collapsed line ("2 aliagenttia käynnissä · 1 valmis ›") that expands into per-agent rows. Use 24px between turns and 8px inside a turn.

## Composer

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Shape and resting height | Two-row card: text row, then a toolbar row. Clone padding `px-3.5 pt-3 pb-2.5`; exact height not found | Single-row pill when one line; once text wraps it becomes two rows (text full width, buttons below) | Both: estimated |
| Max height | Not found | `max-h-[25dvh]` on md+ screens (userscript override target) | ChatGPT: documented (third party) |
| Control placement | Attach (+) at left; model picker plus send at right | + at left; dictate mic and voice-mode button at right; model selection lives in the composer (release notes, 2026) | Claude: estimated. ChatGPT: documented / estimated |
| Send states | Coral #c96442 send (clone) when text is present; stop while streaming | Four states in priority order: Stop (running), Stop dictation (recording), Send (text present), Dictate plus Voice (empty); send/voice button #0d0d0d light, #ffffff dark | Claude: estimated. ChatGPT: estimated (clone) |
| Keyboard | Enter send, Shift+Enter newline. Third-party lists conflict: Cmd/Ctrl+K is "new chat" in some and "search" in others; Cmd/Ctrl+/ is "toggle sidebar" or "show shortcuts"; Cmd+. stop; Cmd+Shift+L theme; Cmd+U upload | Enter, Shift+Enter, Shift+Esc focus input, Cmd/Ctrl+Shift+O new chat, Cmd/Ctrl+K search (Help Center), Cmd/Ctrl+Shift+; copy last code block (Help Center), Cmd/Ctrl+Shift+C copy last reply, Cmd/Ctrl+Shift+S sidebar, Cmd/Ctrl+/ shortcut list, ↑ edit last | Claude: estimated (conflicting). ChatGPT: documented (partly) |
| iPhone keyboard | Not documented; CSS uses `dvh`/`svh` units (`h-[calc(100dvh-12rem)]`, `min-h-[calc(100svh-184px)]`) | Not documented; uses `25dvh` | Both: documented (units only) |
| Drag-drop / paste | Supported (Cmd+U upload per third party) | Supported; "Add photos & files" button | Estimated |
| Attachment chips | File cards above the text row | Thumbnails or chips above the text inside the pill | Estimated |

Recommendation: use a 24px-radius card, minimum one text row (about 56px resting with padding), growing to `min(40dvh, 320px)` and then scrolling. Toolbar left: Liitä (+), agent picker chip ("Agentti: Yleinen ▾"). Toolbar right: the **hold-to-record mic**, then Send. Use ChatGPT's state machine: empty shows the mic; text shows Send; streaming shows Stop; recording shows a red pulse, elapsed time, and "Vapauta lähettääksesi · liu'uta peruuttaaksesi". Shortcuts: Enter, Shift+Enter, Esc to stop, ↑ to edit, Cmd/Ctrl+K for the **command palette**, Cmd/Ctrl+Shift+O for a new chat. On iPhone, size the app shell with `100dvh` and listen to `visualViewport` resize to keep the composer above the keyboard. Accept drops on the whole thread, with a full-window "Pudota tiedostot tähän" overlay.

## Sidebar and navigation

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Desktop width | About 280px according to a third-party article; not confirmed in CSS | 260px (indirect: older userscripts matched `width: 260px`; third-party "official 260px"); set through inline `--sidebar-width` on `#stage-slideover-sidebar`; resizable only by userscript | Claude: estimated. ChatGPT: documented (indirect) |
| Collapsed state | Icon rail | Rail on larger viewports (settings icon added when the sidebar is closed, Nov 2024); rail width not found | Both: estimated |
| Row height | Not found | Not found | Not found |
| Grouping | Starred/pinned, Recents, Projects, Artifacts tab. Desktop app: Pinned shows the first 20 with "Show more", "Group by" menu, "Group and sort" on group-heading hover; a "New" button starts a chat or a task | Pinned (easier pinning, June 18, 2026), Projects, recent chats limited with an infinite-scroll flyout (Nov 2024), "Organize sidebar → Show → Projects" (desktop 26.924, Sept 2026) | Claude: documented (desktop) / estimated (web). ChatGPT: documented |
| Row hover menu | "⋯" menu: star, rename, add to project, delete | "⋯" menu; desktop shortcuts for archive (⌘⇧A), mark unread (⌘⇧U), pin (⌘⌥P), rename (⌘⌥R) | Claude: estimated. ChatGPT: documented (desktop app) |
| Search | Conversation search (shortcut disputed) | Cmd/Ctrl+K dialog across chats, projects, images and documents; filters by content type (July 14, 2026) | Claude: estimated. ChatGPT: documented |
| New chat entry | Top of the sidebar | Top of the sidebar; Cmd/Ctrl+Shift+O | Documented / estimated |
| Mobile drawer | Off-canvas drawer with a scrim | Slide-over drawer; mobile apps moved Images, Codex, Pulse and Apps into a horizontal bar above chats (Mar 26, 2026) | Claude: estimated. ChatGPT: documented (apps) |
| Phone top bar | Menu, chat title, new chat | Menu, model or title, new chat | Estimated |

Recommendation: use a 264px sidebar, a 56px rail, and 36px rows (44px on touch). Order: Uusi keskustelu, Haku (Cmd/Ctrl+K opens the **command palette**, which doubles as search), then nav rows for **Aiheet** (topics screen), **Muisti** (memory editor), **Holvi** (pseudonymization vault), Asetukset, and finally chats grouped as Kiinnitetyt, Tänään, Eilen, Edelliset 7 päivää, Vanhemmat. The row hover "⋯" menu holds Kiinnitä, Nimeä uudelleen, Arkistoi, Poista. On the phone, use an 85%-width drawer with a 40% black scrim, edge-swipe to open, tap the scrim to close, and a top bar showing ☰, the chat title (truncated), and a new-chat icon.

## Artifacts and Canvas

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Current status | Artifacts: "opens beside your conversation"; everything is saved to an "Artifacts" sidebar tab with templates | Canvas removed from GPT-5.5 Instant/Thinking on May 28, 2026 and replaced by inline writing blocks and code blocks; legacy models keep it for a limited time | Both: documented |
| How it opens | Opens automatically for substantial, self-contained output (Claude Help Center: "significant and self-contained, typically over 15 lines") or on request | Writing blocks render inline; longer writing can open a focused full-screen editor (June 8, 2026); code blocks can show a split-screen review (Feb 19, 2026) | Claude: documented / estimated. ChatGPT: documented |
| Width at 1024 / 1440 | Not documented; side-by-side split with the chat column narrowing | Not applicable (inline or full screen) | Claude: estimated |
| Tabs | Preview / Code toggle (secondary source) | Code / Preview switch on supported code blocks | Documented (secondary) |
| Phone | iOS and Android apps: view and edit in the Artifacts tab; sharing settings only on web or desktop | Full-screen block editor | Claude: documented. ChatGPT: estimated |
| Actions | Edit, share by link (Publish and copy link), download, version history | Copy, edit, full screen, preview; writing blocks save to the Library and download (June 2026); undo/redo replaces Canvas's version arrows | Claude: documented / estimated. ChatGPT: documented (secondary) |

Recommendation: don't build a generic artifact panel. Show long results as inline 12px-radius blocks with Kopioi, Lataa and Avaa koko näytölle. Use the side-panel pattern only for the **memory editor**: at 1440px a two-pane 50/50 split (left "Nykyinen", right "Ehdotettu muutos", or source and preview) with a 1px divider. At 1024px, use tabs instead of two panes. At 390px, use a full-screen sheet with a segmented control switching panes. Keep version arrows ("‹ 2/3 ›") on the memory editor, because a single-user assistant edits the same memory repeatedly.

## Dialogs and settings

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Settings structure | Full settings page with left-side sections (Profile, Appearance, and others); chat font options appear in CSS | Modal dialog with left tabs (General, Notifications, Personalization, …); Settings > Appearance > Background with a custom hex value, for example #212121 (per a marketing page, Oct 2026) | Claude: estimated. ChatGPT: documented (third party) / estimated |
| Toggles / selects | Switches and Radix dropdowns (`--radix-dropdown-menu-content-available-height` capped at 24rem) | Switches; dropdown selects | Claude: documented (Radix). ChatGPT: estimated |
| Destructive confirmation | Confirmation dialog before deleting a chat | Confirmation dialog; Cmd/Ctrl+Shift+Backspace delete shortcut opens it | Estimated |
| Memory settings | Not found | Personalization > Memory modal (a userscript fixes its height) | ChatGPT: documented (third party) |

Recommendation: use a settings page, not a modal. A single user benefits from deep links (`/asetukset/muisti`). Left sections at 1024+ px, a stacked list at 390px. Use shadcn Switch for booleans and Select for enums; save immediately and show a quiet "Tallennettu" toast. For destructive actions (delete chat, clear the vault, delete a memory), use an AlertDialog with the object name in the title ("Poistetaanko keskustelu ”Verot 2026”?"), a red "Poista" on the right and "Peruuta" focused by default. Vault deletion should also require typing the vault name.

## Feedback

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Toasts | Toast layer at z-index 60; position and duration not found | Copy shows no reliable spoken confirmation (JAWS); a native "link copied" message exists for share | Claude: documented (layer). ChatGPT: documented (a11y report) |
| Inline errors | Retry message inside the failed reply | Error inside the turn with a retry button | Estimated |
| Loading skeletons | Not found | Not found | Not found |
| Empty state | Centered greeting with a coral spark and composer in the middle (clone text: "How can I help you today?"); starter chips below | Centered heading and composer above center (clone: "Where should we begin?") | Estimated (clones) |
| Offline / reconnect | Not found | Not found | Not found |

Recommendation: put Sonner toasts at bottom-center on the phone (above the composer, respecting the safe area) and bottom-right on desktop, 4 seconds by default and 6 seconds for anything with an action ("Kopioitu", "Muisti päivitetty · Kumoa"). Mirror every toast in a polite live region. Empty state: one line, "Mitä tänään tehdään?", the composer, and at most three starter chips; no second CTA. Show a thin top banner "Ei yhteyttä – viestit lähetetään, kun yhteys palaa" when `navigator.onLine` is false, and queue sends. Use skeletons only for the topics screen and the vault table, never for the thread.

## Color

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Light background layers | bg-000 #ffffff, bg-100 #faf9f5 (canvas), bg-200 #f5f4ed, bg-300 #f0eee6, bg-400 #e8e6dc (HSL tokens converted to hex) | Surface #fcfcfc, elevated #ffffff, elevated-secondary #f3f3f3 (`--app-color-*` page dump) | Both: documented (Claude converted, ±1 per channel) |
| Dark background layers | bg-000 #30302e, bg-100 #262624, bg-200 #1f1e1d, bg-300 #141413, bg-400/500 #000000 | Surface and panel #000000 (OLED); elevated #1b1b1b; elevated-secondary #303030; card #212121. The pre-May-2026 gray theme: main #212121, secondary #303030 (userstyle "restore" values) | Both: documented (ChatGPT third party) |
| Text levels | Light: #141413 / #3d3d3a / #73726c. Dark: #faf9f5 / #c2c0b6 / #9c9a92 | Light: #0d0d0d / #5d5d5d / #8f8f8f. Dark: #ededed / #cdcdcd / #afafaf (old gray theme: #ececec / #b4b4b4 / #8f8f8f) | Both: documented |
| Borders | One hue per mode (light #1f1e1d, dark #dedcd1) in all four border tokens, so levels presumably come from alpha | Light #0000001a / light #0000000d / heavy #00000026. Dark #ffffff26 / #ffffff0d / #ffffff33 | Claude: documented (alpha use estimated). ChatGPT: documented |
| Accent | Brand coral #d97757 (`--accent-brand`), brand-000 #c6613f; clone send button #c96442; interactive blue #1b67b2 / #2c84db light, #74abe2 dark | Accent blue #3a83f7; primary buttons monochrome (#0d0d0d light, #ffffff dark) | Both: documented (clone values estimated) |
| Semantic | Danger #b53333 light / #dd5353 and #fe8181 dark; success about #2f7613 light; warning about #875a08 light | Not found | Claude: documented |
| Dark vs light structure | Not inverted. The layer order flips (dark gets lighter as it rises: #141413 → #1f1e1d → #262624 → #30302e), text stays warm cream, accents get lighter (blue #2c84db → #74abe2), and font weights drop 20–70 units | Pure black base since about May 2026 (`html[data-oled]`), with elevation shown by lighter cards (#1b1b1b, #212121, #303030); users asked for the gray back; a userscript calls #000 "eye-bleeding" | Both: documented |
| Contrast approach | Low-chroma warm neutrals, accents used sparingly; focus ring in blue `hsl(var(--accent-100))` | High contrast monochrome; white text on black reported as tiring | Documented / documented (user reports) |

Recommendation: adopt Claude's token structure as shadcn CSS variables in `@theme`. Light: `--background #faf9f5`, `--card #ffffff`, `--muted #f0eee6`, `--foreground #141413`, `--muted-foreground #73726c`, `--border rgb(31 30 29 / 0.12)`. Dark: `--background #262624`, `--card #30302e`, `--sidebar #1f1e1d`, `--foreground #faf9f5`, `--muted-foreground #9c9a92`, `--border rgb(222 220 209 / 0.12)`. Use one brand accent for primary actions only and a separate blue for focus and links. Do not use pure black. Check every text pair against WCAG AA 4.5:1; #73726c on #faf9f5 needs checking for meta text at 13px.

## Motion

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Panel open (sidebar, artifact) | Not found | Not found; secondary guides mention "smooth transitions" without values | Not found |
| Message appear | Streaming words fade in; the composer glides from center to bottom on the first message (described by a clone issue as the target behavior) | Not found | Estimated |
| Hover | Action bars transition opacity on hover/focus (clone) | Background-only hover on icon buttons; black at 7% light, white at 15% dark (clone) | Estimated |
| Not animated | Not found | Not found | Not found |
| Reduced motion | Not found | Not found | Not found |

Recommendation (no app values were verifiable): sidebar and drawer 200ms `cubic-bezier(0.32, 0.72, 0, 1)`; side panel 240ms with the same curve; dialogs 150ms fade plus 0.98→1 scale; hover 100ms color only; new messages 150ms opacity with no slide; streaming text not animated per token. Do not animate the thread scroll position during streaming, and do not animate table or vault row reorders. Under `prefers-reduced-motion: reduce`, set all durations to 0 except opacity fades of 100ms or less, and stop the recording pulse in favor of a static red dot.

## Mobile PWA

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Safe area | Not documented | Not documented | Not found |
| Viewport units | `dvh` and `svh` used in layout heights | `dvh` used for the composer cap | Documented |
| Status bar / theme-color | Not found | Not found (the only hit was the unrelated LibreChat clone: theme-color #171717, `black-translucent`) | Not found |
| Tap highlight | `-webkit-tap-highlight-color: transparent` on `html` | Not found | Claude: documented |
| Pull-to-refresh | Not found | Not found | Not found |
| Haptics | Not found | Not found | Not found |
| Long-press on messages | Not found for web | Not found for web; mobile-web sidebar actions "no longer stick while scrolling" (Feb 27, 2026) | ChatGPT: documented (related fix) |

Recommendation: use `viewport-fit=cover`; pad the top bar with `env(safe-area-inset-top)` and the composer with `max(env(safe-area-inset-bottom), 8px)`. Set `apple-mobile-web-app-status-bar-style: default` and two `theme-color` metas (`#faf9f5` light, `#262624` dark, with `media="(prefers-color-scheme: …)"`). Turn off pull-to-refresh with `overscroll-behavior-y: contain` on the thread. iOS Safari has no Vibration API, so don't rely on haptics for the hold-to-record mic; use a visible pulse and a timer. Long-press on a message (500ms) opens a bottom sheet with Kopioi / Muokkaa / Yritä uudelleen / Valitse teksti, and `-webkit-touch-callout: none` applies only to the action buttons, not the text.

## Accessibility

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| Focus-visible | Tailwind ring in blue `hsl(var(--accent-100))` (#2c84db) | Not found | Claude: documented |
| Thread keyboard navigation | No turn headings; completed responses are not announced (NVDA/Chrome, University of Chicago, Sept 2026) | Turn headings "You said"/"ChatGPT said"; but virtualization removes far-off messages from the DOM, breaking arrow-key reading and selection (JAWS, Oct 2026) | Documented |
| Sidebar / menus | The settings-menu button needs NVDA Focus Mode on Firefox; unlabeled buttons; blank focusable elements (WCAG 2.1.1, 4.1.2) | Older reports: most buttons unlabeled; history hard to reach by Tab | Documented (GitHub issues, community) |
| Shortcuts dialog | Opening is not announced, focus is not moved, content cannot be reached with the virtual cursor (PageLive analysis on dev.to, March 3, 2026, rated "Blocker": "the screen reader does not announce that a dialog has appeared, and focus is not moved into the dialog") | Cmd/Ctrl+/ list exists; a11y not assessed | Claude: documented |
| Reasoning / sources | Not reported | "Thought for…" announced twice; collapsed/expanded state unclear; web references announced as "menu button … dialog" instead of link; favicon URLs read aloud | ChatGPT: documented |
| Reduced motion | Not found | Not found | Not found |
| Other | Dyslexia-friendly font (OpenDyslexic) shipped | A redesign observed on 25 September 2026 at 23:16 Brussels time introduced regressions (openai/codex issue #52598, JAWS dossier) | Documented |

Recommendation: give every turn an sr-only `h2` ("Sinä sanoit" / "Avustaja sanoi") and wrap the thread in `role="log"`. Announce "Vastaus valmis" through a polite live region when streaming ends. Don't virtualize the thread for one user; if you must, keep the text in the DOM. Use a 2px focus ring with 2px offset in the blue accent on every control. Give every icon button a Finnish `aria-label` and a tooltip. Tool and reasoning rows are `button` with `aria-expanded` plus "Näytä vaiheet" in the label. Source chips are real `<a>` links with empty-alt favicons. The vault table needs a `<table>` with `scope` headers and row actions reachable by Tab.

## Comparison and recommendation

| Item | Claude Web | ChatGPT | Confidence |
|---|---|---|---|
| 1 Typography | Better | — | Documented |
| 2 Layout and spacing | Better (tokens, layers) | Narrower measure | Mixed |
| 3 Thread | Better restraint | Better turn semantics | Mixed |
| 4 Composer | — | Better | Estimated |
| 5 Sidebar | — | Better | Documented |
| 6 Artifacts/Canvas | Better for panels | Better for inline | Documented |
| 7 Dialogs/settings | Tie | Tie | Estimated |
| 8 Feedback | Tie | Tie | Estimated |
| 9 Color | Better | — | Documented |
| 10 Motion | Unknown | Unknown | Not found |
| 11 Mobile PWA | Slightly better | — | Documented (thin) |
| 12 Accessibility | — | Slightly better | Documented |

1. **Typography: Claude.** Its serif-for-replies, sans-for-user split tells the speakers apart without bubbles or avatars, and it ships a dyslexia font and dark-mode weight compensation. ChatGPT's 12.5px code text is a reported regression.
2. **Layout: Claude for the system, ChatGPT for the measure.** Claude exposes named z-index layers and spacing tokens. ChatGPT's 40rem column reads more comfortably than 48rem.
3. **Thread: split.** Claude's hover-only actions keep long answers calm. ChatGPT's per-turn headings and visible actions on the latest reply are more discoverable and more accessible.
4. **Composer: ChatGPT.** The four-state primary button and a documented shortcut set make voice, send and stop unambiguous. Claude's shortcut documentation is contradictory.
5. **Sidebar: ChatGPT.** Pinning, filtered search and "Organize sidebar" are documented and recent. Claude's web sidebar organization is mostly undocumented outside the desktop app.
6. **Artifacts/Canvas: depends on the task.** Claude's side panel suits documents you keep. ChatGPT's inline blocks keep short outputs in the conversation and work better on a phone.
7. **Dialogs/settings: tie.** Both use standard Radix-style switches and confirmation dialogs; neither has published distinctive patterns.
8. **Feedback: tie.** Neither documents toasts, offline handling or skeletons. ChatGPT's copy action lacks a spoken confirmation.
9. **Color: Claude.** It has a complete, warm, layered token ladder and a structurally reworked dark mode. ChatGPT's pure-black dark mode drew sustained complaints.
10. **Motion: no verdict.** No durations or easings were verifiable for either app.
11. **Mobile PWA: Claude, slightly.** It uses `dvh`/`svh` and removes tap highlights. Neither app documents safe-area or theme-color behavior.
12. **Accessibility: ChatGPT, slightly.** It has turn headings, but virtualization and control roles break screen-reader reading. Claude lacks completion announcements and an accessible shortcuts dialog.

Recommendation for the extra surfaces:
- **Pseudonymization vault table (Holvi):** use a shadcn Table with columns Tunniste (mono), Alkuperäinen (masked by default, eye toggle), Tyyppi (badge), Käytetty (relative date) and a "⋯" menu. Rows are 40px, the header is sticky, search sits on top, and below 640px the table becomes stacked cards.
- **Topics screen (Aiheet):** a card grid (12px radius, two columns at 1024px, one at 390px) with title, last activity and a count. One empty-state action: "Luo aihe".
- **Memory editor:** two panes as described under Artifacts and Canvas, with a diff highlight and explicit "Tallenna" / "Hylkää muutokset".
- **Agent picker:** a composer chip that opens a popover list with name, one-line description and a check mark. It is also reachable from the command palette ("Vaihda agentti").
- **Approval card:** inline in the thread, with an amber left border, the tool name, mono-formatted arguments, Hyväksy and Hylkää buttons, and an "Hyväksy aina tälle työkalulle" checkbox. Focus moves to it, and it is announced assertively.
- **Subagents status row:** one collapsed row with a spinner and a count, expanding into per-agent rows with status (Käynnissä / Valmis / Virhe).
- **Command palette:** shadcn Command on Cmd/Ctrl+K, grouped into Toiminnot, Keskustelut, Aiheet and Asetukset, with fuzzy matching that tolerates Finnish inflection (match on stems).
- **Hold-to-record mic:** a 44px target; press and hold to record, release to send, slide left to cancel, with a visible timer. A tap alone shows a "Pidä painettuna" tooltip. Space bar is the desktop equivalent.

## Sources
All sources accessed October 25, 2026.
- Claude.ai production stylesheet: https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c6a992d55-CGuUmOei.css
- Anthropic.com font CSS (Copernicus, Styrene B): https://www.anthropic.com/_next/static/chunks/ec368b341879b233.css
- Dear Designer, "My Styrene Soul": https://deardesigner.substack.com/p/my-styrene-soul-a-short-affair-with
- VoltAgent awesome-design-md, Claude DESIGN.md (marketing-site scale): https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/claude/DESIGN.md
- Yacey claude-design typography notes: https://github.com/Yacey/claude-design/blob/main/references/typography.md
- Custom claude.ai width userscript (selectors): https://gist.github.com/ycvk/2ab589109ef328ffd77c03751c6773a9
- assistant-ui Claude clone: https://www.assistant-ui.com/examples/claude
- assistant-ui ChatGPT clone: https://www.assistant-ui.com/examples/chatgpt
- assistant-ui ChatGPT example source: https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/examples/chatgpt.tsx
- assistant-ui Thread docs: https://www.assistant-ui.com/docs/ui/thread
- assistant-ui January 2025 changelog: https://www.assistant-ui.com/blog/2025-01-31-changelog
- Vercel AI SDK Elements course: https://vercel.com/academy/ai-sdk/ai-elements
- vercel/ai-chatbot overview (DeepWiki): https://deepwiki.com/vercel/ai-chatbot
- alexchexes ChatGPT CSS fixes userscript and changelog: https://gist.github.com/alexchexes/d2ff0b9137aa3ac9de8b0448138125ce
- Duro02 chatgpt-ui-scripts PR #3 (computed radii): https://github.com/Duro02/chatgpt-ui-scripts/pull/3
- GPThemes PR #259: https://github.com/itsmartashub/GPThemes/pull/259
- KOL PR #158 (260px sidebar claim): https://github.com/zhiyuan1984/KOL/pull/158
- Resizable ChatGPT Sidebar userscript: https://greasyfork.org/en/scripts/539755-resizable-chatgpt-sidebar/code
- OpenAI community, wider text area thread: https://community.openai.com/t/please-accommodate-desktop-users-with-a-wider-text-area/620797
- RyanD0921/eee (chatgpt.com page dump with `--app-color-*` tokens): https://github.com/RyanD0921/eee
- nodeseek "ChatGPT Gray Dark Mode Restore v4": https://www.nodeseek.com/post-720635-1
- gptmaster, dark mode custom CSS: https://gptmaster.app/guides/chatgpt-dark-mode-custom-css/
- gptmaster, why ChatGPT changed dark mode: https://gptmaster.app/guides/why-did-chatgpt-change-dark-mode/
- OpenAI community, "New ChatGPT dark theme is too black": https://community.openai.com/t/new-chatgpt-dark-theme-is-too-black-on-desktop/1380583
- Joel Dare, font choices (ChatGPT stack): https://joeldare.com/font-choices-from-around-the-web
- Wallpaper, OpenAI rebrand and OpenAI Sans: https://www.wallpaper.com/tech/openai-has-undergone-its-first-ever-rebrand-giving-fresh-life-to-chatgpt-interactions
- OpenAI ChatGPT release notes: https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- OpenAI ChatGPT release notes (2024 sidebar redesign snapshot): https://help.openai.com/en/articles/6825453-chatgpt-release-notes-2026-05-17-OpenAI
- OpenAI, Introducing canvas: https://openai.com/index/introducing-canvas/
- Static.app, What is ChatGPT Canvas: https://static.app/guides/what-is-chatgpt-canvas
- ai-toolbox, ChatGPT Canvas in 2026: https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-use-chatgpt-canvas-guide-2026
- kukie.io, GDPR checklist for Canvas apps (Intelligent UI date): https://kukie.io/blog/gdpr-checklist-chatgpt-canvas-apps
- Zapier, How to use ChatGPT canvas: https://zapier.com/blog/chatgpt-canvas/
- ChatGPT desktop commands reference: https://learn.chatgpt.com/docs/reference/commands
- shortcut-tools, ChatGPT shortcuts (Help Center citations): https://shortcut-tools.com/en/shortcuts/chatgpt/
- ai-toolbox, ChatGPT keyboard shortcuts: https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-keyboard-shortcuts-guide
- OpenAI community, Desktop 26.924 sidebar redesign: https://community.openai.com/t/chatgpt-desktop-26-924-sidebar-redesign-some-missing-features-are-still-there-just-moved/1401386
- popularai, ChatGPT sidebar changes: https://www.popularai.org/p/chatgpt-sidebar-pinned-chats-gpts-projects-missing
- Claude Help Center, What are artifacts: https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- Claude Artifacts feature page: https://claude.com/features/artifacts
- ai-toolbox, How to use Claude Artifacts: https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026
- Justin McKelvey, Claude Artifacts sharing rules: https://justinmckelvey.com/blog/claude-artifacts
- Claude Desktop changelog: https://claude.com/docs/cowork/changelog
- Claude shortcuts (X article): https://x.com/hanakoxbt/article/2042242394557464896
- linuru, Claude keyboard shortcuts: https://linuru.com/claude/
- claudecodeguides, Claude shortcuts: https://claudecodeguides.com/claude-shortcuts-complete-guide/
- GV-v1 issues #1470 and #1471 (Claude look-and-motion targets): https://github.com/tech-nexolvai/GV-v1/issues/1470 and https://github.com/tech-nexolvai/GV-v1/issues/1471
- termhub PR #173 (ChatGPT-style composer growth): https://github.com/engenhariainversa/termhub/pull/173
- OpenAgents issue #11126 (ChatGPT iOS shell): https://github.com/OpenAgentsInc/openagents/issues/11126
- ChatGPT Web accessibility dossier, issue #52598: https://github.com/openai/codex/issues/52598
- OpenAI community, web interface not accessible to blind users: https://community.openai.com/t/the-chatgpt-web-interface-is-not-accessible-to-blind-users/803550
- CapTech, AI and accessibility: ChatGPT: https://www.captechconsulting.com/technical/artificial-intelligence-accessibility-a-look-into-chatgpt
- Cal State ScholarWorks, accessibility fairness case study: https://scholarworks.calstate.edu/downloads/8c97m128x
- claude.ai NVDA/Firefox accessibility issue #35273: https://github.com/anthropics/claude-code/issues/35273
- University of Chicago Academic Technology, Claude accessibility: https://academictech.uchicago.edu/2026/09/08/leverage-claude-enterprise-to-support-accessibility/
- dev.to, Screen reader experience analysis on claude.ai: https://dev.to/wiscer/screen-reader-experience-analysis-on-claudeai-433a
- dev.to, Screen reader mitigation on claude.ai: https://dev.to/wiscer/screen-reader-experience-mitigation-on-claudeai-4khl
