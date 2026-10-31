# Phase 31: publication preparation

Date: 2026-10-31. Follows phase 30 (`phase-30-audits.md`). The user decided these in a written
discussion before the repository goes public.

## Decisions

1. **License: MIT.** `LICENSE` at the root, copyright the owner, 2026.
2. **CI on GitHub Actions.** `.github/workflows/ci.yml` runs the gates that need no model key and no
   Docker: typecheck, lint, the unit suites, the Pi contract tests, `tests/masked-only` and the
   Playwright chromium flows. The embedding model and the browsers are cached. No deploy job: the
   user deploys through Coolify by hand.
3. **History rewrite, once, before the first push.** `git filter-repo` on 2026-10-31 at `6de6705`:
   - the committed embedding model under `tests/masked-only/models/` left every commit (112 MB
     blob; GitHub refuses blobs over 100 MB);
   - the screenshot baselines `tests/e2e/screenshots*` left every commit and came back in one
     commit on top (their churn was 287 MB of the 238 MB pack);
   - the `Claude-Session:` trailer left every commit message (private session links);
   - the author email of 59 commits became the GitHub noreply address.
   Result: 383 commits became 375, the pack went from 238 MB to 35 MB, the tree of `HEAD` is
   byte-identical to the tree before the rewrite (same tree hash). A mirror of the old history
   stayed on the build machine only. The `Co-Authored-By: Claude …` trailer stays: the build was
   orchestrated by Claude Code and that is part of the story. New commits carry no session link.
4. **Supply-chain settings explicit.** `pnpm-workspace.yaml`: `minimumReleaseAgeStrict: true`,
   `strictDepBuilds: true` (phase 30 batch A also pinned the Node images by digest).
5. **Synthetic names only.** The owner's name left six test and record files; the fixtures use
   synthetic Finnish names like the rest.
6. **Not scrubbed, on purpose.** `docs/plan.md` keeps the infrastructure facts (VPS size, prices,
   Coolify); they describe the design, not a person.

## Status

Done 2026-10-31. Left for phase 32: the README for readers, curated screenshots under
`docs/media/`, the repository name and description on GitHub (the user chooses the name).
