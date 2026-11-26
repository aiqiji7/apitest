# Execution plan

- [x] Read original run logs, official source/incident evidence and relevant spec.
- [x] Execute the user-approved single fresh run and record the repeated discovery failure.
- [x] Record the minimal two-job design and the user's “继续” authorization for local implementation.
- [x] Implementation lane owns only `.github/workflows/static.yml` and `tests/lmfpd-publish-workflows.test.mjs`; adjust targeted tests first, observe the regression, implement the reviewed job split, and run the focused suite.
- [x] Verify YAML and shell syntax, actual runtime staging bytes/hashes, SHA resolution and local Git stale-main cases. Do not run unrelated application/browser suites for a job-only change.
- [x] Independent check lane reviews all affected source against PRD, design, spec and reusable caller contracts; fix only bounded issues and rerun relevant checks.
- [x] Update `.trellis/spec/backend/lmfpd-auto-sync.md` for final job permissions and artifact/SHA handoff. Record local evidence and cloud limits in task artifacts.
- [x] Inspect final diff/status and present any proposed local commit for approval. User approved the three-file commit `6a67311`; no push or second dispatch was executed.
- [x] The user pushed commit `6a67311`; trace of its push-triggered run `45672581729` confirms the correct artifact and successful deployment. All 16 live runtime files and the root homepage matched the exact target, including all four fingerprint hashes. Current publication is restored.

Focused validation:

```text
node --test tests/lmfpd-publish-workflows.test.mjs
node --check tests/lmfpd-publish-workflows.test.mjs
git diff --check
```

Use the repository's existing Python/PyYAML loader to parse both workflows and extract every shell block for `bash -n`. No dependency installation is required. A failed focused check must change the hypothesis or fix before repeating; do not repeat the completed unmodified cloud experiment.
