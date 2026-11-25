# Hook Guidelines

> Shared request helpers and scenario lifecycle in the legacy IIFE frontend.

---

## Overview

`script.js` owns protocol/scenario selection, global profile configuration, shared actions, and model transport. `capability.js` and `fingerprint.js` use `window.APITestBridge` to register controllers and send requests. Use the [Proxy / Request Profile Contract](./proxy-profile-contract.md) for exact profile generation, proxy/Worker, masking, and regression requirements.

---

## Scenario Controller Patterns

`currentVendor` is only `openai|anthropic|google|images`. `openaiProtocol` is `chat_completions|responses`; the active protocol is that value for OpenAI and the vendor otherwise. `currentActiveScenario` is independent: `structured`, `needle`, `capacity`, and `fingerprint` sit beside ordinary tests and IQ under all three model vendors, including both OpenAI protocols. Images has only its image scenarios.

```js
APITestBridge.registerScenarioController(id, { activate, deactivate, run, stop, clear });
// activate(ctx), run(ctx); deactivate(), stop(), clear()
APITestBridge.setScenarioRunState(id, { running, label, stopEnabled });
// label and stopEnabled are optional; updates are accepted only for the active controller.
```

Shared `#testBtn`, `#stopTestBtn`, and `#clearBtn` dispatch to the active controller or ordinary flow. Controllers must report running state, including fingerprint's `开始检测` / `评分` idle labels and busy labels. Show only the selected scenario's parameters/results. Activation/deactivation must not send model requests; fingerprint activation may lazily load its real local core/reference data.

Scenario/protocol changes and actual proxy URL/switch changes stop current work. Preserve the selected scenario across protocol changes when supported, otherwise select the first available scenario. Dispatch `apitest:scenario-change` with `{ scenario, protocol }`. Use controller epochs plus abort signals to prevent old callbacks or `finally` from changing a newer run's messages, phase, logs, or controls.

### Per-Run Configuration

`APITestBridge.captureRunContext()` returns an independent snapshot of `apiUrl`, `apiKey`, `model`, `scenario`, `protocol`, `vendor`, `stream`, `thinking`, `effort`, `proxyUrl`, `httpsProxyEnabled`, and `profile: { id, enhanced, custom }`. Capture it before asynchronous work; capture controller parameters at the same boundary. Every turn, capacity attempt, fingerprint sample and retry uses the original run context. `getRequestContext()` supplies activation/display state; its empty custom map is not a validated run snapshot.

`APITestBridge.bindRunContext(signal, ctx)` stores a WeakMap binding and returns the same signal. Shared transport selects an explicit `runContext` first, then the bound signal context, then a fresh capture. Ordinary stream/thinking/effort helpers read the active run snapshot.

Fingerprint keeps automatic/manual modes, serial/parallel sampling, regeneration, and per-sample retry with its original round context. Check activation/run epochs after core/data loading and before sampling/scoring so exit/stop cannot trigger late work. Manual scoring needs no API credentials or model request and bypasses unrelated global profile validation; preserve the real scoring algorithm and lazy reference cache.

---

## Data Fetching

### Fetch Error Display Contract

When frontend code fetches data and renders errors in the UI, preserve the distinction between an HTTP response and a browser/network failure.

**HTTP response exists** (and the request has not been canceled):

- Show a concise title with `HTTP <status> <statusText>`.
- Show the attempted method and sanitized URL.
- Show a sanitized backend response summary when available.

**No HTTP response exists** (`TypeError: Failed to fetch`):

- Do not claim a backend reason that the browser did not expose.
- Show contextual hints only: backend unavailable, wrong URL/port, CORS, or proxy issue.
- Include the attempted method and sanitized URL so the user can verify configuration.

**Secret safety**:

- Never render cookies, API keys, tokens, or `Authorization` values in plaintext.
- Request debugging blocks may show request headers only after normalizing them through a masking helper.
- Sanitize response bodies and URLs before inserting them into the UI.

Example:

