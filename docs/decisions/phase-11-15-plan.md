# Phases 11 to 15: files, pseudo hardening, thread depth, web search, admin

> Status: superseded. The decisions below were the starting point for phases 11 to 15. The phase records (`phase-11-files.md` to `phase-15-admin.md`) build on them and change some of them; where they differ, the phase record decides. The process paragraph is in [workflow.md](../workflow.md).

Agreed with the user on 2026-10-26 in five question rounds. Each phase gets its own decision
record (`phase-N-*.md`) with research findings, data model, task cards and a gate, written by
the phase architect before code. This file fixes the decisions that the records build on.

Process per phase: architect (Opus) writes the record and the server side; the UI implementer
builds the web side to the design brief (phase-9-ui.md section 7); cavecrew-reviewer on each
commit; the scored UI review on every new screen; gate = `pnpm typecheck && pnpm lint &&
pnpm test`, plus the Docker suites a phase touches. Phases 11 and 12 run in parallel; 13, 14
and 15 follow in order.

## Phase 11: Files

Goal: the user can reach every file the agent writes and every file the user uploaded.

1. Screen "Tiedostot": a first-class destination in the sidebar rail and the palette, also
   listed under Settings › Hallinta. One tree with two roots: **Työkansio** (`/data/work/<user>`,
   agent read and write) and **Liitteet** (`/data/files`, chat uploads, read-only). Each file
   shows its origin (chat link for uploads and for files a tool call wrote, when known).
2. Actions: preview, download, delete, upload, new folder, rename, move (work dir only).
   No in-browser editing; edits go through the agent.
3. Preview: text, Markdown, code (highlighted), images, PDF (browser viewer in a sandboxed
   iframe), HTML (same sandbox and CSP as artifacts). Other types: download only.
4. Delete moves the file to `/data/work/<user>/.trash/<timestamp>-<name>`; the trash view
   lists entries with restore; a daily job purges entries older than 30 days. The agent's
   tools cannot see `.trash` (path guard).
5. Limits: 200 MB per file, 10 GB per user total, enforced on upload and on the agent's
   `write`/`edit` tools with a clear error. The screen shows usage.
6. Artifacts get "Tallenna tiedostoksi" (into the work dir). A work-dir file can be attached
   to a message from the composer (picker) and from the file row ("Liitä keskusteluun").
