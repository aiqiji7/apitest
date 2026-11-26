# Pages deployment evidence and proposed experiment

## Direct repository evidence

Read-only GitHub CLI requests on November 25, 2026 around 17:15 UTC confirmed remote main at `ce55af053f7b94d681bac3e0c519f5935dfdfbb9` and latest run:

- https://github.com/aiqiji7/apitest/actions/runs/45659846758
- Uploader finalized `github-pages` artifact `15043259937`, 3,936,355 compressed bytes, at `16:59:31.3384916Z`.
- deploy-pages started metadata lookup at `16:59:32.0373358Z`, reported zero artifacts at `16:59:32.2990195Z`, and stopped before requesting deployment creation.
- REST `GET /repos/aiqiji7/apitest/actions/runs/45659846758/artifacts` subsequently returned exactly that artifact, the correct run and SHA, and `expired: false`.
- Earlier run https://github.com/aiqiji7/apitest/actions/runs/45650279288 found artifact `15039633180` but creation returned HTTP 500, request ID `FFC1:24B55E:532D32:816C91:6B070623`.

These are distinct failure stages. Later REST visibility alone does not prove that the internal runtime query saw the artifact at the earlier time; interfaces, time and credential scope differ.

## External evidence actually checked

1. Official fixed-SHA source: https://github.com/actions/deploy-pages/blob/d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/src/internal/api-client.js
   `getArtifactMetadata` makes one `DefaultArtifactClient.listArtifacts()` call and rejects zero or multiple matching names. Its deployment polling options do not retry an empty successful query. v5.0.1 retains this behavior, so upgrading alone is not a targeted remedy.
2. Open issue: https://github.com/actions/deploy-pages/issues/451
   Reports include current-version failures after a successful upload, duplicate names after rerunning the old job, and a separate-jobs workaround. These are community observations, not a maintainer-confirmed service root cause.
3. Public trace: https://github.com/windrover/dsh-table-sync/actions/runs/45537648379
   Artifact `14988715339` finalized at `03:12:07.428Z`, lookup missed it at `03:12:07.802Z`, subsequent same-job lookup found it at `03:12:53.368Z`, and deployment succeeded at `03:12:58.465Z`. Read-only run metadata and logs substantiate the trace; it does not guarantee any maximum delay.
4. Official incident: https://www.githubstatus.com/incidents/qn8mfv6q5hlx
   Original status API at `https://www.githubstatus.com/api/v2/incidents/qn8mfv6q5hlx.json` reports start `2026-11-25T15:55:19.600Z`, resolved `16:52:16.287Z`; updates cite high database load and degraded Pages, Actions and API requests. The approximately 16:00 HTTP 500 is inside this window; the 16:59 discovery error is outside it. Neither timing proves causation for all failed runs.
5. Official status summary/components currently report Pages, Actions and API Requests operational.
6. Supported job linking: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages#linking-separate-build-and-deploy-jobs
   The documented `build` -> `deploy` structure provides a supported fallback, but not a guarantee of artifact visibility. The official static starter still permits a single job.

Search tools: `gh` for original source/issues/run logs and API; `groksearch-cli` for search; direct HTTP reads for official status APIs. Grok search returned no source URLs; its synthesized assertions were not relied on. Oracle and librarian independently reviewed the relevant surfaces, at most two specialists concurrently. Existing archive evidence supplied prior context; no conversation-history query was needed.

## Confidence and rejected shortcuts

- High confidence: latest run stopped at artifact discovery; no deployment request was made.
- Medium confidence: intermittent internal artifact visibility is the leading explanation. SDK/scope/service behavior remains a possible alternative.
- High confidence: a fresh run after the published incident is the smallest current cloud discriminator.
- No evidence establishes that website content or package size caused the latest error.
- Increasing deploy polling timeout, merely upgrading action versions, adding a fixed delay, or deleting Pages settings is not justified by these observations.
- A custom Twirp client or added SDK dependency is disproportionate before one fresh controlled experiment. A REST-only readiness check cannot guarantee internal SDK visibility.

## Approved bounded experiment

