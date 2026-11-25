# LMFPD Snapshot Auto-Sync

## 1. Scope / Trigger

This covers upstream acquisition, validation, five-file publication, Pages and browser snapshots.
Apply to CLI/schema/permissions/deploy/cache changes; counts/sizes may evolve. Failed candidates preserve the site.

## 2. Signatures

Run from the repository root; replace `SHA` with a full 40-hex upstream commit:

```text
node scripts/sync-lmfpd.mjs --latest
node scripts/sync-lmfpd.mjs --ref SHA [--upstream LOCAL_REPO]
node scripts/sync-lmfpd.mjs --latest --artifact-root DIR --result-file FILE
node scripts/sync-lmfpd.mjs --verify-only [--artifact-root DIR] [--upstream LOCAL_REPO]
node scripts/publish-lmfpd.mjs --base-sha SHA --artifact-root DIR --upstream-ref SHA --version-sha256 HASH [--output FILE]
```

- `scripts/sync-lmfpd.mjs`: `sync(options, { root, build } = {})` returns `{ upstream_ref, changed }`;
  `verifyArtifacts(paths, { conformance, expectedVersion = null, allowLegacy = false })` returns `{ ok, checks, rows, info }`.
- `scripts/lib/lmfpd-sync-validation.mjs`: `validateDetectorBinary(bytes)`, `validateBank(bank)`,
  `validateDetector(detector, bank)`, `validateConformance(suite, bank, detector)`;
  `prepareOutputs(outputs, strict, api)`, `canonicalAnalysis(actual)`, `compareSemantic(actual, expected, key)`.
- `scripts/publish-lmfpd.mjs`: `validateCandidate(options)` returns `{ files, version }`;
  `publishCandidate({ artifactRoot, baseSha, upstreamRef, versionSha256, repo? })` returns
  `{ status: 'published' | 'unchanged' | 'stale', changed, deploySha }`.
- `.github/workflows/sync-lmfpd.yml`: **Sync LMFPD snapshot**, jobs `candidate` → `commit` → `deploy`.
- `.github/workflows/static.yml`: **Deploy static content to Pages** accepts
  `workflow_call.inputs.ref: string` (required full lowercase SHA), normal `main` push, or manual dispatch.

## 3. Contracts

**Runtime and selection.** CI uses Ubuntu and Node 24; create `/tmp/opencode` before staging/tests.
Builds use `npx --yes esbuild@0.28.2`, with no new dependency manifest. `--latest` resolves
`Ikaleio/lm-detector`'s default branch once and is exclusive with `--ref`, `--upstream`, and `--verify-only`.
Without a selector, use the current VERSION's `upstream_ref`. Local `--upstream` uses
`git show SHA:path`, never working-tree bytes. Remote raw/API fallback retains the same SHA.
Sources, bank, detector, LICENSE and `sdk/conformance/analyze.json` must all come from that SHA.
`--conformance FILE` is only a controlled offline override, unused by CI; never regenerate expected to accept a candidate.

**Output boundary.** Without `--artifact-root`, publish locally after validation; with it, DIR is
separate from project artifacts and new or empty, containing repository-relative paths.
`--result-file` is fresh and outside DIR, including symlink aliases; success writes an object with
full-SHA `upstream_ref` and boolean `changed`, comparing all five files' bytes with the project baseline.
`--verify-only` reads the chosen artifact root and its manifest SHA, never publishes a result/file update;
an optional `--ref` must match that manifest. Both new manifest hash fields may be absent in legacy
verification; new builds/publication require both. Exactly these five files may be auto-committed:

```text
assets/data/lmfpd/shared_detector.bin
assets/data/lmfpd/models.json
assets/data/lmfpd/VERSION.json
assets/vendor/lmfpd/lmfpd-core.js
assets/vendor/lmfpd/LICENSE
```

**Manifest and format.** VERSION contains `upstream: 'Ikaleio/lm-detector'`, lowercase full
`upstream_ref`, parseable `built_at`, positive safe integer `model_count`, `license: 'MIT'`, and lowercase
64-hex `detector_sha256`, `models_sha256`, `bundle_sha256`, `license_sha256` matching actual bytes.
Bank schema is `robust-number-fingerprint-bank`; detector schema is `shared-detector-v2`.
Preserve ordered unique model IDs, response counts, dimensions, build-time bindings and calibration
provenance. Binary decoding validates the little-endian u32 JSON-header length, zero alignment padding,
byte-plane float32 payload, finite values, and complete nonoverlapping bounded references.
Keep MIT grant/disclaimer and `Copyright (c) 2026 xqy2006`, including historical test provenance.

