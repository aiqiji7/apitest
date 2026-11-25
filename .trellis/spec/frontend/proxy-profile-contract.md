# Proxy / Request Profile Contract

## 1. Scope / Trigger

This cross-layer contract covers ordinary tests, [diagnostic controllers](../../../assets/js/capability.js), and [fingerprint samples](../../../assets/js/fingerprint.js) → [shared transport / APITestBridge](../../../assets/js/script.js) → [TestingCore](../../../assets/js/testing-core.js) → [Worker](../../../proxy/worker.js). Read it before changing profile generation, scenario lifecycle, proxy routing, or diagnostics. Profiles describe request shapes; upstream receipt requires network evidence.

## 2. Signatures

```js
TestingCore.buildProfileHeaders(profile, modelId, { enhanced, custom } = {})
// -> lower-case own-property map of string header values
TestingCore.applyRequestProfile({
  profile, vendor, url, headers, body, modelId, options: { enhanced, custom }
})
// -> { applied, url, headers, body, profileHeaders,
//      blockedHeaders?, mismatch?, reason? }
APITestBridge.captureRunContext()
// -> { apiUrl, apiKey, model, scenario, protocol, vendor, stream, thinking,
//      effort, proxyUrl, httpsProxyEnabled, profile: { id, enhanced, custom } }
APITestBridge.bindRunContext(signal, ctx) // WeakMap binding; returns the same signal
APITestBridge.fetchAndStream(url, options, onChunk, onPhase, onReasoningChunk,
  { runContext, onPrepared, profileMode } = {})
// -> Promise<{ json, text, contentType, isStreamed, reasoningText, toolCalls? }>
// onPrepared({ url, options, applied, transport }); profileMode defaults to 'auto'
APITestBridge.prepareProfileTransport({ url, headers, profileHeaders, applied, runContext })
// -> { url, headers, proxyRouted, overrideRequested }
APITestBridge.registerScenarioController(id, { activate, deactivate, run, stop, clear })
APITestBridge.setScenarioRunState(id, { running, label, stopEnabled }) // last two optional
// activate(ctx), run(ctx); deactivate(), stop(), clear()
// Worker module default export: worker.fetch(request, env = {}, ctx)
// -> Promise<Response>
```

Core `profile` / snapshot `profile.id` is `default|codex|claude|gemini`; compatible vendors are respectively any / `openai` / `anthropic` / `google` (Codex requires Responses). `headers` in core is a plain map; transport also accepts `Headers` or entry pairs. Options are optional; `custom` is an object of own string fields. Transport accepts `applied: true` or the successful core result object; optional `runContext` fixes proxy checks to that run.

## 3. Contracts (request / response / env)

### Generation and reuse

