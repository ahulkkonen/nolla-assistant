# Supply-chain audit of dependencies: assistant-2 (`main`, commit e009029)

Status: snapshot of 2026-10-31. Later work fixed or accepted the findings, see
[phase 30](../decisions/phase-30-audits.md) and [phase 35](../decisions/phase-35-security-fixes.md).
The cited paths and line numbers are as of the audit date.

**Verdict: clean. No package to remove now.** No installed package is malicious, compromised, typosquatted or a known campaign version. The follow-up actions below are hardening and advisory upgrades. None of them is a removal.

Date of the audit: 2026-10-31.

## Counts of packages checked

| Ecosystem | What | Count |
|---|---|---|
| npm | `pnpm-lock.yaml` package entries (main document 1245 + pnpm self-install document 15) | 1260 |
| npm | unique package names | 1156 |
| npm | direct (non-workspace) dependencies across 19 `package.json` files | 66 |
| npm | installed package directories under `node_modules/.pnpm` (scanned for behaviour) | 1082 (1075 in the lock + 7 orphans) |
| npm | text files scanned in installed packages | 34316 |
| PyPI | `services/pseudo-svc/requirements.lock` packages (all hash-pinned) | 64 |
| PyPI | local dev venv `services/pseudo-svc/.venv` packages (scanned) | 27 (3 of them dev-only: pytest, pluggy, iniconfig) |
| Container | base images and compose images | 9 references (7 digest-pinned, 2 tag-only) |

## 1. Known-bad lists

Sources checked against every name and version in `pnpm-lock.yaml`:

- `pnpm audit --json` (npm advisory feed): 22 advisories, 0 malware. 5 high, 11 moderate, 6 low.
- OSV `querybatch` for all 1260 `name@version` pairs (it includes GHSA and the OpenSSF `MAL-*` malicious-package feed): 0 `MAL-*` hits. The 11 vulnerable versions are the same as `pnpm audit`.
- OSV by name, any version: 7 names in the tree have had a malicious release in the past. The installed version is never the bad one:

| Package | Installed | Malicious version | Campaign / source |
|---|---|---|---|
| chalk | 6.0.0 | 5.6.1 | qix maintainer phishing, 2025-09-08 (MAL-2025-46969) |
| debug | 4.4.3 | 4.4.2 | same (MAL-2025-46974) |
| ansi-styles | 6.2.3 | 6.2.2 | same (MAL-2025-46967) |
| ansi-regex | 6.4.0 | 6.2.1 | same (MAL-2025-46966) |
| strip-ansi | 7.2.0 | 7.1.1 | same (MAL-2025-46980) |
| wrap-ansi | 9.0.2 | 9.0.1 | same (MAL-2025-46983) |
| fsevents | 2.3.3 | <1.2.11 | 2023 (MAL-2023-462) |

- Wiz IOC list, Shai-Hulud 2.0 (795 packages, `wiz-research-iocs/reports/shai-hulud-2-packages.csv`): 0 matches.
- Wiz IOC list, keyv / "ChainDrop" worm, August 2026 (446 packages, `keyv-packages.csv`): 0 matches.
- DataDog malicious-software-packages-dataset, npm manifest (48561 names): 0 version matches (only the 6 qix names above, other versions).
- Manual list from public write-ups: eslint-config-prettier / eslint-plugin-prettier / synckit / @pkgr/core / napi-postinstall / is / got-fetch (July 2025), @ctrl/tinycolor (Shai-Hulud 1, Sept 2025), nx / @nx (s1ngularity, Aug 2025), axios 1.14.1 / 0.30.4 (March 2026), keyv / flat-cache / cacheable (Aug 2026). Name-prefix sweep for @antv (Mini Shai-Hulud, Oct 2026), @tanstack (May 2026), @redhat-cloud-services, node-gyp worm families (@vapi-ai, autotel, @jagreehal), @bitwarden/cli, @duckdb, @sap, @postman, posthog, @zapier, @ensdomains, @asyncapi, @crowdstrike: none of these names is in the lock.
- Registry check of all 1260 entries: every version still exists on registry.npmjs.org (none unpublished or replaced by a security placeholder), and every lock `integrity` equals the registry `dist.integrity`.