**Executable gate.** Candidate `window.LMFPD` exports `generateChallenges`, `parseNumbers`,
`decodeDetector`, `analyzeSharedOutputs`; preserve minimum 80 valid numbers and 3 recommended queries.
Its decoder must match the independent codec. All nonempty same-SHA conformance cases must bind
`data.built_at`, detector `base_sha256`, and ranked model IDs/count. SDK input normalization validates
1–3 outputs with string `text` and positive safe integer `expected_count`; non-strict mode truncates
excess numbers, and fewer than `max(80, ceil(expected_count * .55))` clears the text.
Analyze with `allowPartial: !strict` and apply only the explicit SDK canonical/default/English adapter.
Compare complete key sets, every ranking entry/order, scores, probabilities, calibration, diagnostics,
sequence, evidence and model version. Numeric tolerance is
`abs(a-b) <= 1e-9 * max(1, abs(a), abs(b))`; reject nonfinite values and extra/missing keys.

**Jobs, environment and permissions.** Schedule `17 3 * * *` is UTC 03:17 / Beijing 11:17;
`workflow_dispatch` is also supported on `main`. Sync concurrency is `lmfpd-sync-main`, without cancellation.

| Job | Permission / inputs | Required behavior |
| --- | --- | --- |
| `candidate` | `contents: read`; checkout credentials disabled | Run trusted tests and candidate code only here; emit `base_sha`, `upstream_ref`, boolean `changed`, `version_sha256`, immutable `artifact_id`. |
| `commit` | `contents: write`; separate clean exact-base runner | Download by artifact ID; trusted byte validator checks allowlist, regular files, sizes, VERSION digest, four hashes, metadata/header and MIT notice. Never load/eval candidate JS. |
| `deploy` | `contents: read`, `pages: write`, `id-token: write` | Explicitly call reusable Pages workflow with `commit.outputs.deploy_sha` when nonempty. |

Publisher byte limits: detector 256 MiB, models/bundle 32 MiB each, VERSION/LICENSE 64 KiB each.
Candidate step env: `ARTIFACT_ROOT`, `RESULT_FILE`; publisher step env: `BASE_SHA`, `UPSTREAM_REF`,
`VERSION_SHA256`, `ARTIFACT_ROOT`. Publisher `--output` falls back to `GITHUB_OUTPUT` and appends
`deploy_sha=...`; errors emit no deployment SHA. `LMFPD_DEBUG` enables sync stack traces;
`NODE_USE_ENV_PROXY=1` at process start opts Node fetch into configured proxy variables.
Use repository `GITHUB_TOKEN` plus Pages OIDC, no personal PAT. Repository/organization policy must
allow write permission, main rules must allow the bot's normal fast-forward push, and Pages Source
must be GitHub Actions; full automation also requires no human approval in `github-pages`.

Publisher checks HEAD/remote main against `baseSha`, rechecks during validation/before normal push,
and checks the resulting remote SHA. A race returns `stale` with empty `deploySha`; never force/rebase.
Unchanged bytes return base SHA without an empty commit for recovery deployment. Explicitly call
Pages: `GITHUB_TOKEN` pushes do not retrigger push. All actual Pages jobs share the `pages` lock,
`cancel-in-progress: false`; check main after lock acquisition and before deploy, skipping stale targets.

**Pages package.** After Setup Pages, create a fresh `$RUNNER_TEMP/apitest-site` directory and copy
only `index.html`, `assets/`, `CNAME`, `.nojekyll`, and `LICENSE`, preserving relative paths and bytes.
Upload that directory with the existing Pages artifact action. Do not upload the repository root:
tests/fixtures, scripts, proxy sources, `.trellis`, `.opencode`, and other development files are excluded.
Missing required inputs or an existing staging directory must fail before upload. Retain action
versions, permissions, environment, concurrency and exact-SHA/main guards when changing packaging.
Local package validation does not establish Pages service acceptance or diagnose a backend HTTP 500.

