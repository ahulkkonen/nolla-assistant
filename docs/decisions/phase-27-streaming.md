# Phase 27: Streaming reply

Date: 2026-10-29. Follows phase 26. The user approved variant C of the streaming audit's mock
(per-frame batching, the caret on the last character, the breathing caret, no word fade): the
audit's changes 1 to 7. Brief section 7 and the records of phases 16, 20 and 26 stay valid, except
where this record changes them.

## Decisions

1. **One article for the live reply and its final message.** A reply turn's key is the id of its
   user turn and its place after it (`<user id>:0`). The final message's id is the Pi entry id, not
   the stream id, so a message id cannot be the key. Items in a turn have keys by place. The live
   reply and the final message use one `MessageView` tree, so `message.final` changes the text in
   place: no remount, no fade. Turns that started live on this device do not fade in. Messages
   from a reload or another device fade in as before.
2. **One commit per frame.** `ws.ts` holds the deltas until the next animation frame and joins the
   deltas of one chat (annotations shifted). Any other frame applies the waiting deltas first, so
   the order stays. The store applies a delta with one `set`.
3. **Caret on the last character.** `rehypeCaret` puts the caret after the last text that is not
   whitespace. It skips the `"\n"` between list items and table rows. It keeps the newline at the
   end of a code block after the caret. An empty code block at the end takes the caret.
4. **The thread does not render per delta.** `MessageView` gets `live` (the chat id) and reads the
   stream itself. `Thread` reads only "a stream exists" and the tool rows. A separate `LiveReply`
   component was not used: a different component type remounts the reply at the final (1).
   Follow: the phase-26 `ResizeObserver` also observes the content. It runs after layout, once per
   frame, and does no forced layout. It also shows the pill when the content grows past 80 px.
5. **Held-back Markdown.** `settleTail` holds a table until its delimiter row ends, and a row that
   has no text yet. Only a line that starts with a pipe, or a line after a piped line, is held: a
   prose line with a pipe shows while it streams (review fix 4). It closes an open
   `**` and `*` of the last line (the inner one first) and holds back a trailing run. The old
   delimiter-row completion is gone.