- `fetchAndStream` owns AUTO profile application: recognize POST JSON model endpoints `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and `/models/{model}:generateContent|streamGenerateContent`, including configured proxy routes. Apply each compatible nondefault profile exactly once, then pass the same core result to `prepareProfileTransport` and serialize its body. Application callers never pre-apply profiles or regenerate IDs in observers/debug output.
- This path covers ordinary text/IQ, tools and every turn, search, image recognition, the three diagnostic controllers, and automatic fingerprint samples. `profileMode: 'skip'`, Images JSON/multipart, model-list GET, and reference-data downloads do not apply profiles. Default preserves request URL/headers/body apart from ordinary proxy routing and ignores enhanced/custom options.
- Merge base → enhanced → custom, with case-insensitive names and last value winning. Normalize custom values by removing only leading/trailing SP and HTAB **before** deriving IDs/body fields; retain internal whitespace, NBSP, and Latin-1. Do not append generated beta flags after a custom `anthropic-beta`, including an empty value.
- Core default/missing profile returns the original URL/headers/body, `applied: false`, and `{}` profileHeaders, ignoring enhanced/custom options. Unknown profiles also do not apply. Vendor mismatch or Codex without a Responses-shaped body (`input` or `instructions`) returns `mismatch: true`; shared transport stops before fetch.
- Inputs remain unmodified. Header maps use own data properties, including legal names such as `__proto__` and `constructor`; inherited entries never become headers.

| Profile | Base headers / body | Enhanced additions |
| --- | --- | --- |
| Codex | UA `codex_cli_rs/0.164.0 (Windows 10.0; x86_64)`, `originator=codex_cli_rs`, UUID `session-id`, `thread-id`, `x-client-request-id`, `x-codex-window-id=<thread>:0`; Responses developer identity, `store=false`, include `reasoning.encrypted_content`, matching `client_metadata` IDs and `prompt_cache_key=session-id` | `x-client-request-id=thread-id`; JSON `x-codex-turn-metadata` reused verbatim in `body.client_metadata`, with parsed string installation ID copied to `x-codex-installation-id` |
| Claude | UA `claude-cli/2.1.306 (external, cli)`, `x-app=cli`, `anthropic-version=2023-06-01`, UUID `x-claude-code-session-id`, `anthropic-dangerous-direct-browser-access=true`, base beta flags; system identity and JSON `metadata.user_id.session_id` matching final header | Eight `x-stainless-*` fields, four additional beta flags; add/replace only `beta=true` in URL, preserving other query bytes |
| Gemini | UA `GeminiCLI/0.65.0/<modelId> (win32; x64; cli)`, `x-goog-api-client=genai-js/0.65.0`; prepend identity in `systemInstruction.parts` | Same headers/body as base |

Codex generated turn metadata has `installation_id`, `session_id`, `thread_id`, `window_id`, `window_number: 0`, `turn_id`, `root_turn_id` (same turn ID), `request_kind: "turn"`, `history_initialization: "new"`, `model`, and numeric `turn_started_at_unix_ms`. Session/thread/window use final normalized identities. A custom metadata string replaces the whole value; opaque non-JSON strings remain valid headers/body metadata.

Claude base beta flags are `claude-code-20250219,interleaved-thinking-2025-05-14`; enhanced adds `thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24`. Without a custom beta field, caller beta flags are merged without duplicates. Stainless suffix/value pairs are `lang=js`, `package-version=0.128.0`, `os=Windows`, `arch=x64`, `runtime=node`, `runtime-version=v26.3.0`, `retry-count=0`, `timeout=600`. Do not add billing, CWD, or date spoofing.

### Browser → proxy → upstream

- `httpProxyUrl` persists the proxy base; `httpsProxyEnabled === '1'` enables HTTPS routing, otherwise off. HTTP retains automatic routing when a proxy exists. Shared endpoint builders and model-list GET use this routing; already configured proxy routes must not be wrapped twice.
- `prepareProfileTransport` adds `X-APITest-Override-Headers` only for a successfully applied nonempty profile map **and** enabled switch **and** an actual configured route `${proxyWithoutTrailingSlash}/proxy/<http(s) target>`. Merely containing `/proxy/` is insufficient. It removes any incoming copy of this control header unconditionally; when adding the payload, it removes ordinary browser `User-Agent` fields.
- Payload is `JSON.stringify(profileHeaders)` with U+007F–U+FFFF escaped as `\uXXXX`, so the outer header is ASCII-safe. JSON escaping does not relax decoded HTTP value validation. Default profiles, disabled switch, and missing/unmatched proxy routes send no override payload.
- Use raw `/proxy/<full target URL>` including query: `/proxy/https://api.example/a%2Fb?q=%252F&space=a+b` preserves these escapes. Worker joins pathname tail with outer search; never decode a raw target wholesale. Optional recognizable `https?%3A%2F%2F...` whole-target encoding is decoded once. Require HTTP(S), hostname, and no URL username/password; fragments do not travel over HTTP.
- Worker applies allowed overrides last and consumes all `x-apitest-*` fields. Strip request Host, Content-Length, Origin, Referer, Cookie/Cookie2, Accept-Charset, Accept-Encoding, Date, DNT, Expect, Permissions-Policy; `Sec-*`, `Proxy-*`, `Access-Control-*`; hop fields Connection, Keep-Alive, Proxy-Authenticate, Proxy-Authorization, Proxy-Connection, TE, Trailer, Transfer-Encoding, Upgrade; and fields nominated by Connection. Overrides cannot restore reserved fields. Preserve API Authorization/key headers and ordinary business headers; runtime supplies transport framing.
- GET/HEAD/POST/PUT/PATCH/DELETE forward method, applicable body stream, and abort signal with `redirect: 'manual'`. OPTIONS is local preflight only. Use `new Response(upstream.body, ...)` without buffering JSON/SSE. Preserve ordinary upstream status/statusText/body; strip response hop/Connection nominees, upstream CORS and Set-Cookie/Set-Cookie2, then apply proxy CORS. Redirects 301/302/303/307/308 become 502 with no Location or redirect body. A failure after response headers errors/ends the stream rather than replacing it with JSON.
- `ALLOWED_ORIGINS` is the only optional Worker env key: absent/empty → `Access-Control-Allow-Origin: *`; otherwise split/trim comma-separated exact origins, reflect accepted Origin and `Vary: Origin`. Mismatched supplied Origin → 403 without allow-origin; no-Origin clients remain usable. No allow-credentials header. Preflight 204 explicitly permits Authorization/control/provider headers and valid requested business fields, supported methods, max-age 600, and Vary on requested method/headers. Actual responses expose request IDs, retry-after, and present rate-limit headers.

