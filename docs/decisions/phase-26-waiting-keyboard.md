# Phase 26: Waiting line and Android keyboard

Date: 2026-10-29. Follows phase 25. The user approved two changes: the waiting state "Vaiheet"
(variant A of the designer's mock, without escalation) and items 1 and 2 of the mobile composer
audit (Android). Brief section 7 and the records of phases 13 and 20 stay valid, except where this
record changes them.

## Decisions: waiting line

1. **Server event.** Pi gives `before_provider_request` and `after_provider_response` to extensions
   only. `usageExtension` (`usage.ts`) gets them and calls `onPhase`. The registry sends them to the
   chat's listener as `provider_phase`, in Pi's order. `forward` (`bridge.ts`) sends
   `message.phase { chatId, messageId, phase: 'sent' | 'headers', at }` (strict zod). Pi sends both
   before `message_start`, so `sent` makes the stream id and `message_start` takes it.
2. **Stored times.** The same handlers store `pa.queueMs` (request to headers) and `pa.writeMs`
   (first text token to the end) with `pa.thinkingMs`. `Message.phases` carries them. A reload
   shows the receipt. Messages from before phase 26 have no receipt.
3. **Client clock.** The store keeps one `Wait` per running chat in client times. Steps: 0 sending
   (`message.accepted` gives "Lähetetty"), 1 queue (`sent` to `headers`), 2 thinking
   (`message.thinking`) or "työkalu" (`tool.start` to `tool.end`), 3 writing (first delta). A later
   round queues again and adds to the queue total. The client does not use `at`.
4. **Line.** `WaitingLine.tsx`: meta 13/18, muted, arrows with 6 px gaps (the mock), the active step
   in `--foreground` with a 1.8 s highlight (`.sweep`). Reduced motion: colour only. UI review 2:
   past and later steps are both `--muted-foreground` at 400 (5.72:1 light, 6.66:1 dark on
   `--background`), the active step `--foreground` at 500 (17.5:1, 12.7:1), and the arrow before a
   later step `--chart-faint`; `--pending-foreground` is gone. A visually
   hidden `role="status"` ("Vastaus tulossa") gets the step word only, never the seconds.
5. **Hand-over.** Before the first token the line fills the 28 px first line. The text fades in at
   that place and the line fades out (150 ms). The line continues at the end of the reserved action
   row, as in the mock. Phone line: it is clipped if it is wider than the column.
6. **Receipt.** "Jonotti 14 s → ajatteli 3 s → kirjoitti 3 s" at the end of the action row, next
   to the time and cost. A phase that did not happen is not shown (no thinking: no "ajatteli"). A
   queue under 1 s shows "1 s" (`duration`). A reply adds the times of its tool rounds, as its cost
   does. No "yhteensä" part: the row has no room for it.
7. **Phones (< 768 px).** The row has no room for icons, meta and receipt. The receipt is in the
   long-press sheet, under the meta line. The live line stays in the row while it writes.
8. **Thinking.** The line shows the live thinking; the spinner row "Ajattelee… 8 s" is removed.
   When the thinking stops, the static row "Ajatteli 12 s" comes (phase-13 place) until the final.
   "Näytä ajattelu" hides the rows, not the line.
9. **Approval card.** While a card is open, the first line has no waiting line (phase-20 rule: no
   row between the tool row and its card).
10. **End of the live turn.** A final without tool calls ends the live turn. Before, the dots came
    back between the final and the idle status, and the turn moved 52 px.

## Decisions: Android keyboard (audit items 1 and 2)

11. **Keep the place.** A `ResizeObserver` on the thread calls `Follow.resized(el, delta)`. Pinned:
    keep the bottom. Scrolled up: `scrollTop += delta`. The section has `overflow-anchor: none`.
12. **Keep the keyboard.** "Lähetä" and "Lisää jonoon" call `preventDefault` on `pointerdown`
    while the textarea has focus. Chromium keeps the focus for touch and for a mouse.

## Measurements (Playwright Chromium 1248)

| Value | Before | After |
| --- | --- | --- |
| Plain reply: user bubble move at the first token | 0 px | 0 px |
| Plain reply: move at the final (dots between final and idle) | 52 px | 0 px |
| Thinking reply: move at the thinking start | 4 px | 0 px |
| Thinking reply: move when the thinking stops ("Ajatteli" row) | 36 px, with the text | 40 px |
| Pixel 7, keyboard 330 px: hidden part of the last reply | 226 px, pill | 0 px, no pill |
| Same, 3 typed lines | 274 px, pill | 0 px, no pill |
| Scrolled up 400 px, then the keyboard: distance to the bottom | 730 px | 400 px |
| Focus after "Lähetä" | `BODY` | the textarea |

## Files

`packages/protocol/src/index.ts`; `apps/server/src/{usage,bridge}.ts`, `pi/registry.ts`;
`apps/web/src/{store,thread}.ts`, `components/{WaitingLine,Thread,MessageView,ThinkingRow,Composer}.tsx`,
`tokens.css`; `tests/fake-llm` (`queueMs`); tests in `thread.test.ts` (server, web), `store.test.ts`,
`index.test.ts`, `flows.spec.ts` (hand-over and Pixel 7 flows), `screens.spec.ts` (`waiting-queue`,
`waiting-thinking` replaces `thinking-live`, `reply-receipt`; 390 and 1440, light and dark).

## Risks and open items

- The live seconds (client) and the receipt (server) can differ by 1 s at a rounding edge.
- No model has a Pi `promptCache` tier. If one gets it, Pi's cache warmer can send a request
  that counts as a phase.
- Without scroll anchoring, a block that grows above the reader moves the text in Chromium too.
- Not in this phase: the audit's item 3 (safe-area check on a device) and the iOS set.
- WebKit: only the new 390 screens are shot.

## Status

- Merged: yes (`262f5ae`, 2026-10-29).
- Gate: `docs/development.md` lists the phase as done. The gate run is not recorded.
- Review: phase-23 UI review 2 (fixes in `99162d5`) and the phase-23 and 26 code review (fixes in
  `685ef50`). Scores not recorded.