Advisories (vulnerabilities, not malware). Recommended action: upgrade at the next dependency bump once a fixed version is at least 7 days old.

| Package | Version | Advisory | Severity | Path | Action |
|---|---|---|---|---|---|
| undici | 8.10.2 | GHSA-2m5v-pch6-74hx (TLS options dropped), GHSA-4w7w-5xrc-9h26, GHSA-xjj6-f33q-929c, GHSA-qrxm-fqhp-jwvm + 4 moderate | high | `@earendil-works/pi-coding-agent` > undici; `openai` > undici | Fixed in 8.12.2 (already used by `services/sandbox-broker`). Comes from Pi's own pin; wait for the next Pi release or add a `pnpm.overrides` entry `undici: 8.12.2` after the contract tests pass. |
| body-parser | 2.3.0 | GHSA-27r3-jxmh-p828 | high | Pi > @google/genai > @modelcontextprotocol/sdk > express | Fixed in 2.4.0. Express server of the MCP SDK is not used by the server at runtime; low exposure. |
| fast-uri | 4.2.2, 3.1.8 | GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp | moderate/low | fastify > ajv; MCP SDK > ajv | Fixed in 4.2.3 / 3.1.9. |
| glob | 11.1.0, 13.0.6 | GHSA-3g3m-2fjr-6pw4 | moderate | @fastify/static, workbox-build | Fixed in 14.0.2. |
| minimatch | 10.2.6, 5.1.9 | GHSA-g3hv-75wg-m249 | moderate | Pi, workbox | Fixed in 11.0.1. |
| esbuild | 0.18.20 | GHSA-67mh-4wv8-2f99 | moderate | packages/db > drizzle-kit > @esbuild-kit (dev only) | Dev server only; drizzle-kit is a dev tool. Accept. |
| serialize-javascript | 7.1.2 | GHSA-m5mm-p8h7-m29v | low | vite-plugin-pwa > workbox-build (build time) | Accept. |
| deepmerge | 4.3.1 | GHSA-gcqx-w48m-w2h4 | low | workbox-build (build time) | No fix exists. Accept. |

Resolved 2026-11-01: `undici` in the Pi tree is 8.12.3 (published 2026-10-19) through the scoped override `'@earendil-works/pi-coding-agent>undici': 8.12.3` in `pnpm-workspace.yaml`. pnpm 12 ignores `pnpm.overrides` in `package.json`. `services/sandbox-broker` keeps its own pin 8.12.2.