### Global profile, scenarios, and run lifecycle

- Profile controls live in API configuration at `#globalProfileSettings`, retaining `#profileSelect`, basic/enhanced, custom headers, and proxy hints. Selecting Codex/Claude/Gemini selects Responses/Anthropic/Google respectively. A manual incompatible model-protocol change resets to default with a visible notice. Images temporarily ignores the selection.
- `currentVendor` is only `openai|anthropic|google|images`; `protocol` is `chat_completions|responses|anthropic|google|images`. `structured`, `needle`, `capacity`, and `fingerprint` are peer scenarios alongside IQ under all three model vendors (both OpenAI protocols); Images excludes them. `#openaiProtocol` is visible only for OpenAI; preserve the selected scenario across protocol changes when available, otherwise select the first supported scenario. Activation emits `apitest:scenario-change` with `{ scenario, protocol }` in `detail`.
- Controllers register lifecycle methods through the bridge; activation may load local reference data but never sends model requests. Shared `#testBtn`, `#stopTestBtn`, and `#clearBtn` route actions to the active scenario; only that controller may update shared state. Keep running labels and fingerprint idle labels `开始检测` / `评分`. No fake vendors or separate return controls.
- Capture each run once; explicit sixth-argument `runContext` takes priority over the signal's WeakMap context, then live capture is the fallback. Use the snapshot for protocol/vendor/model/key, stream/thinking/effort, profile options, and proxy URL/switch throughout turns, capacity attempts, samples, and retries. Controller parameters are also captured per run. `getRequestContext()` is for activation/display; it does not validate or capture custom headers.
- Scenario/protocol changes and actual proxy URL/switch changes stop the previous run. Epoch and signal guards prevent late response/error/log/phase callbacks or `finally` from changing the current run. External aborts, including abort reasons that are strings/Errors and body reads after 200/401 headers, surface as `AbortError`; do not convert them to HTTP/network errors or flush buffered SSE/reasoning after cancellation. Timeouts remain contextual `TimeoutError` with URL/method.
- Request debug blocks use the prepared URL/options and core application/transport result. Update the pending block instead of adding a duplicate; `onPrepared` observes that same result. Display/copy actual sent headers/body only after masking.
- Fingerprint uses the snapshot protocol, native Gemini `contents` and `candidates[].content.parts` text extraction, and the real scoring core/reference cache. First selection lazily loads core/data; activation/run epochs block late sampling/scoring after exit or stop. Preserve automatic/manual modes, serial/parallel sampling, regeneration, and single-sample retry with its original round context. Manual scoring needs no API credentials/model requests and bypasses unrelated profile validation.

### Diagnostics and probe limits

