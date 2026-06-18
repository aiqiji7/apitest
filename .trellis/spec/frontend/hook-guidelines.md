# Hook Guidelines

> How hooks are used in this project.

---

## Overview

<!--
Document your project's hook conventions here.

Questions to answer:
- What custom hooks do you have?
- How do you handle data fetching?
- What are the naming conventions?
- How do you share stateful logic?
-->

(To be filled by the team)

---

## Custom Hook Patterns

<!-- How to create and structure custom hooks -->

(To be filled by the team)

---

## Data Fetching

### Fetch Error Display Contract

When frontend code fetches data and renders errors in the UI, preserve the distinction between an HTTP response and a browser/network failure.

**HTTP response exists**:
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
    title: `请求失败：HTTP ${err.status}${err.statusText ? ' ' + err.statusText : ''}`,
    details: [
      `请求：GET ${sanitizeUrlForDisplay(modelUrl)}`,
      `后端返回：${getBackendResponseSummary(err.responseBody)}`
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

The request-test flow uses `fetchAndStream()` for all scenarios. It must still convert browser `TypeError: Failed to fetch` into a named `FetchNetworkError` with `url` and `method`, then render the same contextual network hints. Do not show the raw browser message as the user-facing error.

### Streaming Request Contract

All API requests MUST explicitly request streaming. The `stream` property in request bodies MUST use `isStreamEnabled()` (wired to the `#streamToggle` checkbox), not a hardcoded `true`. This ensures the UI toggle actually controls streaming behavior. The approach differs by provider:

**OpenAI Chat Completions** (`/v1/chat/completions`):
- Add `stream: true` to the request body.
- SSE response: `data: {"choices":[{"delta":{"content":"..."}}]}` lines.

**Anthropic Messages** (`/v1/messages`):
- Add `stream: true` to the request body.
- SSE response: `event: content_block_delta` with `delta.text`.

**Gemini** (`/v1beta/models/{model}:streamGenerateContent?alt=sse&key={key}`):
- Must use the `:streamGenerateContent` endpoint with `alt=sse` query parameter when streaming is enabled; fall back to `:generateContent` when streaming is disabled.
- The regular `:generateContent` endpoint ignores `stream: true` in the body.
- **Gotcha**: Tool-calling scenarios must also respect the stream toggle — use `isStreamEnabled() ? geminiStreamEndpoint : geminiEndpoint` to select the correct endpoint.
- SSE response: `data:` lines with `candidates[0].content.parts[0].text`.

**`fetchAndStream(url, options, onChunk)` helper**:
```js
async function fetchAndStream(url, options, onChunk) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  const isSse = contentType.includes('text/event-stream');
  if (!isSse || !res.body) {
    // Non-streaming fallback
    const text = await res.text();
    const json = JSON.parse(text);
    return { json, text, contentType, isStreamed: false };
  }
  // SSE parsing: handles OpenAI, Anthropic, Gemini chunk formats
  // Calls onChunk(chunkText, fullText) for incremental UI updates
  return { isStreamed: true };
}
```

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
  }
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
- `请求体`: the JSON/string payload exactly as sent.

Header masking contract:

- Mask sensitive header names such as `Authorization`, `x-api-key`, `api-key`, `token`, `cookie`, `secret`, `password`, and auth/key variants.
- Preserve ordinary debugging headers such as `Content-Type` and provider version headers.
- Copy output must contain the same masked header text visible in the UI, never raw credentials.

Example:

```js
const requestHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
addRequestBlock('请求 #1', requestBody, requestHeaders);
await fetchAndStream(endpoint, {
  method: 'POST',
  headers: requestHeaders,
  body: JSON.stringify(requestBody),
  signal
}, (chunkText, fullText) => { /* incremental rendering */ });
```

### Vendor-Agnostic Text Test Scenarios

Reusable text-only test items should be added as scenario definitions shared across vendor groups, then routed through the currently selected vendor's standard single-turn text request path:

- OpenAI-compatible vendors: Chat Completions payload `{ model, messages: [{ role: 'user', content }] }` with `Authorization` masked in debug output.
- Anthropic-compatible vendors: Messages payload `{ model, max_tokens, messages: [{ role: 'user', content }] }` with `x-api-key` masked in debug output.
- Gemini-compatible vendors: `streamGenerateContent` endpoint `{ contents: [{ role: 'user', parts: [{ text }] }] }` with `alt=sse` query parameter; the API key stays in the URL and must be sanitized by URL helpers when rendered. Use `:streamGenerateContent?alt=sse`, not `:generateContent`.

If a text test has reference metadata, show it as manual comparison information after the response. Do not auto-score free-form model answers unless a dedicated validation tool/schema exists.

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

<!-- Hook-related mistakes your team has made -->

(To be filled by the team)