```js
if (err && err.status) {
  renderModelError({
    title: sanitizeSensitiveText(`请求失败：HTTP ${err.status}${err.statusText ? ' ' + err.statusText : ''}`),
    details: [
      `请求：GET ${sanitizeUrlForDisplay(modelUrl)}`,
      `后端返回：${sanitizeSensitiveText(getBackendResponseSummary(err.responseBody))}`
    ]
  });
} else if (err && err.name === 'TypeError') {
  renderModelError({
    title: '无法连接 API',
    details: [
      `请求：GET ${sanitizeUrlForDisplay(modelUrl)}`,
      '浏览器未返回后端响应，无法判断具体原因。',
      '可能原因：后端不可用、URL/端口错误、跨域(CORS) 或代理问题。'
    ]
  });
}
```

### Generic Request Test Flow

The model-test flow uses `fetchAndStream()` for ordinary scenarios and controllers. It converts browser fetch failures without an HTTP response into a named `FetchNetworkError` with `url` and `method`, then renders contextual network hints. Do not show the raw browser message or invent an upstream cause.

### Centralized Profile Preparation

Global controls live at `#globalProfileSettings` in API configuration. Codex/Claude/Gemini select Responses/Anthropic/Google respectively; a manual incompatible model-protocol change resets the profile to default with a visible notice. Images ignores the selection. Default ignores enhanced/custom options; custom headers and enhanced selection stay in page memory.

AUTO preparation in `fetchAndStream` recognizes POST JSON model endpoints (Chat Completions, Responses, Messages, Gemini generate/streamGenerateContent), applies a compatible nondefault profile exactly once, and reuses the returned identity/body/query fields in transport. This includes ordinary text/IQ, tools/multiturn, search, image recognition, diagnostics, and fingerprint sampling. Callers send provider-native bodies and never pre-apply profiles.

`profileMode: 'skip'` bypasses application; Images JSON/multipart, model-list GET, and reference-data downloads do not receive CLI profiles. Default bodies/headers remain unchanged by profile handling. `prepareProfileTransport({ url, headers, profileHeaders, applied, runContext })` consumes the same generated map, using optional `runContext` for configured proxy URL/switch checks instead of mutable storage.

### Streaming Request Contract

Ordinary model tests and automatic fingerprint sampling respect the captured `#streamToggle` choice. Ordinary request bodies use `isStreamEnabled()`; controllers use `ctx.stream`. Structured/needle/capacity deliberately request nonstreaming JSON for complete validation and usage, and disable the toggle while selected. Model GET, reference data, Images, and manual scoring do not follow the model SSE contract.

**OpenAI Chat Completions** (`/v1/chat/completions`):

- Set body `stream: isStreamEnabled()` (or captured `ctx.stream` in a controller).
- SSE response: `data: {"choices":[{"delta":{"content":"..."}}]}` lines.

**Anthropic Messages** (`/v1/messages`):

- Set body `stream: isStreamEnabled()` (or captured `ctx.stream` in a controller).
- SSE response: `event: content_block_delta` with `delta.text`.

**OpenAI Responses** (`/v1/responses`):

- Set body `stream` from the captured choice; parse Responses event types.

**Gemini** (`/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`):

- Use `:streamGenerateContent` with `alt=sse` when streaming is enabled and `:generateContent` when disabled, including tools and fingerprint samples. Send native `contents: [{ role: 'user', parts: [{ text }] }]`; extract answer text from `candidates[].content.parts`.
- The regular `:generateContent` endpoint ignores `stream: true` in the body.
- **Gotcha**: Tool-calling scenarios must also respect the stream toggle — use `isStreamEnabled() ? geminiStreamEndpoint : geminiEndpoint` to select the correct endpoint.
- SSE response: `data:` lines with `candidates[0].content.parts[0].text`.

**Shared helper signature** (the first five arguments remain compatible):

```js
APITestBridge.fetchAndStream(url, options, onChunk, onPhase, onReasoningChunk,
  { runContext, onPrepared, profileMode } = {});
// -> Promise<{ json, text, contentType, isStreamed, reasoningText, toolCalls? }>

const ctx = APITestBridge.captureRunContext();
const signal = APITestBridge.bindRunContext(controller.signal, ctx);
const result = await APITestBridge.fetchAndStream(url,
  { method: 'POST', headers, body: JSON.stringify(body), signal },
  onChunk, onPhase, onReasoningChunk, {
    runContext: ctx,
    onPrepared({ url, options, applied, transport }) {
      // Observe actual URL/options and the one application/transport result.
    }
  }
);
```