- Use `sanitizeSensitiveText`, `sanitizeUrlForDisplay`, and `normalizeHeadersForDisplay` for error titles, raw/details panels, request debug/copy output, and handled console logs. Mask the entire control payload, including nested objects, JSON strings, malformed/prose echoes; mask sensitive fields recursively. Remember current/sent credentials in memory in original, SP/HTAB-trimmed, Bearer-token-only, JSON-escaped, and URI-encoded forms, including prior query keys after config changes. Never log the raw Error object or render an unsanitized statusText/body summary.
- Custom header text/credentials and enhanced selection are page-memory-only: never save them in configs, recent connections, localStorage, or sessionStorage. Reload resets profile to default/basic and clears custom input; proxy URL/switch persist.
- Structured/needle/capacity requests are nonstreaming by design for complete validation and usage; disable the stream toggle for these scenarios. Ordinary tests and automatic fingerprint samples respect the captured stream choice.
- Capacity bounds/convergence use local `targetTokens` estimates on both sides, never mix with provider `inputTokens`; usage is recorded separately and budgeted with `max(target, usage)`. No rejected probe means no upper bound; auth/rate/parameter errors do not establish a context limit. Structured validation requires own `city:string`, `population:integer`, `coastal:boolean`, with `additionalProperties:false`; reject fractions, inherited required fields, and extra own fields including `constructor`/`__proto__`. This small schema has no population min/max and proves no general schema coverage or exact provider token limit.

## 4. Validation & Error Matrix

| Boundary / condition | Required result |
| --- | --- |
| Core custom map/type/token/value invalid, or reserved control header | Safe contextual TypeError without supplied secret/name/value |
| Global nondefault profile has invalid custom JSON, reserved field, non-string or invalid bytes | Inline `aria-invalid=true`; stop before model network; default/manual fingerprint ignores unrelated options |
| AUTO nondefault profile: model endpoint differs from snapshot protocol, invalid/non-string JSON body, or core mismatch | Contextual error before fetch; never send a mismatched profile shape |
| External abort during fetch, success/error body read, or SSE; superseded run | `AbortError`; no stale UI/logs, shared-control reset, or buffered flush |
| Connection/SSE inactivity timeout | `TimeoutError` with attempted URL/method; distinct from user cancellation |
| Worker malformed/non-object/null/array map, non-string value, invalid token, reserved/Connection-nominated override | 400 `INVALID_OVERRIDE_HEADERS`; no upstream fetch; `{}` is valid |
| Header value CR/LF/NUL, DEL/other controls except HTAB, or > U+00FF | Reject; valid decoded values are HTAB, U+0020–007E, U+0080–00FF |
| Invalid target / missing host / URL credentials | 400 `INVALID_TARGET` |
| Invalid preflight method or requested reserved/invalid field | 400 `INVALID_PREFLIGHT` |
| Supplied Origin outside configured list | 403 `ORIGIN_NOT_ALLOWED` |
| Route outside `/proxy/` | 404 `NOT_FOUND` |
| Unsupported method | 405 `METHOD_NOT_ALLOWED`, with Allow |
| Upstream fetch rejects while request signal aborted | 499 `REQUEST_ABORTED` |
| Upstream redirect | 502 `UPSTREAM_REDIRECT`; destination never fetched |
| Other upstream fetch failure | 502 `UPSTREAM_UNAVAILABLE` |
| Ordinary upstream HTTP error | Preserve status/body; sanitize at display/log boundary |

Worker-generated failures use `{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The proxy could not reach the upstream service."}}`, appropriate code/static message, `application/json; charset=utf-8`, `Cache-Control: no-store`, and the same origin policy. Never echo target/query, headers, keys, or runtime exception messages. Browser failures without an HTTP response remain contextual `FetchNetworkError` diagnostics, not an invented upstream cause.

## 5. Good / Base / Bad Cases

- **Good:** enhanced Codex + custom `"Session-ID":" \tchosen\t "` → `session-id=chosen` in actual upstream headers, override map, metadata and prompt cache key, with one identity generation/application.
- **Base:** fresh storage keeps HTTPS direct; configured proxy + enabled switch forwards model GET/default POST with no profile override. HTTP still auto-proxies with the switch off.
- **Bad:** `{"Host":"evil"}`, `{"x-api-key":42}`, a CRLF value, or malformed JSON must fail before upstream; an upstream 302 becomes safe 502 rather than browser navigation. Switching to a diagnostic while an old JSON body is pending must leave no late answer, HTTP/network error, or log.

