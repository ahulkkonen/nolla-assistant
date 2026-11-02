# Workflow

This document tells how one person and one Claude Code session built this repository. You can copy
the method for your own project. The README has the main figures
([How it was built](../README.md#how-it-was-built)).

## How the hours were measured

Sort the timestamps of all records in the Claude Code transcript, including the records that
background subagents write. A gap of more than 30 minutes ends a block. The sum of the block
lengths is the active time: 61.8 h. With a 15-minute gap it is 43.9 h, and with a 60-minute gap it
is 72.3 h. The session's own counter shows 76.2 h. For my presence, count the 15-minute blocks
with a message from me: 53 blocks, 13.3 h. This lower bound leaves out reading, phone
tests, thinking and time in Claude Web. [`build-stats.md`](build-stats.md) has the totals and the method in full.

## The plan and the phases

- [`plan.md`](plan.md) existed before the first session. It fixes the invariants (§2), the
  architecture (§3), the protocol (§5), the personal data (PII) and memory designs (§6, §7) and the
  UI spec (§11).
  It also has eight phases with done criteria (§13) and the quality gates (§14).
- My first instruction set two rules. Do the work end to end and ask only for blockers. Never
  install a package version that is younger than 7 days.
- Phases 1 to 8 follow the plan. Phases 9 to 35 came from my tests, my requests and research. I
  set the scope of each one. 33 phases are done. Phase 18 is deferred and phase 29 is reserved.
- Phases 11 to 15 had one plan. I agreed its decisions on 2026-10-26, in five rounds of questions.
  In each phase, the architect (Opus) wrote the phase record before any code. The architect then
  built the server side. The UI builder then built the web side to the design brief. A reviewer
  read each commit. The scored UI review checked each new screen. The gate was
  `pnpm typecheck && pnpm lint && pnpm test`, plus the Docker suites that the phase touched.
  Phases 11 and 12 ran in parallel. Phases 13, 14 and 15 followed in order.
- A task is one service or one screen at most. Each task has a card. The card lists the goal, the
  plan section, the files that change, the acceptance test command, what is out of scope, and the
  reviewers.

## Roles

| Role | Model and effort | Job | Why this model |
|---|---|---|---|
| Main session | Fable 5.1, the main thread | Holds the plan, writes the prompts, starts agents, runs the gates, commits. It never called Edit. It made 1,126 shell calls, 177 agent starts and 151 follow-up messages. It changed files through the shell only for merges, one-line fixes and documentation. The subagents made the code changes. | One context holds the whole plan and the state of every agent. |
| Architect | Opus 5.5, often xhigh effort | Reads the plan and the earlier records, then writes the phase record with decisions and task cards. The spikes (Pi contract, Finnish NLP, LiteLLM ZDR) used the same role. | A wrong decision costs a whole phase. |
| Builder | Opus 5.5 for hard cards, Sonnet 5.5 for mechanical cards | Does one card or one package. Up to 8 builders ran at the same time. | Sonnet is enough when the card fixes the scope and the test: Dockerfiles, the fake LLM server, e2e flows. |
| Reviewer | Sonnet 5.5 in 43 of 44 runs | Reads one diff and writes one line per finding, with a severity. | A diff and a card are a narrow task. The 44 passes used 2.0 h of agent time. |
| Screenshot reviewer | Opus 5.5, xhigh effort, never the builder | Scores screenshots against the design brief. Never sees the diff. | Layout and type are the hardest to judge. |
| Fix agent | The builder, continued with a follow-up message, or a new agent | Closes the findings of a review. | The builder keeps the context of its own change. |

## Decision records

- [`decisions/`](decisions/README.md) holds 42 records: one per finished phase, and nine for
  decisions that cross phases. Those nine cover two Pi contracts, workflow and pins, the Finnish PII
  stack, LiteLLM and zero data retention (ZDR), and MCP. They also cover three research results.
- A record lists the decisions, the status and the review findings that stay as they are, each with
  a reason. It cites plan sections as `§N`. An agent reads it before it changes that area.

## The review loop

1. A builder finishes a card and runs the tests of its package.
2. A reviewer reads the diff against the card, the invariants (plan §2) and security. It writes one
   line per finding, with the severity blocking, should-fix or nice-to-have.
3. A fix agent fixes every blocking and every should-fix finding. For each nice-to-have, it fixes
   the finding or writes one line in the record that tells why it stays.
4. The main session runs the gates and commits. The review comes before the commit, so `git log` is
   the review log.

## The UI loop

- The design brief is [`phase-9-ui.md`](decisions/phase-9-ui.md), section 7. A reviewer wrote it from
  the screenshots and from the research in [`0006-ui-reference.md`](decisions/0006-ui-reference.md).
  Each section ends with a source line. The word "chosen" marks a value that the research did not
  give.
- The Playwright project `screens` shoots every screen at 390, 1024 and 1440 px, in light and dark,
  with strict axe checks: 582 tests. The 390 px shots run under touch emulation.
- An Opus reviewer gets only the screenshots, the brief and the criteria, never the diff. It scores
  each screen 1 to 5 on hierarchy, rhythm, states, fit, parity and finish. Scores inflate when one
  reviewer sees the same screens many times. So a fresh reviewer scores the full set.
- The gate is a 4 or a 5 in every cell. A 3 is a should-fix finding. A 1 or a 2 is blocking.
- The budget is up to five rounds per slice, and more across slices. After five failed rounds in one
  slice, the main session stops and reports to me.

## Gates

Before each commit, these checks pass on a clean worktree:

- `pnpm typecheck` and `pnpm lint` (Biome).
- The Vitest suites (582 tests) and `pnpm test:contract` (28 tests against the pinned Pi).
- `tests/masked-only`: no real value in the sessions, the model requests or the server log.
- Playwright: chromium flows (89) plus the screens project (582).
- `pnpm test:sandbox` after a broker or sandbox change. The compose stack after a Dockerfile or
  compose change.

CI ([`ci.yml`](../.github/workflows/ci.yml)) runs the checks that need no key and no Docker. It runs
on each push to `main` and on each pull request.

## How I worked

- I sent 84 messages in 61.8 active hours, 9 of them with a screenshot. The median gap between two
  messages was 11.9 minutes. In 79 % of the active time, my last message was more than 10 minutes
  old.
- I was the product owner and the tester on a phone and a desktop. I reported what was blank or
  broken, with screenshots, and gave taste verdicts on diagram looks, caret animations and charts.
- The main session asked me 10 multiple-choice questions. I answered with short numbered replies.
- I decided the hard design questions: what counts as a leak, the ZDR policy, the search
  provider and how the phone reaches the server. I also set the scope of each new phase.
- I ran two deep research passes in Claude Web and pasted each result word for word into a record.
  The next architect record cited it. Pass one covered the UI of Claude Web and ChatGPT, and how to
  get a polished UI from agents that review screenshots ([0006](decisions/0006-ui-reference.md)).
  Pass two used a prompt that the main session wrote. It covered memory, search, streaming and
  charts ([0007](decisions/0007-memory-and-search-research.md),
  [0008](decisions/0008-viz-research.md)).
- I did the account steps that no agent can do: the API keys in `.env`, the GitHub settings, the
  PWA install on the phone and the browser's install prompt.

## Dependency rules

- Exact pins. `.npmrc` sets `save-exact=true`, and `pnpm-workspace.yaml` sets `savePrefix: ''`.
- No release younger than 7 days. `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` and
  `minimumReleaseAgeStrict: true`. The Python lock uses `uv pip compile --exclude-newer` with a
  cut-off at least 7 days old, and hashes ([Dependency policy](development.md#dependency-policy)).
- `strictDepBuilds: true`, and the Node images are pinned by digest.
- A version bump is its own change. A Pi bump also diffs the `.d.ts` files, runs the contract tests
  and gets a new record ([0009](decisions/0009-pi-1.4.0.md)).
- A malware audit before publication checked 1,260 npm lock entries and 64 Python packages against
  the npm advisories, the OSV malicious-package feed and lists of indicators of compromise. It found
  no malicious package
  ([`audits/`](audits)).

## Publication

1. Opus agents ran three audits: security (2 blocking, 6 should-fix), architecture (1 blocking,
   14 should-fix) and supply chain (clean). Phase 30 fixed the blocking and the security findings.
   Phase 35 fixed four follow-ups.
2. Sonnet agents checked the facts in `AGENTS.md` and the README. The README then got a blind review
   in two roles, a recruiter and a senior engineer, and a check of every number, path and command.
   Round one found five wrong facts and a broken badge.
3. `git filter-repo` rewrote the history one time, before the first push. It removed a 112 MB model
   blob, the many changed versions of the screenshot baselines and the session links in commit
   messages. It set the author email of 59 commits to the GitHub noreply address. At that time, 383
   commits became 375. The compressed size of the repository (the pack) went from 238 MB to 35 MB.
   The tree of `HEAD` kept its hash
   ([phase 31](decisions/phase-31-publication.md)).
4. The last step added CI on GitHub Actions, the MIT license and synthetic names in every test
   fixture. The fixtures use made-up ID numbers in the 900 range, which no person gets. It also
   added the [threat model](threat-model.md) and the README media.

## What I would change

1. Audit the whole repository at the midpoint. The plan asked for an Opus code reviewer, but 43
   of 44 diff reviews ran on Sonnet. The audits before publication still found 3 blocking and 20
   should-fix findings. A diff review does not see a problem that crosses files. Use Opus for diffs
   that touch masking, the one path out for model calls, or the sandbox.
2. Keep large binaries out of git from the first commit. A 112 MB model and 287 MB of screenshot
   changes made the history rewrite necessary. The 287 MB is the uncompressed blob size. The pack
   holds the compressed size.
3. Check on the phone at each phase gate. The [status table](development.md#status) still lists
   open on-device checks or user steps for phases 2, 6, 7, 9, 10 and 14.
4. Stop idle agents. The median run had 10.9 minutes of active work. Yet 13 runs waited for hours,
   either for a follow-up message or because the computer was asleep. Stop each run when its card
   is done. Keep the build machine awake during a long phase.
5. Record the time during the build. The two measures of this build differ by 14 h (61.8 h and
   76.2 h). Write the start and the end of each phase into its record.
