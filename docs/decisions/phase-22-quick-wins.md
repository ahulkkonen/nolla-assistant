# Phase 22: quick wins after phase 21

Date: 2026-10-29. Follows phase 21 (`phase-21-polish.md`). The user chose these in a written
discussion. Phases 23 to 25 (modes, router, edit in place, harness tools) have their own records.

## Decisions

1. **Model errors show the real cause.** The `error` message of a failed model call carries
   `status` (the HTTP status from the provider, when there is one) and `detail` (the provider's
   message, first 400 characters, through the same masking as tool output). The toast shows
   "Mallikutsu epäonnistui (404)" with a "Näytä tiedot" action that opens the detail; the web also
   logs the whole error object with `console.error`, so devtools shows it.
2. **ZDR refusal classifier.** `isZdrRefusal` recognises OpenRouter's current formats:
   `zdr-violation-by-account`, "ZDR violation (account settings)", "No endpoints found matching
   your data policy (Zero data retention)" and "0 endpoints out of N requested … ZDR". The existing
   "Ei ZDR" offer then appears by itself. The picker's ZDR badge gets a tooltip: "ZDR-reitti
   OpenRouterin listan mukaan; yksittäinen päätepiste voi silti kieltäytyä".
3. **Title lock only on rename.** A fork copies the title but does not lock it
   (`bridge.ts`, `titleLocked: !!src.title` goes). The sidebar shows a small fork mark
   (`GitFork`, muted, "Haarautettu keskustelusta …") on a chat that has `forkedFrom`, and the lock
   only when the user renamed the chat.
4. **Topics.** The classifier prompt gets rules: the reason is at most two short sentences, never
   starts with "Keskustelussa"; a new topic is proposed only when it would cover more than one
   chat and is a broad theme, not one request. Proposals are deduplicated against existing topics
   and open proposals by embedding similarity (threshold recorded in the code, reuse the
   embeddings helper in `apps/server/src/embeddings.ts`). In the Aiheet screen "Keskustelusta: X"
   is a link that opens the chat.
5. **PWA auto-update when idle.** `onNeedRefresh` reloads at once when no chat is streaming, the
   composer is empty and no dialog or sheet is open; otherwise it waits and reloads at the next
   idle moment (checked on every `agent.status` and composer change). The toast goes. A one-line
   "Päivitetään…" status is enough.
6. **Escape audit.** Every Escape path is listed and fixed so one press does one thing: the
   settings dialog closes on the first press (today two), the palette, find bar, sheets, the
   composer edit, the sidebar search and the stop of a run. Document the order of precedence in
   `apps/web/src/shortcuts.ts`. Verified by hand with Playwright; no new e2e specs.
7. **Subagent children honour auto-approve.** A child's gated tool call that bubbles to the
   parent's `ask` passes without a card when the parent chat is in `approvals.autoApprove` and the
   tool is in the chat's list (`registry.autoApproveTools`).
8. **Plain http on the wifi.** `AUTH_ORIGIN` may be `http://<host>:3000` for a non-loopback host
   when `AUTH_INSECURE_LAN=1` is set. `infra/compose.local.yaml` publishes port 3000 on all
   interfaces when `PA_LAN=1`. `docs/deploy.md` "Local run" explains: open
   `http://<mac-name>.local:3000` on the phone, password login works, passkeys, microphone and
   PWA install need https and stay off. The insecure cookie flag follows the origin scheme as
   today.
9. **`web-digest` fetches any host.** The skill's `sandbox.network` becomes `internet`; the bash
   approval card already shows the `curl` command with the URL. The skill text says: fetch only
   the URL the user gave.
10. **Pi 1.4.0.** The runtime moves from 1.3.0 to 1.4.0 (released 2026-10-21). The contract tests
    in `tests/contract` and the decision `0001` note are updated. Breaking changes are listed in
    the record of this phase.
11. **WebKit screens.** A Playwright `webkit` project runs the `screens` spec at 390 px light and
    dark and the figure, queue, approval and picker flows. Baselines live under
    `tests/e2e/screenshots-webkit/`. Axe runs there too.

## Status

Open. Worktrees: `p22-srv` (1, 2, 3 server part, 4 server part, 7, 8, 9), `p22-web` (1 web part,
3 sidebar, 4 screen, 5, 6), `p25-pi` (10, 11).

## Pi 1.4.0 (decision 10)

`0009-pi-1.4.0.md` lists the breaking changes. None needs a code change.

## WebKit findings

Run on 2026-10-29: `pnpm test:webkit` (Playwright 1.64.1, WebKit 27.2), 197 tests: 190 passed,
5 failed, 2 skipped (`chat-header` is not shot at 390). Axe ran on every screen that the test
reached (186 screens): no failures. Fonts (sans, serif, mono, emoji) load. No screen scrolls
horizontally. Dates and clock times differ from the Chromium baselines only because the shots
were made on another day. Nothing is fixed in the web code.

1. **Hyphenation.** WebKit breaks fewer Finnish words than Chromium, so line breaks and line
   count differ. Nothing is clipped. Screens: `jump-pill`, `composer-queue`, `chat-confidence`,
   `chat-annotated`, `memory-claims` (1 px taller).
2. **User bubble width.** The user bubble wraps one word earlier. Screen: `chat-annotated`.
3. **Textarea scroll position.** An over-long USER.md shows its first lines in WebKit and its
   last lines in Chromium. Screen: `memory-overcap`.
4. **Hour format.** The approval card shows "Vanhenee klo 05.32" (leading zero), the message
   time shows "klo 5.22" (no zero). The Chromium baselines were shot after 10 o'clock, so they do
   not show if Chromium does the same. Screen: `approval-card`.
5. **Notifications unsupported.** Playwright's WebKit has no `Notification` and `PushManager`, so
   `mockPush` cannot run and the row shows "Selain ei tue ilmoituksia". The row label then repeats
   the heading "Ilmoitukset". Safari on iOS has push only in an installed PWA. Screens:
   `settings-notifications` (fails, not shot), `settings-integrations`.
6. **Microphone denied.** With `mockMic`, WebKit shows the toast "Mikrofonin käyttö estetty" and
   no recording row. The cause is not known. Screen: `voice-recording`.
7. **Test needs Chromium.** `files-upload` throttles the network through a CDP session, which
   only Chromium has. Screen: `files-upload` (fails, not shot).
8. **Tab skips buttons.** In the flow "inline figures", Tab does not reach "Avaa paneelissa".
   WebKit on macOS moves Tab only between form fields unless the user turns on full keyboard
   access (Option+Tab). Safari users get the same default. Flow: `inline figures` (fails).

The flows `queue`, `approval card`, `model policy` and `inline figure: a lazy frame` pass.