6. **Breathing caret.** The caret is solid while text arrives. 400 ms after the last text it
   breathes: 1.4 s, opacity 1 → 0.2 → 1, `ease-in-out` (the mock's keyframes), radius 1 px. New
   text flips `data-tick` on the live `.md`, which swaps two equal keyframes and starts the wait
   again. Brief 7.6 has the new rule. Reduced motion: the caret is solid (global rule).
7. **Any upward scroll stops the follow.** `Follow.up` unpins at once. A scroll of the reader pins
   again only at the bottom (2 px), not in the 48 px zone. Touch counts only a finger that moves
   down. The pill rules do not change.
8. **First line height.** The first-line box (waiting line, text) is one prose line: 28 px, 26 px
   on phones. Before, a one-line reply on a phone lost 2 px at the final.

Reduced motion: no change. The text shows at once, the caret is solid.

## Measurements

Method of the audit: the production build, the fake LLM, a WebSocket route that sends tokens of
3 to 4 characters at 40 per second in packets of 1 to 3, a 1,323-character reply (prose, bold,
list, 13-line code block, table), 451 delta frames, 1280 × 800, Chromium trace and CDP metrics.
The before runs use `462e249`. Headless Chromium does not slow `requestAnimationFrame` under
CPU throttling, so dropped frames come from the trace (`STATE_DROPPED`, 4 runs at 4×).

| Value | Before | After |
| --- | --- | --- |
| React commits per delta | 1.13 | 0.61 (one per changed frame) |
| Commits that were never painted | 225 | 5–27 (other state changes in the same frame) |
| Forced layouts in the stream (per delta) | 423 (0.94) | 6 (0.01) |
| Script per delta, 1×, 12 earlier turns | 3.1 ms | 0.7–0.8 ms |
| Script per delta, 4×, 1 / 12 earlier turns | 2.6 / 7.2–9.4 ms | 1.5 / 1.5–2.1 ms |
| Main-thread tasks over 12 ms, 4×, 12 turns | 48–92 | 7–12 |
| Dropped frames, 4×, 12 turns (median of 4) | 11.5 (3–23) | 3.5 (2–5) |
| Caret not after the last character | 6.7 s | 0 s |
| Raw Markdown visible (table header, `**`) | 1.0 s | 0 s |
| Lowest reply opacity at the final | 0 | 1 |
| Reply DOM replaced at the final | 16 ms after it | never |
| User bubble and reply text move at the final | 0 px | 0 px |

## Review fixes

Phase-27 and UI-fix review, 2026-10-29. Measured with Playwright Chromium; contrast from the tokens
(WCAG 2 ratio).

1. `disconnect()` cancels the waiting frame and drops the deltas. A sign-out (also a 4401 close or
   an `auth.state` without a session) leaves no delta to land after the wipe.
2. The set of turns born live belongs to one chat. The render that shows another chat resets it,
   so the key that the first render of a streaming chat adds stays and its final does not fade
   in. Before, the chat effect cleared the set after that render; a later render while live added
   the key again, so the flash needed a final before any other render of the thread.
3. A chat switch and a sent message call the follow at once. A cached chat of the same height
   gives no resize, and the resize callback can come before the effect that pins.
4. Decision 5 changes as written there. A header row without the leading pipe shows as text until
   its delimiter row starts.
5. "Jonossa" badge: `outline`. `secondary` on the `--muted` list is 1.05:1 (light) and 1.44:1
   (dark), under 3:1. The outline's `--border` edge is 1.26:1 and 1.40:1; the text is 15.9:1 and
   13.9:1.
6. The Tila chip's fit check runs again when the chip mounts after the modes load.
7. Phone composer row: the toolbar fit (UI review) runs on phones too. The warning shield of
   auto-approve gives way first (level 1) when the model's name would be cut; the model sheet shows
   the state. At 390 with "Pysäytä" and "Lisää jonoon": Auto (31 px) and Opus 5.5 (59 px) keep
   their name and the shield (37 and 9 px free). Gemini 4 Argon (103 px) loses the shield and is
   still 7 px short. The `auto-approve-on-closed` screen (Auto) keeps the shield.
8. "Näytä luvut" on: a 12 px check before the text (the segmented-control pattern). The on and off
   fills differ by 1.15:1 (light) and 1.42:1 (dark). The pill grows 16 px to the right (79 to
   95 px), at 1280 and 390; the label, the scale and the rows do not move. Changed in UI review 2:
   the pill is 28 px high (44 px target) and 103 px wide on and off.
9. Not changed: the live reply keeps its key by place. The key goes to the message that came out
   of the live view: a tool-only final gets the live tool rows (an open row stays open), and the
   text final gets the reply's DOM (decision 1). With a constant `live` key, the open row closed at
   the tool-only final and the reply's DOM was replaced at the text final. A flow checks both.
10. Empty chat ≥ 768: a 48 px spacer without a rule holds the header's place. The chat column's top
    at the first send moved 0 to 48 px; now 48 to 48 px. The greeting and the centred composer of
    the empty chat are 29 px lower (40 % of a 48 px shorter area).

## Files

`apps/web/src/{ws,store,thread}.ts`, `components/{Thread,MessageView}.tsx`, `tokens.css`; tests
in `ws.test.ts`, `thread.test.ts`, `MessageView.test.ts`; brief 7.6 in `phase-9-ui.md`;
screens `streaming`, `waiting-queue` and `waiting-thinking` at 390 (the 2 px line).

## Risks and open items

- Emphasis closing reads the last line only. An `**` opened on an earlier line of the same
  paragraph shows its asterisks until it closes.
- A caret in a table cell makes that column about 10 px wider while the cell is the last one.
- In a background tab the deltas wait for the next frame; any other frame applies them.
- Not in this phase: the word fade (audit change 9) and `text-wrap` while live (change 8).

## Status

- Merged: yes (`4356103`, 2026-10-29).
- Gate: `docs/development.md` lists the phase as done. The gate run is not recorded.
- Review: the phase-27 and UI-fix review (section "Review fixes", fixes in `434f1cc`). Scores not
  recorded.
