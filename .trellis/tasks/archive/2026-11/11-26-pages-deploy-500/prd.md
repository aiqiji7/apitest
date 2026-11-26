# 诊断 Pages 失败并分离打包与部署

## Goal

Restore publication of the current validated website to GitHub Pages, with cloud evidence that distinguishes artifact discovery failures from deployment creation failures.

## Confirmed Background

- The user pushed local main through `ce55af053f7b94d681bac3e0c519f5935dfdfbb9`; remote main matches it. The runtime-only package change `98bbd47` is included.
- Push run `45659846758` finalized artifact `15043259937`, but deploy-pages found zero artifacts and did not create a Pages deployment. The approved fresh dispatch `45664291195` reproduced this with the same target SHA and artifact `15045723792` at `2026-11-25T17:24:05.895Z`; REST subsequently reports the correct artifact as present and unexpired in each run.
- Previous run `45650279288` found artifact `15039633180` and received HTTP 500 while creating a deployment. The discovery failures cannot establish whether that earlier problem persists.
- Official incident `qn8mfv6q5hlx` covered `15:55:19–16:52:16 UTC` on November 25, including Pages, Actions and API degradation. This overlaps the approximately 16:00 HTTP 500, but not the latest discovery failure. Current service status is operational.
- Official deploy-pages v4 and v5.0.1 do not retry a successful artifact query with an empty result. Issue #451 and an independently read public run demonstrate delayed discovery; this is supporting evidence, not proof of the repository's backend root cause.

## Requirements

- R1: Diagnose the current failure using exact run, target SHA, uploaded artifact ID, failure stage and response/request identifiers. Do not label unlike failures as the same error.
- R2: Separate website staging/upload from deployment using supported jobs and an explicit dependency. Pass the exact resolved full SHA and the uploaded artifact ID across the boundary. The build job has only contents read permission; only the deploy job has Pages and OIDC write permission and owns the shared Pages lock/environment.
- R3: A successful deployment must be followed by read-only comparison of live website bytes with the deployed target, including the index, fingerprint version and its bound artifacts.
- R4: Preserve package bytes/allowlist, action versions, reusable workflow interface, checkout credential isolation, and both main guards after acquiring the deployment lock and immediately before deployment. Failed or skipped builds do not deploy. No fixed sleeps, internal API client, dependency, blind deployment retry or Pages configuration reset is added.
- R5: Respect the user's maximum of two simultaneous specialists. Record conclusions and their limits in this task.
- R6: Validate actual SHA resolution, stale-main behavior and packaging locally. A cloud test must separately verify that the uploaded artifact was found and accepted; a successful local test does not establish restored publication. If creation still returns HTTP 500 after finding the correct artifact, diagnose that boundary separately.

## Acceptance Criteria

- [x] Latest failure and previous HTTP 500 are distinguished using actual run logs and artifact metadata.
- [x] Official action behavior, a matching public trace and the published incident have been independently checked; unsupported causal claims are excluded.
- [x] The user reviews the bounded cloud experiment and authorizes a fresh run before remote execution.
- [x] An approved fresh run is traced to the uploaded artifact and exact target SHA; success or its precise remaining failure is recorded.
- [x] The local workflow uses build → deploy jobs with exact SHA/artifact ID outputs, least job permissions, the shared deploy lock, and both main guards.
- [x] Focused tests exercise the actual workflow shell, retain runtime bytes/manifest hashes, and cover cross-job ordering, failed-build behavior and stale targets. Independent review finds no blocking issue.
- [x] Cloud run `45672581729` successfully deployed artifact `15049529308` from target `6a67311c9e9f37df8d0745c1acf4367a787c82e9`; all 16 live runtime files agree byte-for-byte, including four fingerprint hashes. Current publication is restored.

## Scope and Authorization

- The user approved creation and diagnostic planning, then explicitly selected “新建一次运行（推荐）” for exactly one fresh Pages run using the current workflow and main. Read-only local and public/authorized repository investigation is within scope.
- The user subsequently said “继续” after the separate upload/deployment proposal. This authorizes the bounded local CI change and focused tests; the design and execution boundaries are in `design.md` and `implement.md`.
- Exactly one fresh `workflow_dispatch` was authorized and has been consumed by run `45664291195`. The user later explicitly approved a local commit containing the workflow, its regression test and the updated spec; this created `6a67311`. No push, additional dispatch, remote settings change or dependency change is authorized. The user will push for the next cloud comparison.
- Do not rerun the old run, retry deployment creation blindly, broaden permissions, or delete/reset Pages configuration.
- Raw evidence and the concrete proposed experiment are in `research/deployment-evidence.md`.

## Final Acceptance

The user pushed the approved functional commit, and the resulting push-triggered build and deploy jobs both succeeded. Parent directly verified the upload ID, discovery result, exact deployment version and reported success; the live-verification lane independently compared the public HTTPS files to the exact Git commit. No additional workflow dispatch, rerun or push was performed by the assistant. One successful publication and matching live bytes establish current recovery, not permanent immunity to artifact-service delays or the internal cause of historical HTTP 500 responses.
