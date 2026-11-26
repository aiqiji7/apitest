# 优化 apitest 的 1080p 宽屏首屏布局

## Goal

Make apitest usable as a single-screen workspace on a maximized 16:9 1080p monitor: configure a request, run it and read common complete results with minimal manual scrolling. Give the main result priority over configuration and raw request logs while retaining access to every field and full output.

## Requirements

- Use the horizontal space currently left empty by the 1200px container (`assets/css/styles.css:56–63`). Give the primary result most of the available reading space; keep configuration, test selection and shared actions readily accessible.
- The user selected "一屏优先" on 2026-11-26: common complete results should fit without manual scrolling where practical. Configuration and raw request/response records may be folded away to free reading space. Preserve full text, images and diagnostic data; do not replace them with a generated summary, crop output or shrink type to force a fit.
- For ordinary tests, prioritize messages and offer an explicit way to inspect the original request/response alongside them. For capability and fingerprint tests, give the active dedicated panel the results area (`index.html:142–372`). Preserve existing actions and state.
- Shared Run/Stop/Clear, the active result heading and disclosure controls must stay visible in wide mode. When configuration is open, ordinary fields remain reachable without page scrolling. Only expanded or unbounded content needs local scrolling.
- Narrow or short windows must remain readable and keyboard accessible with ordinary page scrolling. No backend, transport, credential or provider behavior changes.
- Preserve live streaming follow in the message column. While following the tail, newly rendered text and reasoning remain visible without moving neighboring panes. Scrolling up pauses follow until the reader returns to the bottom; completion preserves that reading position.

## Acceptance Criteria

- [x] At 1920×900, 1920×960 and 1920×1080 CSS pixels, 100% zoom, shared actions, the primary result heading and controls for revealing configuration/logs are visible at initial scroll positions. No document horizontal or vertical scrolling is needed; when configuration is open its everyday fields fit without an inner scroll.
- [x] A deterministic representative ordinary answer fits completely within the primary result's visible reading area in the result-priority state, without smaller text, truncation or manual scrolling. Compare its reading width with the previous split-column state. An explicit accessible control restores full raw request/response inspection.
- [x] Folding and restoring auxiliary content preserves field values, scenario, result DOM/content, selected raw-block expansion and running state. Keyboard focus remains reachable; errors are discoverable even when settings are folded. Long output remains fully accessible.
- [x] Changing scenarios replaces ordinary outputs with the active specialist panel. A long synthetic result, expanded advanced settings or image preview does not displace run/stop or result headings. The final item remains reachable using pointer and keyboard.
- [x] Recheck mobile/tablet and zoomed layouts for horizontal page overflow, inaccessible fields, and visible keyboard focus. Keep existing API settings, masking, test selection and results intact.
- [x] Native SSE chunks remain visible before EOF in wide mode, including the first long chunk, reasoning, subsequent growth and a second tool round. Upward wheel scrolling pauses follow, End resumes, and completion preserves the chosen position. Narrow layouts retain their text-scrollport behavior.

## Final acceptance evidence — 2026-11-26

- Layout checks: 32/32 passed across 11 CSS viewports; streaming/disclosure subset: 11/11 passed. This covers all target heights, wide/short breakpoint fallbacks, 375/768/1024/1440px widths, expanded settings/log comparison, dropdowns, image controls, long results and specialist panels. Target viewports have zero document overflow in both axes.
- The same complete representative answer naturally wraps to 24 lines at 13px font size and 20.8px line height at all three target heights. Its exact text and both edges fit without scrolling or truncation. The primary column has 1834px of client width (1846px outer width), compared with the previous 497px outer column in the expanded setup/log comparison state.
- Twenty-one same-origin mock requests, including eleven SSE requests, verify live output, history pause/End resume, completion, two tool rounds, view-width changes and narrow behavior. Folding preserves fields, scenario, node identities, raw-block expansion, running state and the original 60px raw-log reading position. Errors remain discoverable with settings folded; HTML preview, masked copy and Clear pass.
- Structured, needle and capacity controllers render actual local responses. Manual fingerprint scoring uses the real local core/reference library, returns 63 candidates and matches the conformance sample prediction. Existing browser integration checks: 77/77 passed on the final source, including protocol, cancellation, stop/clear and masking. Final reports match current source/test hashes.
- Result-priority default/comparison and populated fingerprint screenshots were visually inspected with vision-cli; no obvious overlap, unreadable controls or clipping was identified. Final screenshot artifacts are in `/tmp/opencode/result-priority-final-20261126/`.
- Limitations: the zoom check uses the 960×450 effective CSS viewport corresponding to 1920×900 at 200%; native browser zoom was not measured. Long-content stress uses local fixtures, and ordinary protocol coverage is sampled. Tests contact only local mocks, not real providers.
- Reproducible commands and artifact locations are recorded in `implement.md`. All implementation and acceptance work is complete. On 2026-11-26 the user requested Git submission, superseding the earlier decision to leave changes uncommitted and authorizing local work, archive and journal commits. No push or deployment is included.

## Out of scope

Displaying every line of an arbitrarily long response at once, changing the API test protocol, adding dependencies, or redesigning the mobile interface.