7. Masking: files on disk hold real values (the agent's tool arguments are unmasked). A file
   attached to a message is masked by the existing attachment path. Previews show real values.
8. Server: `GET/POST/DELETE /api/files/tree…` routes with path normalisation (no `..`, no
   symlink escape, no `.trash` writes), streamed downloads, `Content-Disposition`
   attachment, the same auth as `/api/files/:id`. Backups already cover both roots.

## Phase 12: Pseudonymization hardening

1. Surrogate pool: first name and surname both from the DVV lists, combined so the pair has
   fewer than 5 real holders (DVV surname counts × first-name counts estimate; the pool is
   precomputed at image build like the forms). Natural to the model, collision chance near
   zero.
2. Collision: when user text contains a name equal to an issued surrogate, the sidecar does
   not map it to the existing entity. It parks the mention in the vault pending lane
   ("Onko tämä uusi henkilö?") and fails the turn closed until the user answers. Accept →
   new entity, and the old entity gets a fresh surrogate from the next turn on (earlier
   masked chats keep the old one). Reject → the mention is the existing entity.
3. New kinds: EMAIL (surrogate keeps the domain class: gmail stays gmail, a company domain
   becomes `example-N.fi`) and STREET_ADDRESS (street name + number; postcode and city stay as
   they are). Both get surrogate forms, vault rows and unmask.
4. Corpus: +200 synthetic lines: phone-typed lowercase without punctuation, Swedish-Finnish
   names, nicknames, emails, street addresses, decoys. Gate: PERSON recall ≥ 0.98, EMAIL and
   STREET recall ≥ 0.95, precision ≥ 0.97, codes 1.0.
5. Lowercase surnames alone: add the DVV surname frequency list for the lone-surname rule
   (surname with ≥ 200 holders counts when inflected like a surname and not an ordinary word).

## Phase 13: Thread depth

1. Edit and fork: "Muokkaa" on a user message forks into a **new chat**: the server copies
   the session entries up to that message into a new session (masked, no re-masking), the
   new chat gets the edited message as its next turn, title "<old title> (haara)", same
   topic and agent, a "Haarautettu keskustelusta …" link row at the top. The original chat
   stays unchanged. No in-thread branch switcher.
2. Reasoning: a collapsed row "Ajatteli 12 s" above the reply, like a tool row; expands to
   the masked thinking text; a setting "Näytä ajattelu" (default on) hides the row entirely.
   Thinking text passes the same `/scan` as any assistant text.
3. Cost and usage: pa-server stores per-call `usage` and `cost` (USD) from LiteLLM on each
   assistant message. Shown per reply on hover (action row meta), per chat in the chat menu
   ("0,42 € · 18 k tokenia") and in the export, and monthly per model under Settings ›
   Käyttö. EUR with a daily ECB rate (`https://data-api.ecb.europa.eu`, no key, cached in
   `DATA_DIR`; USD shown when the rate is missing).
4. Timestamps on hover of each message; in-chat search (Ctrl/Cmd+F inside the thread) with
   match highlights, reusing the FTS index where the chat is loaded.

## Phase 14: Web search

1. Tool `web_search { query, maxResults? }`, available to every agent by default (profile can
   remove it). The server executes it: one `zdr/fast` chat completion with OpenRouter's web
   plugin (`plugins: [{ id: 'web', max_results: 5 }]`) that returns the citations
   (`annotations.url_citation`: title, url, snippet) as a structured tool result. No page
   fetch, no storage beyond the masked tool result in the session. Cost about 0.02 USD per
   search plus tokens.
2. Query guard: the tool call passes the pseudonymization `tool_call` hook like any tool. If
   the unmasked query differs from the masked one (it contains a vault entity), the server
   does not run it; it raises an approval card with the real query ("Haku: …"). Hyväksy runs
   it with the real text; Hylkää returns a tool error that tells the model to search without
   the person. Automations never get the bypass (denied).
3. Visibility: every search is a tool row "web_search · 5 tulosta" with the query and the
   citations; no approval for queries without entities.
4. Prompt: both agent prompts get a restraint paragraph: search only for facts that change
   over time or that the user asks to verify; never look up people, never include names,
   codes or addresses in a query; at most two searches per answer unless the user asks for a
   deep search; cite the URLs used.
5. Egress: LiteLLM alias `zdr/search` (fast model with the plugin fixed server-side); the
   guard allows `plugins` only for that alias. Egress probe added.

## Phase 15: Admin

1. Agents editor: Settings › Agentit opens a form per agent (name, model alias or catalog
   model, prompt in a Markdown editor, tools, MCP servers, approval always/never, subagents)
   with a YAML tab; the same zod schema validates; save writes `agents/<id>.yaml` and the
   prompt file, git-tracked, and the running registry reloads. New agent, duplicate, delete
   (not the default agent).
2. Automations editor: form with name, agent, prompt, delivery (chat, push, both), schedule
   presets (daily at, weekdays at, weekly on) plus a raw cron field with a next-runs
   preview, enable/disable, "Aja nyt". Saves `automations/<id>.yaml`.
3. Devices: Settings › Laitteet lists sessions (device name from the user agent, created,
   last seen, this device), "Kirjaa ulos" per row, "Kirjaa ulos kaikkialta". Sessions table
   gets the columns it lacks.
4. Full data export: Settings › Tiedot › "Vie kaikki": a zip with Markdown and JSON per chat,
   `vault.json`, memory files and the work dir, AES-256 encrypted with a passphrase typed in
   the dialog (zip AES per the standard, or an age-encrypted archive if the zip library
   cannot; the record decides), masked or open like the chat export. Built as a background
   job with progress, downloaded once, deleted after one hour.
5. Usage page (from phase 13 data): monthly cost per model and per agent, searches count.

## Out of scope

Voice out (TTS); in-thread branch switcher; in-browser file editing; company and date-of-birth
detection; approval per web search without entities.

## Gate (2026-10-26)

Run on a clean worktree of `af21f52`: `pnpm typecheck` and `pnpm lint` pass; `pnpm test` passes
every unit suite (server 164, web 30, protocol 40, contract 23, pseudo extension 17, subagents 13,
memory 9, sandbox extension 5, masked-only 2, mcp 14, fake-llm 6, db 1) and e2e 476 of 477; the one
failure was a shared test dictionary that the fake sidecar wrote into, fixed in `aaa6e13` and
looped 72 of 72 green afterwards. `pnpm test:egress` 25, `pnpm test:sandbox` 17, sidecar pytest
135 (3 Voikko tests skipped locally, all pass in the image). Every scored UI review passed with
every cell at 5. The local Docker stack runs the final image.