The sixth argument is optional; `profileMode` defaults to `'auto'`. `onPrepared` receives `{ url, options, applied, transport }` before fetch without regenerating any identities. Non-SSE returns body text plus parsed JSON when available and `isStreamed: false`; SSE returns accumulated text, reasoning and provider-native tool calls with `json: null` and `isStreamed: true`.

**`onReasoningChunk` callback contract**:

- `onReasoningChunk` is optional (5th parameter). When provided, `fetchAndStream` calls it for each reasoning/thinking chunk.
- Signature: `onReasoningChunk(reasoningChunk, fullReasoningText)` — mirrors `onChunk` pattern.
- Reasoning chunks also trigger `onPhase('receiving_data')` if no content chunk has arrived yet.

**Reasoning field detection per provider**:

| Provider | Streaming Field | Non-streaming Field |
|---|---|---|
| DeepSeek/Kimi/Qwen/GLM | `delta.reasoning_content` | `choices[0].message.reasoning_content` |
| Ollama/vLLM | `delta.reasoning` | `choices[0].message.reasoning` |
| Anthropic | `thinking_delta` in content blocks | `content[].thinking` (type: "thinking") |
| Responses API | `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` | `output[].reasoning.summary` |
| Gemini | `parts[].thoughtText` | `parts[].thoughtText` |

**UI: Reasoning section in message cards**:

- `addReasoningToCard(card, reasoningText)` — inserts a collapsible reasoning section above the `<pre>` content in a message card.
- Default state: collapsed. Click header to toggle.
- Visual: purple left border, light purple background, italic content, "思考过程" label.
- During streaming: `updateReasoningInCard(card, reasoningText)` shows "思考中..." label and expands.
- After streaming: `finalizeReasoningInCard(card)` changes label to "思考过程" and collapses.

**`onPhase` callback contract**:

- `onPhase` is optional (4th parameter). When provided, `fetchAndStream` calls it at lifecycle milestones.
- Phase values and their meanings:
  - `'waiting_response'` — Successful SSE response headers received; non-SSE skips this callback.
  - `'receiving_data'` — First content or reasoning SSE chunk received; only fires for SSE responses.
  - `'processing'` — Stream reading complete (SSE) or response body fully received (non-SSE). UI rendering of the response follows.
- Ordinary flow passes `createOnPhaseCallback()` as the 4th argument. Controllers may use their own phase/status callback or `null` for a deliberately nonstreaming diagnostic; they must not update an unrelated waiting UI.

### Cancellation and Timeouts

Normalize externally aborted signals to `AbortError` even when the abort reason is a string/Error or cancellation happens during `res.text()` after successful/error headers (including 200/401). Do not swallow an aborted error-body read into an HTTP error or classify a canceled success-body read as `FetchNetworkError`. Check signal and run epoch before render/log/phase callbacks and final state updates; a superseded run cannot clear a new run's waiting indicator or enable its controls. Aborted SSE must not flush buffered text/reasoning.

Connection timeout and SSE inactivity timeout remain `TimeoutError` with attempted URL/method. Keep them distinct from user stop/navigation. Regression checks must hold partial 200/401 JSON after headers, cancel via stop/scenario/protocol/new run, then release it and assert no late UI, log, or control mutations; also cover SSE cancellation and new-run completion.

### Four-Phase Waiting Status

The waiting animation (`ensureWaitingEl()`) displays a dynamic label that reflects the current request lifecycle phase:

| Phase | Label | Trigger |
|---|---|---|
| 1 | `连接中...` | `showWaiting()` called (before `fetch()`) |
| 2 | `等待响应...` | `onPhase('waiting_response')` — SSE headers received |
| 3 | `接收数据中...` | `onPhase('receiving_data')` — first SSE content/reasoning chunk |
| 4 | `处理响应中...` | `onPhase('processing')` — stream/body complete |

