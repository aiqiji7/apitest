# Design: LMFPD 自动同步

## Boundaries

Three jobs: `candidate` (contents:read, checkout credentials disabled) builds and executes upstream code only here; `commit` (contents:write, separate runner) handles validated files as bytes and never executes the candidate bundle; `deploy` (contents:read + pages:write + id-token:write) explicitly calls the reusable Pages workflow. No PAT or remote setup changes.

Auto-sync schedule defaults to `17 3 * * *` (UTC03:17 / 北京11:17), with workflow_dispatch. Scheduler delay/inactivity rules are documented. A single sync concurrency group serializes update jobs; all actual Pages deploy jobs share `pages`, cancel-in-progress:false. Once the Pages lock is acquired, compare candidate ref against current main, and check again before deploy. Skip stale commits.

## CLI contract shared by lanes

```text
node scripts/sync-lmfpd.mjs --latest --artifact-root DIR --result-file FILE
node scripts/sync-lmfpd.mjs --ref SHA --artifact-root DIR --result-file FILE
node scripts/sync-lmfpd.mjs --verify-only [--artifact-root DIR]
```

DIR contains repository-relative paths; FILE is outside DIR. Success JSON contains at least `{ upstream_ref, changed }`; errors exit nonzero and do not publish candidates/results as success. `--latest` and `--ref` mutually exclusive. Default no-ref manual behavior uses current manifest SHA, not an outdated source constant. Retain `--upstream` and `--conformance` compatibility; local git sources must be read from immutable Git objects at specified SHA, no silently trusted dirty working copy.

Allowed artifacts exactly:

```text
assets/data/lmfpd/shared_detector.bin
assets/data/lmfpd/models.json
assets/data/lmfpd/VERSION.json
assets/vendor/lmfpd/lmfpd-core.js
assets/vendor/lmfpd/LICENSE
```

VERSION retains existing fields and adds `bundle_sha256`, `license_sha256`. `changed` compares all five bytes against project artifacts, not timestamps. CI publishes candidate output into separate artifact directory only; manual usage may publish locally after all validation. First migration rebuilds current supported SHA and validates it before adding hashes; current bad upstream HEAD must not replace it.

## Validation

Resolve upstream default branch once to complete SHA; read all sources/data/fixtures at that SHA. Use pinned esbuild0.28.2 already present in tool workflow. Verify header/array schema, field/ID/order/count/built_at bindings, valid binary refs and finite values, integrity hashes and MIT license, public exports and sample80/3 contract. Replace old exact binary-length/model-prediction expectations with complete nonempty same-snapshot conformance suite. Normalize SDK preprocessing and English presentation/default fields exactly or explicitly compare full semantic fields while excluding only proven SDK presentation strings. Never copy expected values into actual or regenerate fixtures. Real latest invalid fixture is expected rejection, not a reason to relax validation.

## CI publication/deployment

Candidate outputs base_sha/upstream_ref/changed/artifact ID/version digest. Commit job checks current main still equals base_sha; downloads immutable candidate artifact by ID, validates exact file allowlist/no symlinks/regular files, manifest fields plus four hashes and expected manifest digest with trusted repository code. Do not execute upstream bundle here. Only then stage those five paths, commit if different and normal push; no force/rebase. No changes produces current valid base SHA for redeploy recovery. Main conflict returns empty deploy SHA and skips.

Extend static.yml with workflow_call ref input. Reuse existing Pages configure/upload/deploy steps rather than a second divergent deployment. Checkout exact full SHA; stale guard under pages lock prevents older queued build overriding new main. Existing push/manual deployment remains. Read-only local verification does not claim Actions or deployment actually ran.

## Browser loading

Version-first lazy snapshot acquisition. Core query uses bundle hash (legacy ref fallback for current manifests), SRI checks declared bundle hash; models and detector query hashes and verify actual bytes via SHA-256 (including IDB hits). Validate shapes before score. A common snapshot promise fixes page lifetime version; retries use same version, page refresh adopts new deployment. Avoid ensureCore/loadData recursion and preserve activation/run epoch guards. Corrupt cached data may be evicted and refetched once; fresh mismatched bytes fail with existing visible retry UI. No UI redesign or new polling.

## Work lanes / dependencies

1. Syncer fixer: scripts/sync-lmfpd.mjs, focused tests/fixtures, optional reusable pure verification module; no workflows/browser.
2. CI fixer: .github/workflows/static.yml + sync-lmfpd.yml, trusted publish helper and its tests; no syncer/browser. Uses CLI above.
3. Once a slot is free, browser fixer: fingerprint.js loading only and focused cache/browser tests; no scoring/sampling algorithm or workflow changes.
4. After terminal results: integration real old supported SHA build, latest SHA rejection without write, byte-stability, test suites, targeted real browser loading/integrity and workflow review. At most two agents concurrently.

## Rollback

Disable scheduled workflow, restore all five matching artifacts as one normal commit, deploy via existing workflow. Do not selectively roll back detector or algorithm. Local code remains uncommitted for review unless user explicitly requests commit. Failure should leave deploy jobs unreachable and current site intact.
