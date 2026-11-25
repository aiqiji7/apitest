# Real sync CLI verification

Verified on 2026-11-25, 15:00:33-15:01:34 UTC, using the actual repository CLI
and public GitHub resources. No crafted fixture or conformance override was used.

## Transport and execution boundary

- Node v24.16.0; child processes started with `NODE_USE_ENV_PROXY=1` to use
  the existing HTTP(S) proxy. Proxy values and credentials were not printed.
- `npm_config_offline=true` restricted the build to the already cached
  `esbuild@0.28.2`; no dependency download or global setting change was made.
- Positive and negative CLI runs used separate fresh output paths under the
  exact owned directory `/tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p`.
- Each run had a 165-second process-group timeout; neither timed out.
- No application source, production artifact, upstream expected result,
  workflow, Git commit, push, workflow dispatch, or deployment was changed.

The earlier available local upstream directory did not resolve the supported
commit, so it was not used as evidence. Both commands used the CLI's public
GitHub download route. The CLI can try raw.githubusercontent.com and the
official contents API at the same fixed SHA; this run did not instrument which
per-file fallback succeeded.

## Commands

Run from `/home/jie/project/apitest`:

```bash
NODE_USE_ENV_PROXY=1 npm_config_offline=true node scripts/sync-lmfpd.mjs \
  --ref 1e58ed83c1cde17f88cba89560ad4d083042ae92 \
  --artifact-root /tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/supported-candidate \
  --result-file /tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/supported-result.json

NODE_USE_ENV_PROXY=1 npm_config_offline=true node scripts/sync-lmfpd.mjs \
  --latest \
  --artifact-root /tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/latest-candidate \
  --result-file /tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/latest-result.json
```

These exact paths have now been used. A repeat must choose fresh candidate and
result paths, as required by the CLI.

## Positive result: supported commit, no update

- Exit code: **0**, elapsed about 57.6 seconds.
- Actual upstream SHA: `1e58ed83c1cde17f88cba89560ad4d083042ae92`.
- All **24/24** checks passed, including all 12 same-snapshot conformance cases,
  public exports, sample80/3, independent decoder comparison, and all hashes.
- Result: `{"upstream_ref":"1e58ed83c1cde17f88cba89560ad4d083042ae92","changed":false}`.
- The output contains exactly the five allowed artifacts. Every file is
  byte-identical to production and to the prior real rebuild at
  `/tmp/opencode/lmfpd-sync-supported-20261125/candidate`.

## Negative result: actual latest rejected before build

- Exit code: **1**, elapsed about 60.5 seconds.
- `--latest` actually resolved the default branch to
  `e0472890bea827d15ca883636a77d4c10bbe843b`.
- Exact error:

```text
Conformance built_at binding mismatch: 2026-11-17T19:37:59.839365+00:00 vs 2026-11-23T06:25:02.164646+00:00.
```

- No `Building lmfpd-core.js` or publication stage was reached. The actual CLI
  validates the downloaded bank/detector/conformance binding before staging
  upstream source or invoking the candidate build.
- Neither `latest-candidate` nor `latest-result.json` exists.

## Production and source stability

The runner hashed every production artifact before execution, after each CLI
exit, and after both runs. All three observations were identical:

| Artifact | SHA-256 |
| --- | --- |
| `assets/data/lmfpd/shared_detector.bin` | `6a102f86c3f8a9aeeb052edfbdf5edf6f9e891ac6693129a4e007139c74861f6` |
| `assets/data/lmfpd/models.json` | `50a5eb5cda7e0a5eb75ecd5513a865b54a8b9498433f3e039ecc70ff7d85ba4d` |
| `assets/data/lmfpd/VERSION.json` | `e63701f78d5ef0274df455f4930ccc49155bda4705a07915ce4423f6b657c9c0` |
| `assets/vendor/lmfpd/lmfpd-core.js` | `091e84c2842283a967334cd18519e03c3b5185ae3bdbb27fc75b4eecfffd9496` |
| `assets/vendor/lmfpd/LICENSE` | `238afb57e498990742f84b9ce6167b4e256ac06104a9938ce953bc41c14bea51` |

The syncer and validator also remained unchanged during execution:

| Source | SHA-256 |
| --- | --- |
| `scripts/sync-lmfpd.mjs` | `677eb201685b7be65516b8e35e0505ec9e620db98adbbcfe745aac227f3ef596` |
| `scripts/lib/lmfpd-sync-validation.mjs` | `1688a6ad25adaefebe23a99edca8d522289e4387b07aa9e82dcb8915baaab493` |

## Retained evidence

All five integration assertions passed:

1. Supported CLI exits zero and reports `changed=false`.
2. Exactly five candidate files match production and the previous real rebuild.
3. Actual latest resolution fails the expected binding check before build and
   publishes no candidate or success result.
4. All five production files remain unchanged after both runs.
5. Syncer and validator source remain frozen.

Evidence root: `/tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/`.

- `report.json`: commands, timestamps, exit codes, all hashes and assertions.
- `supported-no-update.log`: full actual CLI positive/conformance output.
- `actual-latest-negative.log`: actual latest SHA and exact rejection.
- `supported-result.json` and `supported-candidate/`: positive output bytes.
- `run.mjs`: bounded integration runner; `progress.json`: recorded terminal state.

This establishes real public-network CLI behavior locally. It does not establish
remote GitHub Actions execution, branch permission behavior, Pages deployment,
or successful adoption of a newer upstream release.