**Non-streaming path**: phases 2 and 3 are skipped; transitions directly from `连接中...` → `处理响应中...`.

**Helper pattern**:
```js
const PHASE_LABELS = {
  waiting_response: '等待响应...',
  receiving_data: '接收数据中...',
  processing: '处理响应中...'
};

function createOnPhaseCallback() {
  return (phase) => {
    if (PHASE_LABELS[phase]) updateWaitingLabel(PHASE_LABELS[phase]);
  };
}

// Ordinary flow usage (bind this run's signal/context before sending):
const result = await fetchAndStream(url, options, onChunk, createOnPhaseCallback());
```

**Key implementation details**:

- `waitingLabelEl` stores a reference to the label `<span>` inside the waiting animation element.
- `updateWaitingLabel(text)` updates `waitingLabelEl.textContent`.
- `showWaiting()` resets the label to `连接中...` each time it's called.
- `hideWaiting()` removes the entire waiting element from the DOM.

**Streaming callback pattern** (for incremental UI rendering):
```js
let accText = '';
let assistantCard = null;
const result = await fetchAndStream(url, { method: 'POST', headers, body: JSON.stringify(body), signal },
  (chunkText, fullText) => {
    accText = fullText;
    if (!assistantCard) {
      assistantCard = addMessage('assistant', '回答（流式）', fullText);
    } else {
      const preEl = assistantCard.querySelector('pre');
      if (preEl) preEl.textContent = fullText;
    }
  },
  createOnPhaseCallback()
);
if (result.isStreamed) {
  addBlock('响应 #1', { streamed: true, content: accText }, duration);
} else if (result.json) {
  addBlock('响应 #1', result.json, duration);
}
```

**Tool-calling scenarios with streaming**:

- `fetchAndStream()` accumulates tool call data during streaming and returns it as `result.toolCalls` (provider-native format array, or `null` if no tool calls).
- When `result.isStreamed && result.toolCalls && result.toolCalls.length > 0`: build the provider-native assistant message from accumulated data, process tool calls (same logic as non-streaming), and `continue` the loop.
- When `result.isStreamed && (!result.toolCalls || result.toolCalls.length === 0)`: display accumulated text, show info note `"收到流式文本响应，模型未调用工具，流程结束。"`, and `break`.
- When `result.json` exists (non-streamed fallback): the existing tool-call parsing logic runs unchanged.
- **Break guard**: use `if (isStreamed) break; if (!data) break;` (not `if (isStreamed || !data) break;`) because the streaming-with-tool-calls path uses `continue` and must not hit the break.

**Streaming tool call accumulation per provider**:

- **OpenAI Chat Completions**: Accumulate `delta.tool_calls` by `index`; concat `function.arguments` fragments; store `id` and `name` from first delta.
- **Anthropic Messages**: Track `event:` line type; on `content_block_start` with `type: "tool_use"` store `id`/`name`; on `content_block_delta` with `type: "input_json_delta"` concat `partial_json`.
- **Gemini**: Collect complete `functionCall` objects from `parts[]`; deduplicate by `name` + `args` identity (Gemini sends full response objects per chunk, not deltas).
- **OpenAI Responses API**: Track `response.output_item.added` with `type: "function_call"` for `name`/`call_id`; accumulate `response.function_call_arguments.delta` fragments; use `response.function_call_arguments.done` for complete arguments.

**Dead code notice**: `fetchAndParse` and `ensureJsonOrThrow` are now defined but never called. All scenarios use `fetchAndStream`. Do NOT reintroduce `fetchAndParse` calls.

### Request Debug Block Contract

When rendering an outbound request in the request/response panel, use `addRequestBlock(title, payload, headers)` rather than rendering only the payload. The block must show:

- `请求头`: normalized headers with sensitive values masked.
- `请求体`: the actual prepared JSON/string payload, with sensitive values masked.

For recognized model requests, `fetchAndStream` updates the pending `addRequestBlock` with prepared headers/body or creates one when none exists. Reuse this block; do not add a second debug block or display a pre-profile body as if it were sent. `onPrepared({ url, options, applied, transport })` exposes the final request for diagnostic observers, including the actual endpoint and proxy decision.