## 6. Required Tests (concrete assertion points)

Durable suites currently cover 82 core tests, 49 Worker tests, and 77 browser checks; counts are a baseline, not a substitute for assertions:

- [Profile core tests](../../../tests/testing-core-profiles.test.mjs): exact base/enhanced/custom headers, UUID generation count, header/body/cache/metadata equality after SP/HTAB normalization, final beta replacement, raw Claude query preservation, frozen inputs and prototype-safe own properties; default/mismatch generate no IDs.
- [Capability core tests](../../../tests/testing-core-capabilities.test.mjs): non-inverted estimate bounds with usage above/below estimates, no upper bound at ceiling, budget/stop/auth/rate behavior; integer, required own fields, and extra-field rejection.
- [Worker network tests](../../../proxy/worker.test.mjs): real upstream UA/credentials/body, no leaked control/browser/hop fields, raw/encoded target query equality, map/error matrix/CORS, no redirect destination hit, first SSE/chunked JSON before explicit upstream release, cancellation and stream errors.
- [Browser checks](../../../tests/proxy-browser.e2e.mjs): native fetch/direct-proxy matrix, model GET and Images/reference exclusions; three enhanced profiles applied once with actual upstream header/body identity; sampled ordinary IQ/text, tools/multiturn snapshots, search, image recognition and SSE; three separate diagnostics across four model protocols; prepared debug/copy without duplicate blocks.
- Assert peer scenario navigation, compatible selection retention, profile-implied protocol and incompatible reset; snapshot capacity parameters, credentials, profile options and transport. Fingerprint must use real core/data across four protocols (including Gemini SSE), lazy activation, serial/parallel sampling, original-context retry, manual scoring without credentials/network or unrelated profile validation, regenerate and clear.
- Assert invalid custom JSON sends nothing; nested control payload and normalized/token/JSON/URI credential echoes stay absent from results/title/raw/details/debug/copy/storage/console; reload restores only proxy settings beyond existing connection storage; shared controls remain reachable at 375/768/1024/1440px.
- Cancel diagnostics/samples on scenario/protocol/proxy/stop/clear and during lazy loading. For delayed JSON 200 and 401, receive headers plus partial body, then stop/switch scenario/switch protocol/start a new run before releasing the body: require native cancellation, no stale render/log/phase/control changes, and successful completion of the new run. SSE must deliver before upstream EOF and never flush buffered content after abort.

Run from repository root using existing runtimes, with no dependency installation:

```bash
node --test tests/testing-core-*.test.mjs
node --test proxy/*.test.mjs
node tests/proxy-browser.e2e.mjs
```

Browser harness requires Node 24+ native WebSocket, Chrome (`APITEST_E2E_CHROME`, default `/usr/bin/google-chrome`), OpenSSL, and existing `/tmp/opencode`; it uses native browser fetch, the actual local Node proxy, loopback HTTP/HTTPS mocks, and disposable TLS trust. Final 77/77 evidence: `/tmp/opencode/proxy-ua-e2e-LhCBH3/report.json`. Ordinary coverage is sampled, not exhaustive across every IQ/search/image variant. This establishes local application behavior only; workerd/deployment validation is separate (see [runtime details](../../../proxy/README.md#local-verification-and-browser-development)).

## 7. Wrong vs Correct

```js
// Wrong: application caller pre-applies; AUTO transport would apply again.
const applied = TestingCore.applyRequestProfile(input);
await APITestBridge.fetchAndStream(applied.url,
  { ...options, headers: applied.headers, body: JSON.stringify(applied.body) });

// Correct: send the native request with one captured context.
const ctx = APITestBridge.captureRunContext();
const signal = APITestBridge.bindRunContext(controller.signal, ctx);
await APITestBridge.fetchAndStream(url, { ...options, signal },
  onChunk, onPhase, onReasoningChunk, {
    runContext: ctx,
    onPrepared({ url, options, applied, transport }) {
      // Observe the actual request; never call a profile generator here.
    }
  });
```
