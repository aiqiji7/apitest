# Pages upload/deployment boundary

## Decision and evidence

Two independent runs of the same commit uploaded a valid artifact, then immediately found zero artifacts through deploy-pages. The post-incident fresh experiment reproduced the discovery failure. Use the official supported build → deploy job structure as the smallest local mitigation; it creates a completed upload job before the deployment runner starts. This does not provide a service visibility guarantee or establish the historical HTTP 500 cause. See `research/deployment-evidence.md` for original sources and timing.

## Job contracts

- Workflow-level default permission is `contents: read`; events and required reusable `ref` input do not change.
- `build`: contents read only, existing SHA resolver and exact checkout with `persist-credentials: false`, existing runtime staging shell and upload-pages-artifact v3. Upload step has `id: upload`; job emits `sha: steps.ref.outputs.sha` and `artifact_id: steps.upload.outputs.artifact_id`. No Pages environment, lock or Pages/OIDC write permission belongs here.
- `deploy`: `needs: build`, conditional on nonempty upload ID and the implicit normal successful dependency check. It checks out `needs.build.outputs.sha` without persisted credentials. It alone holds the existing `pages` job lock with no cancellation and the `github-pages` environment, and has contents read / Pages write / OIDC write permissions.
- After deployment lock acquisition and checkout, run the unchanged `target` guard comparing HEAD to current remote main. Setup Pages stays in this job, conditional on that guard. Then run the unchanged `ready` guard immediately before the unchanged deploy-pages v4 step. Reusable workflow callers retain no conflicting Pages lock.
- `artifact_id` is an output for identity/eligibility checks, not a supported input to deploy-pages v4. Keep the existing artifact name and action behavior.

## Behavior at boundaries

| Condition | Behavior |
| --- | --- |
| Malformed SHA or missing runtime input | Build fails before upload; deployment is ineligible. |
| Failed/skipped build or missing upload ID | No deployment. Do not add `always()` or error continuation. |
| Main advances while building or waiting for deploy lock | `target` skips setup and deployment. |
| Main advances after setup | `ready` skips deployment. |
| Exact target remains current | Deploy the artifact built from that exact target through the existing action. |
| Internal artifact lookup still returns zero | Report discovery failure; no blind retry or claim of recovery. |
| Correct artifact found but creation returns HTTP 500 | Preserve response/request evidence and investigate the deployment API boundary separately. |

## Scope and rollback

Source changes are limited to `.github/workflows/static.yml` and its existing workflow regression tests. No website bytes, sync workflow, action versions, dependency or remote settings change. Update the existing Pages spec with this final job contract after implementation review. A normal patch/commit restoring the previous workflow structure reverses the local change; no history rewrite or deployment reset is needed.

## Verification limits

Execute existing SHA/guard/staging shell against controlled fixtures and local Git remotes; assert permissions, dependency/output wiring and no bypass. YAML/shell syntax checks plus a focused independent review are sufficient local evidence. Cloud acceptance needs a newly authorized run after publication of the local change, followed by live byte checks if successful.