Deprecated versions in the lock (no security impact found): @esbuild-kit/core-utils 3.3.2, @esbuild-kit/esm-loader 2.6.5, glob 11.1.0, node-domexception 1.0.0, @smithy/core 3.36.0 (deprecated for a logger-redaction bug, aws-sdk-js-v3 issue 8393; reached through Pi's Bedrock provider, which this project does not use).

## 2. Typosquats and look-alikes

All 66 direct dependencies were checked on the registry for the publisher of the pinned version, the maintainers, the repository and the weekly downloads (`direct.json`). Each one is the canonical package, published by the expected account or by GitHub Actions with npm provenance, with 0.9 M to 600 M downloads a week. No direct name is a look-alike.

Names worth a note:

| Package | Version | Evidence | Verdict / action |
|---|---|---|---|
| cn | 0.5.0 | The name `cn` belonged to user `rumpl` (versions 0.1.0, 0.1.1, 2013, depended on `request`). Since 2026-09-01 it is published by GitHub Actions from `github.com/shadcn-ui/cn` (`.github/workflows/release.yml`, SLSA provenance verified on 0.5.0), maintainer `shadcn`, 17.5 M downloads a week, 0 dependencies, no install scripts. | Legitimate transferred name. Keep. Because the name changed owner recently, check the provenance again at each bump. |
| typebox | 1.3.27 | Maintainer `sinclair`, repo `sinclairzx81/typebox`, provenance. The 1.x line of `@sinclair/typebox` moved to the unscoped name. | Legitimate. |
| radix-ui | 1.8.1 | Repo `radix-ui/primitives`, provenance, 24.9 M a week. | Legitimate. |
| @huggingface/transformers | 4.3.1 | Published by `xenova` (the transformers.js author) without provenance. | Legitimate. |

Transitive packages from individual accounts that were checked by hand:

| Package | Version | Evidence | Verdict |
|---|---|---|---|
| @trickfilm400/rollup-plugin-off-main-thread | 3.0.0-pre1 | Required by `workbox-build@7.4.1` (upstream package.json: `^3.0.0-pre1`). A fork of `surma/rollup-plugin-off-main-thread` by one person, published by hand without provenance in 2025-12; 5.8 M downloads a week. `index.js` (318 lines) reads only local files and uses ejs and magic-string; no network, no env reads. | Not malicious. A single-maintainer pre-release in the build chain of the PWA. Accept; watch at each workbox bump. |
| @silvia-odwyer/photon-node | 0.3.4 | Required by Pi. Maintainer `silvia-odwyer`, repo `silvia-odwyer/photon`. `new Function` hits are wasm-bindgen glue. | Not malicious. |
| quickjs-wasi | 3.6.2 | Required by Pi (`pi-codemode`). Maintainers `tootallnate`, `adamdong`, repo `vercel-labs/quickjs-wasi`, provenance. | Not malicious. |
| onnxruntime-web / onnxruntime-common | 1.31.0-dev.2026091x | Nightly builds, required by @huggingface/transformers. Published by `microsoft1es`. | Expected (transformers.js pins ORT nightlies). |
| @google/genai | 2.21.0 | Maintainers `google-wombot`, `ofrobots`, `mrdoob`. | Legitimate Google package. |

Download sweep of all 1156 names (`downloads.json`, api.npmjs.org last week): every package has more than 98000 downloads a week. Only 8 names are under 200000, and all 8 are pnpm's own platform binaries (`@pnpm/exe.linux-s390x`, `android-x64`, `linux-ppc64`, `linux-riscv64`, `freebsd-x64`, `android-arm64`, `win32-arm64`, `darwin-x64`), which are optional and not installed on this machine. No low-traffic unknown package exists in the tree.

## 3. Lifecycle scripts

pnpm runs only `preinstall`, `install` and `postinstall` (and an implicit `node-gyp rebuild` when `binding.gyp` exists) for registry packages. It never runs `prepare` for a registry tarball. `strictDepBuilds: true` makes the install fail on any build script that `allowBuilds` does not list. `node_modules/.modules.yaml` records `allowBuilds` identical to `pnpm-workspace.yaml` and `pendingBuilds: []`.

| Package | Version | Script | allowBuilds | What the script does | Verdict |
|---|---|---|---|---|---|
| esbuild | 0.18.20 | `postinstall: node install.js` | true | Reads `ESBUILD_BINARY_PATH` and `npm_config_user_agent`. Resolves the platform binary from the `@esbuild/<platform>` optional dependency. Only when that package is missing: runs `npm install @esbuild/<platform>@<same version>` in a temporary folder inside the esbuild package, or downloads `https://registry.npmjs.org/@esbuild/<platform>/-/<platform>-<version>.tgz`. Writes only inside its own package folder. Runs `<binary> --version` to check the version. | Expected, safe. On this machine the optional package was present, so no network call ran. |
| esbuild | 0.25.12 | same | true | Same as above. Adds a SHA-256 check of the downloaded binary against `esbuild.binaryHashes` in its package.json. | Expected, safe. |
| esbuild | 0.28.2 | same | true | Same as 0.25.12 (full file read). | Expected, safe. |
| better-sqlite3 | 13.0.3 | none; ships `binding.gyp` with `"gypfile": false` | true | No script runs. The package ships prebuilt `prebuilds/*.node` files (published by GitHub Actions with provenance). No `build/` folder exists, so node-gyp did not run. | Safe. The `allowBuilds: true` entry is not needed for 13.x; keep it or set it to `false`, both are safe. |
| onnxruntime-node | 1.30.0 | `postinstall: node ./script/install` | false (blocked) | Would download optional CUDA / nightly binaries from `api.nuget.org` and `aiinfra.pkgs.visualstudio.com`, controlled by `ONNXRUNTIME_NODE_INSTALL*`. | Blocked. Binaries already ship in the package. Correct setting. |
| protobufjs | 7.6.6 | `postinstall: node scripts/postinstall` | false (blocked) | Reads its own and the parent `package.json` and prints a version-scheme warning. No network, no writes. | Harmless; blocked. Correct setting. |
| @google/genai | 2.21.0 | `preinstall: echo 'preinstall: no-op'` | false (blocked) | Prints a string. The same script is on the registry for 2.20.0 and 2.21.0, published by `google-wombot`. | Harmless; blocked. |

Packages with only `prepare` (never run for registry installs, listed for completeness): 65 entries, for example @axe-core/playwright, acorn, rollup, undici, uuid, glob, lru-cache, terser, signal-exit, mime. No action.

No installed package has a `preinstall` / `install` / `postinstall` that is not in the table above. No file named `setup_bun.js`, `bun_environment.js` or a root-level worm `bundle.js` exists in any package.

## 4. Behaviour scan of installed code

Scanner: `scan.py` over 1082 installed package folders (34316 `.js/.cjs/.mjs/.ts/.json/.sh/.py` files, `.d.ts` and maps skipped). Categories and judgement:

| Category | Packages hit | Judgement |
|---|---|---|
| Worm / exfiltration indicators (`trufflehog`, `webhook.site`, `/-/whoami`, `/-/npm/v1/tokens`, wallet files, Discord/Telegram webhooks, paste and tunnel hosts, `169.254.169.254`, `.npmrc`, `id_rsa`) | 20 | All benign: cloud-SDK instance-metadata clients (@smithy, google-auth-library, gcp-metadata, openai Azure/GCP token providers, Pi's bundled AWS SDK, drizzle-kit's bundled AWS SDK); X.509 OIDs named `id_rsa*` (@peculiar/*, @simplewebauthn/server); SSRF test strings (fast-uri tests, ip-address and playwright docs); vite's `fs.deny` list naming `.npmrc`; the substring "oast." in "toast." (sonner, radix-ui); a word list containing "exodus" (drizzle-kit). |
| `child_process` | 55 | All expected: CLIs and bundlers (esbuild install, vite, vitest, rollup, rolldown, tsx, typescript, playwright, marked, commander, jake/ejs jakefile, why-is-node-running), native loaders (sharp, detect-libc, @tailwindcss/oxide), SDK credential helpers (@aws-sdk/credential-provider-process, google-auth-library gcloud call), Pi's bash tool and MCP stdio transport, node-cron `fork` for background tasks, tests and benchmarks shipped in the tarball (fastify, pino, avvio, mammoth). |
| `process.env` reads of token-like names | 20 | All read the provider's own documented variable: ANTHROPIC_API_KEY (@anthropic-ai/sdk), OPENAI_API_KEY / AZURE_* (openai), AWS_* (AWS SDK, google-auth-library AWS federation), MCP_CLIENT_SECRET (MCP SDK), GCM_API_KEY (web-push), GITHUB_ACTIONS / GITHUB_SHA (vitest, playwright reporters), COPILOT_* (vite agent detection), GITHUB_TOKEN only in fastify's shipped `scripts/validate-ecosystem-links.js` (a maintainer script, never imported). No package sends an env value to a host. |
| Whole-env dumps (`JSON.stringify(process.env)`, `Object.keys(process.env)`) | 10 | Expected: child-process env construction (Pi bash sandbox env, @anthropic-ai/sdk agent toolset, playwright, vite, jiti), `debug` reading `DEBUG_*`. |
| `fetch` / `http.request` to hard-coded hosts | 10 | Docs and localhost examples, plus one real call: Pi `reportInstallTelemetry` (see the note below). |
| `eval` / `new Function` | 41 | All are code generators or sandboxes with local input: ajv, fast-json-stringify, find-my-way, depd, ejs, underscore/es-toolkit templates, tapable, vega expression compiler, d3-dsv, sucrase, terser, axe-core, emscripten/wasm-bindgen glue (onnxruntime-web, @huggingface/transformers, photon-node), quickjs-wasi option docs, real-require dynamic import. None reads network input into `eval`. |
| Long base64 / hex blobs | 21 / 3 | Inline WebAssembly (undici llhttp, es-module-lexer, cjs-module-lexer in tsx/drizzle-kit/@esbuild-kit, vite hash wasm, Pi's bundled undici), source maps, data-URI images (lucide-react docs, cytoscape demo, playwright report), colour tables (d3-scale-chromatic), compiled class tables (`cn` `dist/tables.js`), a test font (unpdf/pdf.js). |
| `String.fromCharCode` chains, `_0x` obfuscator patterns | 0 | None. |
| Native binaries and wasm | 28 packages | All come from the package's own published tarball and match an upstream source project: @biomejs/cli-darwin-arm64, @esbuild/darwin-arm64 x3, esbuild bin x3, @img/sharp*, @rolldown/binding, @rollup/rollup-darwin-arm64, @tailwindcss/oxide, lightningcss x2, better-sqlite3 prebuilds, onnxruntime-node, onnxruntime-web, sqlite-vec, fsevents, @earendil-works/pi-tui native clipboard helpers, photon-node wasm, quickjs-wasi wasm, source-map wasm, playwright webp wasm, Pi's example `doom.wasm`. |

Notes that need a decision but no removal:

- **Pi install telemetry.** `@earendil-works/pi-coding-agent@1.4.0`, `dist/modes/interactive/interactive-mode.js`: on a fresh install or a version change, the interactive TUI mode sends `GET https://pi.dev/api/report-install?version=<version>` with a Pi user agent. It sends no other data. It is skipped when `PI_OFFLINE` is set or the install-telemetry setting is off. The server uses the SDK, not the interactive mode, so the call should not run in production. Action: set `PI_OFFLINE=1` in the server and container env as a guard for invariant 2 ("one egress URL").

## 5. Integrity

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile --offline --ignore-scripts` | Passes (`resolved 1071, reused 1071, downloaded 0`, exit 0). Run in a temporary copy of the manifests and lock against the same store, so the repository was not changed. |
| `pnpm store status` (installed files against the content-addressable store) | "Packages in the store are untouched", exit 0. |
| `integrity` present for every lock package | Yes, 1260 of 1260 (`sha512`). All 1260 equal the registry value. |
| `git+`, `github:`, `file:`, `http:`, `tarball:` or `npm:` alias sources | None. Only `link:` entries for the workspace packages. |
| Specifiers pinned by a tag or a range | None. Every importer specifier is an exact `x.y.z` or `workspace:*`. `.npmrc` has `save-exact=true`, `savePrefix: ''`. |
| Overrides, patches, `.pnpmfile.cjs` | None. |
| `minimumReleaseAge: 10080` (7 days) | Youngest packages: `@earendil-works/pi-*@1.4.0` and `pnpm@12.15.0` / `@pnpm/exe.*` published 2026-10-21, 9 days old today; they were pinned on 2026-10-29 at 8 days. No package is younger than 7 days (dates from deps.dev). |

Container images (`infra/`):

| Image | Pin | Finding | Action |
|---|---|---|---|
| `node:22.23.2-bookworm-slim` (Dockerfile.server, Dockerfile.broker) | tag only | Not pinned by digest; a re-pushed tag changes the build. | Add `@sha256:` digests, as the other Dockerfiles do. |
| `RUN npm install -g corepack` (Dockerfile.server, Dockerfile.broker) | no version | Installs the newest `corepack` from npm at build time. npm does not apply `minimumReleaseAge`, so a compromised release would be picked up the same day. | Pin `corepack@<version older than 7 days>`, or use the corepack that Node 22 bundles and drop this line. |
| `python:3.12.14-slim-trixie@sha256:f77ac9…`, `debian:bookworm-20261005-slim@sha256:7c7b2c…`, `litestream/litestream:0.5.17@sha256:4b02b9…`, `restic/restic:0.19.1@sha256:136600…` | digest | OK. | None. |
| `ghcr.io/berriai/litellm:v1.105.1@sha256:b7b9e2c3…` (compose) | digest | LiteLLM had a PyPI and Docker compromise on 2026-10-21 (v1.107.0, `latest`, `main-latest`, `main-stable`; malicious digest `sha256:1bbcb144…`) and a PyPI-only compromise on 2026-03-24 (1.82.7, 1.82.8). The pinned v1.105.1 is not an affected tag, and the pinned digest equals the digest GHCR serves for `v1.105.1` today (checked 2026-10-31), so the tag was not re-pushed. | None. Do not move to `latest`; skip 1.107.0. |
| `mcr.microsoft.com/presidio-analyzer:2.2.362@sha256:…`, `presidio-anonymizer:2.2.362@sha256:…`, `ghcr.io/taylorwilsdon/google_workspace_mcp:2.1.0@sha256:…` | digest | OK. The MCP image comes from a single developer's account. | None. |
| Dockerfile.pseudo downloads | sha256 | spaCy `fi_core_news_lg-3.8.0` wheel and the Omorfi model archive are checked with `sha256sum -c`. The build stage installs `curl xz-utils ca-certificates` from apt without version pins (build stage only). | None. |

## 6. Python (`services/pseudo-svc`)

| Check | Result |
|---|---|
| Lock format | `uv pip compile --universal --python-version 3.12 --exclude-newer 2026-10-18 --generate-hashes`. 64 packages, every one with `--hash=sha256:`; Dockerfile.pseudo installs with `pip install --require-hashes`. No URL, VCS, `file:` or editable entry. |
| Hashes against PyPI | Every hash in the lock matches a file PyPI publishes for that version (0 unknown hashes). No pinned file is yanked. |
| Install-time code | Every package has a wheel for CPython 3.12 on both linux x86_64 and aarch64 (or a `py3-none-any` wheel), so pip never builds an sdist and no `setup.py` runs in the image. |
| Known malware | OSV `MAL-*` for the 64 names (any version): 0. |
| Advisories (OSV / PyPI advisory DB; `pip-audit` is not installed) | `cryptography 48.0.1` (via presidio-anonymizer): GHSA-g6cj-pr64-35w5 (high, PKCS#7 decryption oracle, fixed 50.0.0), GHSA-jwv3-5hgf-82ww (high, path-building DoS, fixed 49.0.0), GHSA-m2h6-j472-rp4c (moderate, name constraints, fixed 49.0.0). The service does not use PKCS#7 or X.509 path building, so exposure is low. Action: bump cryptography in the next lock refresh. `setuptools 84.0.0`: GHSA-xmj3-9gf7-h52w (low, Windows only, fixed 84.1.0). Accept. |
| Publishers | All 64 are the canonical projects (Explosion for spaCy and its stack, Microsoft Presidio, tiangolo, Pydantic, encode, PyCA, Flammie A Pirinen for omorfi, Harri Pitkänen for libvoikko, Charles Leifer for sqlcipher3, Khalid Alnajjar and Mika Hämäläinen for pyhfst). No look-alike names. |
| 7-day rule | `--exclude-newer 2026-10-18` included `starlette 1.9.0` (uploaded 2026-10-18 15:50 UTC) and `certifi 2026.10.18` (2026-10-18 16:21 UTC). uv reads a bare date as the end of that day, so these two were about 6.5 days old when the lock was made on 2026-10-25. They are 13 days old now and clean. Action: pass a full timestamp, for example `--exclude-newer 2026-10-18T00:00:00Z`, next time. |
| Local dev venv | 27 packages; 24 match the lock exactly. `pytest 9.1.1`, `pluggy 1.7.0`, `iniconfig 2.3.1` are the dev group and are not hash-locked (OSV: clean). The only `.pth` file is `_virtualenv.pth` (`import _virtualenv`, standard). Behaviour scan (`pyscan.py`): only expected `subprocess` use (pytest, click, anyio, packaging, pydantic git helper, pygments generators); 2 native binaries (`sqlcipher3/_sqlite3*.so`, `pydantic_core/*.so`) from their wheels. |

## Recommended actions (none is a removal)

1. Pin `node:22.23.2-bookworm-slim` by digest and pin or drop `npm install -g corepack` in `infra/Dockerfile.server` and `infra/Dockerfile.broker`.
2. Set `PI_OFFLINE=1` for the server (local dev and container) so Pi's install ping can never leave the box.
3. Upgrade `undici` past 8.12.2 inside the Pi tree (next Pi release or an override), and `cryptography` to 50.x in `requirements.lock`, when the fixed releases are at least 7 days old.
4. Use a full UTC timestamp for `uv pip compile --exclude-newer`.
