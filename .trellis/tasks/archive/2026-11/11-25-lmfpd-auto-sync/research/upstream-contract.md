# Evidence checked 2026-11-25

Actual research used groksearch-cli official-doc extraction and read-only gh GitHub source/API. Local repo code independently inspected. Oracle reviewed cross-system publication/permissions/consistency design. No upstream code executed during research.

## Pinned versus upstream

| Field | Current supported snapshot | Upstream default main |
| --- | --- | --- |
| SHA | 1e58ed83c1cde17f88cba89560ad4d083042ae92 | e0472890bea827d15ca883636a77d4c10bbe843b |
| bank/detector built_at | 2026-10-25T10:04:10.682171+00:00 | 2026-11-23T06:25:02.164646+00:00 |
| models | 63 | 76 |
| fixture built_at | same as bank | 2026-11-17T19:37:59.839365+00:00 |
| fixture ranked models | 63 | 72 |
| analyze cases | 12 | 13 |
| detector bytes | 4597032 | 5514204 |

Both have robust-number-fingerprint-bank / shared-detector-v2 schemas, minimum_valid_numbers80 and recommended_queries3; MIT copyright unchanged. Latest candidate MUST fail binding. Do not rewrite fixture or skip built_at/base_sha checks.

Exact source closure remains shared/{shared-detector.ts,positional.ts,fingerprint-core.js,challenge-browser.js,detector-codec.ts,types.ts}; changed algorithm at latest must travel with data. New type-only imports do not require runtime additions.

Sources fixed at current SHA:
- https://github.com/Ikaleio/lm-detector/blob/e0472890bea827d15ca883636a77d4c10bbe843b/sdk/conformance/analyze.json
- https://github.com/Ikaleio/lm-detector/blob/e0472890bea827d15ca883636a77d4c10bbe843b/sdk/ts/src/analysis.ts
- https://github.com/Ikaleio/lm-detector/blob/e0472890bea827d15ca883636a77d4c10bbe843b/shared/detect-run.ts
- https://github.com/Ikaleio/lm-detector/blob/e0472890bea827d15ca883636a77d4c10bbe843b/sdk/ts/scripts/conformance.ts
- Same paths at supported SHA1e58ed83c1cde17f88cba89560ad4d083042ae92 are positive baseline.

## Full conformance normalization

SDK validates 1-3 outputs, text strings/positive safe expected_count. Parse numbers with candidate parseNumbers; non-strict truncates excess to expected_count and joins comma-space; below max(80,ceil(expected_count*.55)) clears text. Analyze allowPartial=!strict. SDK English presentation changes unscorable prediction_name to Not scored and not_model to Not a model reply, plus evidence label/reason; source functions same at old/latest. Canonical defaults: decision=scored, family_prediction='', ranking_score=null, probability_scope=null, calibration=null, sequence=null. Full keys: decision,prediction,prediction_name,family_prediction,family_prediction_name,results,ranking_score,probability,probability_status,probability_scope,calibration,used_outputs,diagnostics,sequence,method,model_version,evidence.

Compare full semantic fields, all rank array entries/order; numeric tolerance abs(a-b)<=1e-9*max(1,abs(a),abs(b)), reject nonfinite. If avoid presentation adapter, explicitly omit only proven SDK English strings evidence.label/reason and unscorable/not_model display names, never model IDs/ranks/scores/probabilities/calibration/version. Never derive actual values from expected.

Binary encodes little-endian u32 header length, JSON header, 4-byte-aligned byte-plane float32 payload. Validate boundaries/dimensions/refs/finites, not old exact file byte count. Old detector base_sha256=9c1891d3613665dd67097b2926bec04050d2270c7e6c7754b5ed7df6a3809216 matches old fixture; latest fixture base43365ad0... differs detector5e4ae1fa....

## GitHub Actions / Pages sources

- Bot GITHUB_TOKEN pushes do not trigger another push workflow: https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow
- Pages upload/deploy with pages:write and id-token:write: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- workflow_call permissions cannot be raised by nested workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- Schedule default branch, UTC/delay/public60day inactivity constraints: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- contents:write does not bypass branch protection: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