**Browser boundary.** On fingerprint activation, fetch VERSION with `cache: 'no-store'`, validate it,
and pin the acquired snapshot for this page. Core URL uses bundle hash and SRI (legacy SHA fallback);
metadata/detector URLs use their hashes, with Web Crypto verification before parse/decode.
Cache key is `built_at:detector_sha256`; verify memory/IndexedDB hits too. Ignore a corrupt key and
attempt one fresh download, never reuse corrupt bytes; unavailable storage falls back to memory.
An acquisition failure may retry VERSION; subsequent retries retain the pinned manifest/core.
Refresh adopts a new snapshot. Preserve visible retry errors and controller/run cancellation epochs.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Bad selector, short SHA, unsafe/nonempty output, existing result | Nonzero exit with contextual error; do not publish a candidate/result. |
| Network failure, stale fixture, schema/API/MIT drift, invalid float/reference, conformance difference | Reject before publication; preserve existing five artifacts and deployed site. |
| Candidate extra path/symlink, VERSION digest mismatch or any hash mismatch | Trusted publisher rejects; no commit/push/deployment SHA. |
| Main advances / normal push denied | Race skips deployment; permission failure exits nonzero. Actions step summary directs inspection; next run uses current main. |
| No byte changes | No empty commit; emit valid base SHA for redeployment. |
| Obsolete Pages target | Skip after lock/current-main checks. |
| Missing required website input or existing Pages staging directory | Fail staging; do not upload an incomplete or stale package. |
| Browser bad manifest, bundle SRI or data hash/binding failure | Visible retry state, no scoring with mixed data; unrelated page features remain available. |

## 5. Good / Base / Bad Cases

- **Good:** a new full SHA passes matching conformance; count/size can grow. Commit the five artifacts and deploy.
- **Base:** identical current-SHA rebuilds keep five stable files and `changed: false`; redeploy for recovery.
- **Bad:** newer bank/detector plus older fixture `built_at`/base hash/model set; reject and retain the site.

## 6. Tests Required

```bash
node --test tests/sync-lmfpd*.test.mjs tests/lmfpd-publish*.test.mjs
node --test tests/lmfpd-loader.test.mjs
node scripts/sync-lmfpd.mjs --verify-only
node tests/lmfpd-loader.e2e.mjs
node tests/proxy-browser.e2e.mjs
git diff --check
```

- Keep five immutable historical artifacts in `tests/fixtures/lmfpd-sync/supported/` with matching
  `analyze-supported.json`, independent of production/Git history; assert hashes, unchanged expected, legacy/full acceptance and mutation rejection.
- Exercise two consecutive future updates: each candidate binds its own same-SHA fixture, passes
  validation, changes only production artifacts, then the next daily preflight still passes. Historical
  conformance must reject a later snapshot; do not pair frozen fixtures with rolling production files.
- Cover immutable local reads, same-SHA network fallback, deterministic/no-change outputs, unsafe
  paths, all export/schema/license gates, rank/probability/calibration differences and failed publication.
- Publisher/workflow tests assert byte-only validation, exact allowlist/digests, no candidate execution,
  denied pushes/main races, permission isolation, explicit reuse, shared lock and stale target guards.
- Execute the actual Pages staging shell with quoted paths; compare all runtime bytes and resource
  paths, verify fingerprint hashes, exclude development files, and reject missing inputs/stale output.
- Loader unit and real Chrome tests assert initial lazy loading, version/hash URLs, actual SRI/Web
  Crypto/IndexedDB verification, mixed/corrupt bytes, storage fallback, retry and fixed-page snapshot.
  Chrome defaults to `/usr/bin/google-chrome` (`APITEST_E2E_CHROME` overrides it). Cover manual scoring,
  sampling and cancellation with local mocks, without API credits or claims of an actual Actions/deploy run.

## 7. Wrong vs Correct

- **Wrong:** loosen fixture bindings, compare only the winner, or recompute expected to accept HEAD.
  **Correct:** retain the deployment until all same-SHA cases and full semantic checks pass.
- **Wrong:** execute candidate JS in the write job, rely on bot push to trigger Pages, or force-push.
  **Correct:** use trusted byte validation, an exact deployment SHA, explicit Pages reuse and stale guards.
- **Wrong:** roll back only the detector or replace a core during scoring.
  **Correct:** pause sync, restore all five via a normal commit, redeploy, and refresh for a new page snapshot.
- **Wrong:** upload the entire checkout as the public website.
  **Correct:** stage only the runtime allowlist; validate the package before uploading it.
