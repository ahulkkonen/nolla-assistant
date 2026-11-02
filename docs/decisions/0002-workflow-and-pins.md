# 0002 — Workflow, git, and dependency pins

## Context

The plan (section 1 and 14) says every task is one PR with one review pass. The user set one extra rule on 2026-10-25: never install a package version that is younger than 7 days.

## Decision

1. Each task is one commit on `main` after the review pass. A review rejection is fixed before the commit, so history shows reviewed work only. The remote is `origin` on GitHub (since phase 31). Push `main` only after the merge gate is green, because `.github/workflows/ci.yml` runs on every push to `main`.
2. Every dependency is an exact pin. `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days in minutes) and `savePrefix: ''`; `.npmrc` sets `save-exact=true`. The orchestrator also set the rule globally on the build machine (`pnpm config set --global minimum-release-age 10080`, `npm min-release-age=7`).
3. Pi is `@earendil-works/pi-coding-agent` 1.3.0 (published 2026-10-15). Version 1.4.0 (2026-10-21) was too young on 2026-10-25. A bump to 1.4.0 is its own task after 2026-10-28, gated by `tests/contract`.
   Done: phase 22 moved Pi to 1.4.0, see [0009](0009-pi-1.4.0.md).
4. TypeScript 5.9.3, not 7.x: the 7.0 native compiler is under one year old and drizzle-kit and vitest tooling have not been verified against it.
5. Python dependencies in `services/pseudo-svc` follow the same 7-day rule; release dates are checked on PyPI before pinning.

## Consequences

- Version pins in this repo lag `latest` by at least a week on purpose.
- Review happens before commit, so `git log` is the PR log.

## Verified on

2026-10-25, by querying `registry.npmjs.org` directly with curl.