Header masking contract:

- Mask sensitive header names such as `Authorization`, `x-api-key`, `api-key`, `token`, `cookie`, `secret`, `password`, and auth/key variants.
- Preserve ordinary debugging headers such as `Content-Type` and provider version headers.
- Copy output must contain the same masked header text visible in the UI, never raw credentials.

Use `sanitizeSensitiveText`, `sanitizeUrlForDisplay`, and `normalizeHeadersForDisplay` on error titles, bodies, URLs, request/copy output, and handled logs. The whole override control payload is sensitive, including nested/encoded/malformed echoes. Remember sent credential variants in memory so later config edits cannot expose earlier secrets. Log sanitized text rather than raw Error objects; see the [Proxy / Request Profile Contract](./proxy-profile-contract.md).

Example:

```js
const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
addRequestBlock('请求 #1', requestBody, requestHeaders);
await fetchAndStream(endpoint, {
  method: 'POST',
  headers: requestHeaders,
  body: JSON.stringify(requestBody),
  signal
}, (chunkText, fullText) => { /* incremental rendering */ }, createOnPhaseCallback());
```

### Vendor-Agnostic Text Test Scenarios

Reusable text-only test items should be added as scenario definitions shared across vendor groups, then routed through the currently selected vendor's standard single-turn text request path:

- OpenAI-compatible vendors: Chat Completions payload `{ model, messages: [{ role: 'user', content }] }` with `Authorization` masked in debug output.
- OpenAI Responses API: payload `{ model, input: [{ role: 'user', content }] }` with `Authorization` masked in debug output. Content type is `input_text` (not `text`), image type is `input_image` (not `image_url`), and `image_url` is a flat string (not `{ url: "..." }`).
- Anthropic-compatible vendors: Messages payload `{ model, max_tokens, messages: [{ role: 'user', content }] }` with `x-api-key` masked in debug output.
- Gemini-compatible vendors: native `{ contents: [{ role: 'user', parts: [{ text }] }] }`; choose `:streamGenerateContent?alt=sse` or `:generateContent` from the captured stream choice. The API key stays in the URL and must be sanitized by URL helpers when rendered.

If a text test has reference metadata, show it as manual comparison information after the response. Do not auto-score free-form model answers unless a dedicated validation tool/schema exists.

### OpenAI Protocol Toggle

OpenAI has two API protocols (Chat Completions and Responses). The segmented control `#openaiProtocol` is visible only when `currentVendor === 'openai'`, including diagnostic/fingerprint scenarios under that vendor.

**State**: `let openaiProtocol = 'chat_completions';` initially. Selecting a scenario preserves the real vendor/protocol; changing vendors does not reset the remembered OpenAI choice. A protocol change stops the old run, rebuilds the scenario list, retains a supported scenario, and enforces global profile compatibility. Profile selection may itself choose the required protocol. Controllers inherit it through activation/run context; use peer scenario selection to move between tests. No auxiliary vendor entries, internal fingerprint format selector, or separate return controls are part of this flow.

**Affected scenarios**: all OpenAI test scenarios. The button list is dynamically generated via `getOpenaiTests()` based on `openaiProtocol` — no protocol labels on buttons (the toggle already indicates the protocol). Search button only appears under Responses (Chat Completions doesn't support it).

**Request format differences**:

| Aspect | Chat Completions | Responses API |
|---|---|---|
| Endpoint | `buildEndpoint(apiUrl)` | `buildResponsesEndpoint(apiUrl)` |
| Top-level field | `messages[]` | `input[]` |
| Text content type | `{ type: 'text', text }` | `{ type: 'input_text', text }` |
| Image content type | `{ type: 'image_url', image_url: { url } }` | `{ type: 'input_image', image_url, detail }` |
| Non-streamed response | `choices[0].message` | `output[].content[]` (find item with `type: 'message'`) |

**Button labels**: no protocol suffix on any button — the toggle already indicates the protocol.

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

<!-- Hook-related mistakes your team has made -->

(To be filled by the team)