The user explicitly selected “新建一次运行（推荐）” after reviewing that this triggers a real Pages deployment with the existing workflow. Preflight confirms remote main `ce55af053f7b94d681bac3e0c519f5935dfdfbb9`, workflow `285424587` active, and no current Pages run among the latest entries. Authorization is for one new run, not a rerun or repeated dispatch.

1. Activate this diagnostic task after review. Read remote main and check for an active Pages run. Request exactly one new `workflow_dispatch` of `static.yml` on main using the existing workflow. Do not rerun run `45659846758` or modify code.
2. Resolve and track only the resulting run. Record target SHA, upload ID/finalization time, lookup count, deployment payload artifact ID and final result. Preserve concurrency and stale-main outcomes; do not compensate by automatic reruns or deployment POST retries.
3. If successful, compare live index, VERSION and bound fingerprint files against the exact target, accounting for cache propagation with read-only requests. If discovery fails again, update planning for a supported split into upload and deploy jobs. If creation returns 500 after finding the correct artifact, collect request IDs and stop changing artifact discovery as an explanation for that failure.

A successful run plus matching live bytes establishes current publication recovery only. It does not prove permanent elimination of transient artifact discovery failures or the internal cause of historical HTTP 500s.

## Fresh experiment result and authorized next step

- User-approved dispatch: https://github.com/aiqiji7/apitest/actions/runs/45664291195
- Event `workflow_dispatch`; target `ce55af053f7b94d681bac3e0c519f5935dfdfbb9`; final conclusion `failure`.
- Artifact `15045723792`, name `github-pages`, compressed size 3,936,356 bytes, created `2026-11-25T17:24:04Z`; REST confirms the correct run/SHA and not expired.
- Deploy lookup began `17:24:05.6363881Z`, returned `Found 0 artifact(s)` at `17:24:05.8959056Z`, and failed before Pages deployment creation. All earlier steps, including both main guards, succeeded.
- The post-incident fresh run did not restore publication. No second unchanged dispatch or rerun is authorized or justified by this experiment.
- Oracle reviewed the supported separate-jobs fallback after this result. The user then said “继续” to the concrete proposal to separate packaging/upload from deployment. Proceed with the bounded local workflow/test change, preserving package bytes and all deployment guards. This is a mitigation for discovery timing with medium confidence, not proof of a permanent fix or of the earlier HTTP 500 cause.

## Local implementation and independent review

- Implementation session `ses_dec387f45ffeEOKM4o7QagL9zS` completed and was reconciled. Its source ownership was limited to `.github/workflows/static.yml` and `tests/lmfpd-publish-workflows.test.mjs`.
- Tests were updated first: the old single-job workflow produced 3 passing / 7 expected failing cases. After the job split, all 10 cases passed, with zero skips.
- Final structure: build runs with contents read permission and outputs the exact resolved SHA and upload ID; deployment depends on successful build/nonempty ID, checks out that SHA, and alone owns Pages/OIDC write permissions, the Pages environment and shared lock. The two main guards remain in deployment. No application bytes, action versions, dependencies or remote settings changed.
- Parent directly verified the official upload composite at SHA `56afc609e74202658d3ffba0e8f6dda462b719fa`: its public output is `artifact_id`, mapped from upload-artifact's `artifact-id`. The output is used as the job gate/diagnostic identity, not an unsupported deploy-pages input.
- Independent check session `ses_dedc115bfffeqp1T58fMGG2ewN` reviewed the source, updated spec and unchanged sync caller. It found no blocking issue and corrected only the stale-main log wording to match the new job placement.
- Final focused check: `node --test tests/lmfpd-publish-workflows.test.mjs` — 10/10 passing, zero skips. This includes parsing both YAML files, checking all shell blocks with `bash -n`, actual SHA resolution/malformed input rejection, real local Git stale-main scenarios, missing/stale staging rejection, and unchanged source bytes.
- Actual staged runtime package: 16 files / 5,180,423 bytes, seven local index resource references and four fingerprint manifest hashes verified. `node --check tests/lmfpd-publish-workflows.test.mjs` and `git diff --check` passed.
- `.trellis/spec/backend/lmfpd-auto-sync.md` records the resulting job/permission/output contract and stage-specific diagnosis. No unrelated application/browser suites were repeated for the job-only change.
- Remaining acceptance: publish the local workflow change through an authorized commit/push, observe a fresh cloud run using it, and compare live website bytes if deployment succeeds. No additional remote run or commit was executed during local implementation/review. The task remains in progress; publication recovery is unproven.

