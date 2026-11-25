# Implement: 指纹库全自动同步

- [x] User approved fully automatic sync and CI/default behavior scope
- [x] Read current syncer, browser cache, Pages workflow, frontend/backend indexes and shared reuse/cross-layer guides
- [x] Investigate current upstream and official GitHub deployment trigger/permissions contract
- [x] Configure manifests and activate task
- [x] Implement sync CLI with candidate output, same-SHA source reads and complete compatibility validation; add meaningful offline regressions
- [x] Implement least-privilege daily sync/normal commit/reusable Pages deployment and trusted byte-only candidate validation
- [x] Implement version-first browser loading, integrity/cache pairing with old-manifest compatibility and focused regression tests
- [x] Rebuild supported pinned snapshot including hashes; verify stable second run
- [x] Attempt current latest candidate in isolated output: expect stale fixture rejection, prove existing snapshot untouched
- [x] Run unit/workflow checks and focused real browser snapshot/cache/cancel validation
- [x] Review final diff/contracts; update README relevant sync guidance and executable spec, record limits and task status

## Evidence plan

- Use local fixture upstream Git commits for valid/invalid/binding/race checks, without model API calls. Changed array values/ranks/probabilities must fail, not only wrong first prediction.
- Check baseline63-model snapshot conformance and publication bytes; allow size/model count variation with format invariants; current76-model HEAD fails fixture binding.
- Release helper tests use isolated scratch repos/artifact dirs and mocked git network boundaries; never push real origin. Verify allowlist, symlinks/hash tampering, no-change and stale-main refusal, no candidate code execution.
- Browser: existing Chrome/CDP + local static host, actual reference assets for valid scoring; inject corrupt/cache/manifest versions only in test server, no real API credit. Existing full proxy harness can run if loader integration affects shared lifecycle.
- Workflow static validation and targeted tests plus official docs review; do not claim remote Actions/Pages run without execution.

## Proposed commands

```bash
node --test tests/sync-lmfpd*.test.mjs tests/lmfpd-publish*.test.mjs
node scripts/sync-lmfpd.mjs --verify-only
node scripts/sync-lmfpd.mjs --ref 1e58ed83c1cde17f88cba89560ad4d083042ae92 --artifact-root /tmp/opencode/<owned>/candidate --result-file /tmp/opencode/<owned>/result.json
node scripts/sync-lmfpd.mjs --latest --artifact-root /tmp/opencode/<owned>/candidate --result-file /tmp/opencode/<owned>/result.json
node tests/proxy-browser.e2e.mjs
git diff --check
```

Use real created owned directories instead of placeholder paths. No dependency manifest additions, remote commits, workflow dispatch or deployment in this session. Preserve existing app/Worker behavior.

## Reconciled implementation results

- ora-1 (ses_ded1d2737ffeDWN2TN49I4Tfmx): adopted three-job read-only validation / byte-only commit / reusable Pages deployment contract, page snapshot consistency, no-update deployment recovery and normal fast-forward-only push.
- fix-8 (ses_ded01796cffejSQmqUVE5WgNlv): syncer and validation module integrated; 16/16 focused tests; real supported-SHA candidate rebuilt with all 24 checks. Public CLI matches workflow call sites.
- fix-9 (ses_ded01794fffeNc7FYmHQZO7Wzb): daily workflow, reusable Pages and trusted publisher integrated; 35/35 focused tests. Final parent joint run supersedes intermediate inter-lane test discrepancy: 51/51 passed.
- fix-5 (ses_deda1542effeq28hri8afRZTqm): version-first loader, SRI and SHA-256 cache checks integrated; 55/55 focused tests. Original scoring and sampling logic preserved.
- Supported candidate hashes independently match all four current artifact files. Only VERSION was migrated with bundle/license hashes; no data/model/algorithm update was forced. Fingerprint controller URL was bumped to load the new loader on existing browsers.
- fix-6 (ses_ded748fb2ffeoYQyzQ0Qdo8ZU4): resolved the historical-fixture/rolling-production coupling. The five-file historical fixture is independently pinned and hash-verified; two successive valid updates and next-run child preflights pass without changing expected ranks or probabilities. Final sync/publication suite: 52/52.
- fix-10 (ses_deccaa67dffeEP3UiLPkVkiV21): adopted README and seven-section backend executable spec; backend index and frontend integrity guidance synchronized. Verified CLI/job names, schedule, permissions, output limits and runtime boundaries against implementation.
- gen-1 (ses_dedf345a2ffeffyhi4u6RrBk4g): native Chrome loader 12/12 and application regression 77/77 passed. Public-network supported rebuild returns changed=false; actual latest fails before build, with five production hashes unchanged (5/5 integration assertions).
- tre-2 (ses_dedc115bfffeqp1T58fMGG2ewN): final read-only closure confirms the fixture P2 resolved, with no remaining blocker. No remote Actions/deployment claim.

## Final verification (2026-11-25)

- Parent final command: `node --test tests/sync-lmfpd.test.mjs tests/lmfpd-publish.test.mjs tests/lmfpd-publish-workflows.test.mjs tests/lmfpd-loader.test.mjs` — 107/107 passed, zero failures/skips (17 sync, 35 publication/workflow, 55 loader).
- Current snapshot verify-only: 24/24 passed, including all 12 complete conformance cases. Genuine remote rebuild at the supported SHA passed 24/24 and produced byte-identical outputs with changed=false.
- Genuine latest resolved e0472890bea827d15ca883636a77d4c10bbe843b and exited 1 at conformance built_at binding (2026-11-17 versus 2026-11-23), before candidate build. No candidate or success result emitted; no production artifacts changed. Commands/hashes: research/real-sync-verification.md. Evidence: /tmp/opencode/lmfpd-real-sync-gen1-Kd6A5p/report.json.
- Native Chrome integrity/cache suite: 12/12, zero model requests/runtime exceptions. Real SRI rejection, data/cache hashes, exact corrupt-key repair, legacy manifests, page pinning/new-page version, retry and lazy-load cancellation verified. Report: /tmp/opencode/lmfpd-loader-e2e-Bsydhh/report.json.
- Application browser regression: 77/77, zero runtime exceptions. Report: /tmp/opencode/proxy-ua-e2e-qgw5kL/report.json. Page/loader hashes match both browser reports and current files.
- YAML parsed with existing PyYAML; guard shell steps exercised in isolated repositories and run blocks checked with bash -n. actionlint was not on PATH and was not installed. Syntax and diff whitespace checks passed.
- No real origin push, Actions dispatch, Pages deployment or account/branch/environment change. Test commits/pushes targeted isolated local repositories only.
- Rollout requires committing/pushing to main and documented bot-write/Pages policies. Schedule: UTC03:17 / Beijing11:17, subject to GitHub scheduling/inactivity limits.
- Code, docs and local evidence passed review. The user subsequently authorized Git submission; feature commit `2be5a4a` (`feat: 支持指纹库每日自动同步与部署`) contains the verified changes. Task archive and session journal follow as separate commits. No origin push, remote workflow activation or deployment was performed.