## Approved local commit

The user selected “创建本地提交” after reviewing the three-file commit plan. Commit `6a67311c9e9f37df8d0745c1acf4367a787c82e9` (`fix: 分离 Pages 打包与部署作业`) contains only the workflow, its regression test and the updated backend spec. Final Git inspection confirms main is one commit ahead of origin/main with no remaining tracked-file changes; this active task directory remains untracked deliberately until cloud acceptance. No push or further dispatch was performed. Wait for the user to push main, then inspect that push-triggered run read-only; do not archive this task or claim recovered publication before the cloud result.

## Cloud acceptance after user push

The user reported “推送了”. Read-only repository/API inspection confirmed remote main at `6a67311c9e9f37df8d0745c1acf4367a787c82e9` and the push-triggered run https://github.com/aiqiji7/apitest/actions/runs/45672581729 completed successfully. Both `build` and `deploy` ran to success; neither deployment nor a main guard was skipped.

- Upload finalized `github-pages` artifact `15049529308` at `2026-11-25T18:11:42.0082836Z`, compressed size 3,936,353 bytes.
- Deployment lookup began at `18:11:54.6982210Z`; `Found 1 artifact(s)` at `18:11:54.8287912Z`.
- Creation payload used `artifact_id: 15049529308` and `pages_build_version: 6a67311c9e9f37df8d0745c1acf4367a787c82e9`.
- Deployment was created at `18:11:55.5849456Z` and `Reported success!` at `18:12:00.7178628Z`. Parent verified these fields directly from logs without persisting OIDC/token values.
- No additional workflow dispatch or rerun was needed. The assistant did not push or modify remote settings.

## Live acceptance

Verification session `ses_dedf345a2ffeffyhi4u6RrBk4g` compared exact Git objects at the deployed SHA to HTTPS responses from `https://apitest.160006.xyz/`, using certificate verification and decoded HTTP bytes. At `2026-11-25T18:20:07–18:20:10Z`:

- 16/16 runtime files, totalling 5,180,423 bytes, matched byte-for-byte and by SHA-256. Root `/` also matched `index.html`.
- All 17 GET requests returned HTTP 200 without redirects; certificate verification passed.
- Seven index resources were fetched with their actual query parameters. Fingerprint dynamic files used the VERSION-bound hash queries; VERSION and all four manifest hashes matched.
- No cache-busting retry was necessary. Origin/cache response headers showed `Age: 0`, `X-Cache: MISS`, and Cloudflare `DYNAMIC` or `MISS`.
- Raw report and individual public response headers/bodies: `/tmp/opencode/pages-live-bytes-UkdDNg/report.json`. This temporary evidence was read and reconciled by the parent; durable result identifiers and counts are recorded here.

Conclusion strength: high for current publication recovery and exact live bytes. The successful split job layout is a verified mitigation in this run; it does not prove all future queries will be immediately consistent. The actual service internals behind the earlier discovery failures and HTTP 500 remain unconfirmed. No further code change or broad re-test is justified by this successful acceptance.

## Retrospective and closeout

The underlying boundary assumption was that a finalized upload would immediately appear to deploy-pages' internal query. Local YAML/package tests could not establish that service behavior. The earlier package-only experiment did not solve the subsequent discovery failures; the fresh unchanged run provided a controlled counterexample before the supported separate-job mitigation was implemented. Existing spec changes already capture the job boundary, stage-specific evidence and limits, so no additional spec edit is required after cloud acceptance.

Functional commit `6a67311` was approved and pushed by the user. The user subsequently requested “提交git”, authorizing separate local archive and journal commits. Archived context manifests now reference the archived research path. Do not create new deployment runs or remote changes as part of closeout.
