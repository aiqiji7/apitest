# Research: Request Construction Patterns

- **Query**: Find ALL locations where API request bodies are constructed for each vendor, understand model value flow, and identify existing parameter injection patterns
- **Scope**: internal
- **Date**: 2026-06-24
- **File**: `assets/js/script.js` (4124 lines total)

## Overview

There is **NO centralized request builder**. Each scenario constructs its own request body inline. The codebase follows a pattern where request objects are built as plain JS objects and passed to `fetchAndStream()`. There are ~12 distinct request construction sites across 4 vendors.

---

## 1. Model Value Flow: UI → Request Body

### Source: UI Input
```javascript
// Line 9: const modelEl = $('#model');
// Line 1879: const model = (modelEl.value || SYSTEM_DEFAULTS.model).trim();
```

### Default Value Chain
```javascript
// Lines 152-157
const ENV_CFG = (typeof window !== 'undefined' && window.APP_CONFIG && typeof window.APP_CONFIG === 'object') ? window.APP_CONFIG : {};
const SYSTEM_DEFAULTS = {
  apiUrl: ENV_CFG.apiUrl || 'https://api.openai.com',
  apiKey: ENV_CFG.apiKey || '',
  model: ENV_CFG.model || 'gemini-3-flash-preview'
};
```

### Propagation Path
1. `modelEl.value` (UI input) → `model` variable (line 1879)
2. `model` is passed to `sendStandardTextRequestForVendor()` (lines 1922, 1937) or used directly in each scenario block
3. `model` is inserted into request body as `model` key for OpenAI/Anthropic, but **NOT included** in Gemini request bodies (Gemini uses model in the endpoint URL instead)

### Endpoint Construction with Model
```javascript
// Line 133: OpenAI Chat Completions - model NOT in URL
function buildEndpoint(base) { return stripTrailingSlash(applyProxy(base)) + '/v1/chat/completions'; }

// Lines 134-137: Gemini - model IS in URL
function buildGeminiEndpoint(base, model, apiKey) {
  const root = stripTrailingSlash(applyProxy(base));
  return `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

// Line 142-144: Anthropic - model NOT in URL
function buildAnthropicEndpoint(base) { return `${root}/v1/messages`; }

// Line 146-148: OpenAI Responses - model NOT in URL
function buildResponsesEndpoint(base) { return `${root}/v1/responses`; }
```

---

## 2. Request Construction Sites by Vendor

### 2.1 OpenAI Chat Completions

#### Site A: `sendStandardTextRequestForVendor()` — Standard text request
**Location**: Lines 1105-1113
**Function**: `sendStandardTextRequestForVendor()`
**Used by**: IQ tests, `openai_juice` scenario
```javascript
requestBody = {
  model,
  messages: [{ role: 'user', content: userText }],
  stream: isStreamEnabled()
};
```

#### Site B: `openai_tools` scenario — Tool calling loop
**Location**: Line 1999
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const requestBody = { model, messages, tools, tool_choice: 'auto', stream: isStreamEnabled() };
```

#### Site C: `openai_image` scenario — Image input
**Location**: Line 2998
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
oReq = { model, messages: [{ role: 'user', content: contentParts }], stream: isStreamEnabled() };
```

---

### 2.2 OpenAI Responses API

#### Site D: `sendStandardTextRequestForVendor()` — Standard text request
**Location**: Lines 1097-1101
**Function**: `sendStandardTextRequestForVendor()`
```javascript
requestBody = {
  model,
  input: [{ role: 'user', content: userText }],
  stream: isStreamEnabled()
};
```

#### Site E: `responses_tools` scenario — Tool calling loop
**Location**: Line 2590
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const rtReq = { model, tools, input: history, instructions: '...', stream: isStreamEnabled() };
```

#### Site F: `responses_search` scenario — Web search
**Location**: Lines 2771-2776
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const rReq = {
  model,
  tools: [{ type: 'web_search' }],
  input: [{ role: 'user', content: userText || '搜索当前最新的Gemini旗舰模型是？' }],
  stream: isStreamEnabled()
};
```

#### Site G: `openai_image` scenario (Responses protocol) — Image input
**Location**: Line 2989
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
oReq = { model, input: [{ role: 'user', content: contentParts }], stream: isStreamEnabled() };
```

---

### 2.3 Anthropic Messages API

#### Site H: `sendStandardTextRequestForVendor()` — Standard text request
**Location**: Lines 1078-1083
**Function**: `sendStandardTextRequestForVendor()`
```javascript
requestBody = {
  model,
  max_tokens: 4096,
  messages: [{ role: 'user', content: userText }],
  stream: isStreamEnabled()
};
```

#### Site I: `anthropic_tools` scenario — Tool calling loop
**Location**: Lines 2188-2195
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const aReq = {
  model,
  max_tokens: 1024,
  messages,
  tools,
  system: A_SYSTEM_INSTRUCTION,
  stream: isStreamEnabled()
};
```

#### Site J: `anthropic_image` scenario — Image input
**Location**: Lines 3079-3089
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const aReq = {
  model,
  max_tokens: 1024,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: userText },
      { type: 'image', source }
    ]
  }],
  stream: isStreamEnabled()
};
```

---

### 2.4 Google Gemini API

#### Site K: `sendStandardTextRequestForVendor()` — Standard text request
**Location**: Lines 1088-1091
**Function**: `sendStandardTextRequestForVendor()`
```javascript
requestBody = {
  contents: [{ role: 'user', parts: [{ text: userText }] }],
  stream: isStreamEnabled()
};
```
**Note**: `model` is NOT in the request body — it's in the endpoint URL.

#### Site L: `gemini_tools` scenario — Tool calling loop
**Location**: Lines 2389-2395
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const gReq = {
  systemInstruction: { parts: [{ text: '...' }] },
  tools: [{ functionDeclarations }],
  toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  contents,
  stream: isStreamEnabled()
};
```

#### Site M: `gemini_search` scenario — Google Search grounding
**Location**: Lines 2856-2860
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const gReq = {
  tools: [{ googleSearch: {} }],
  contents: [{ role: 'user', parts: [{ text: userText || '...' }] }],
  stream: isStreamEnabled()
};
```

#### Site N: `gemini_url_context` scenario — URL context grounding
**Location**: Lines 2918-2922
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const gReq = {
  tools: [{ urlContext: {} }],
  contents: [{ role: 'user', parts: [{ text: userText || '...' }] }],
  stream: isStreamEnabled()
};
```

#### Site O: `gemini_image` scenario — Image input
**Location**: Lines 3154-3163
**Function**: Inline in `testBtn.addEventListener` click handler
```javascript
const gReq = {
  contents: [{
    role: 'user',
    parts: [
      { text: userText },
      imagePart
    ]
  }],
  stream: isStreamEnabled()
};
```

---

## 3. Request Headers by Vendor

| Vendor | Headers | Location |
|--------|---------|----------|
| OpenAI Chat Completions | `{ 'Content-Type': 'application/json', 'Authorization': 'Bearer ${apiKey}' }` | Lines 1111, 2000, 2999 |
| OpenAI Responses | `{ 'Content-Type': 'application/json', 'Authorization': 'Bearer ${apiKey}' }` | Lines 1102, 2591, 2777, 2990 |
| Anthropic | `{ 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }` | Lines 1084, 2196, 3091 |
| Google Gemini | `{ 'Content-Type': 'application/json' }` | Lines 1092, 2396, 2861, 2923, 3164 |

---

## 4. Request Body Structure Summary

| Vendor | Body Key for Messages | Model Key | Stream Key | Extra Keys |
|--------|----------------------|-----------|------------|------------|
| OpenAI Chat Completions | `messages` | `model` | `stream` | `tools`, `tool_choice` |
| OpenAI Responses | `input` | `model` | `stream` | `tools`, `instructions` |
| Anthropic | `messages` | `model` | `stream` | `max_tokens`, `system`, `tools` |
| Google Gemini | `contents` | _(in URL)_ | `stream` | `tools`, `toolConfig`, `systemInstruction` |

---

## 5. Existing Parameter Injection Patterns

### No Existing Thinking/Reasoning Injection
There are **NO existing patterns** for injecting thinking/reasoning parameters into request bodies. The codebase currently:
- **Reads** reasoning/thinking from responses (streaming and non-streaming)
- **Does NOT send** any thinking budget or reasoning effort parameters

### Reasoning Extraction (Response-Side Only)
The codebase extracts reasoning from responses via multiple provider-specific formats:

#### Streaming Reasoning Extraction (in `fetchAndStream()`, lines 3363-3751)
- **OpenAI Chat Completions**: `delta.reasoning_content` or `delta.reasoning` (line 3425)
- **Anthropic**: `chunk.content_block.type === 'thinking'` + `chunk.delta.thinking_delta` (lines 3456, 3471)
- **Gemini**: `part.thought && part.thoughtText` (line 3506)
- **OpenAI Responses**: `chunk.type === 'response.reasoning_text.delta'` or `response.reasoning_summary_text.delta` (lines 3540, 3549)
- **CDATA-wrapped thinking** (e.g., GLM): extracted from `<![CDATA[...]]>` in content (lines 3574-3624)
- **XML-tag thinking** (e.g., DeepSeek): ` thinking\n...` in content (lines 3653-3717)

#### Non-Streaming Reasoning Extraction (`extractReasoningFromJson()`, lines 3838-3887)
- **Chat Completions**: `choices[0].message.reasoning_content` or `choices[0].message.reasoning`
- **Anthropic**: `content[]` blocks with `type === 'thinking'`
- **Responses API**: `output[]` items with `type === 'reasoning'`
- **Gemini**: `candidates[0].content.parts` with `thought === true`

### Reusable Pattern: `stream` Toggle
The `isStreamEnabled()` function (line 990) is the only parameter that's consistently injected across all request bodies. It reads from a UI toggle element:
```javascript
function isStreamEnabled() {
  return !streamToggleEl || streamToggleEl.checked;
}
```

### Reusable Pattern: `max_tokens` Injection (Anthropic Only)
Anthropic requests consistently include `max_tokens` (4096 in standard, 1024 in tool/image scenarios). This is hardcoded, not from UI.

---

## 6. Centralized vs. Decentralized Architecture

### Architecture: Fully Decentralized
- **No** centralized request builder function
- **No** request middleware or interceptor
- Each scenario block (openai_tools, anthropic_tools, gemini_tools, etc.) builds its own request object inline
- The only shared function is `sendStandardTextRequestForVendor()` which handles simple text requests for all vendors
- `fetchAndStream()` (line 3253) is the single HTTP transport layer — all requests flow through it

### Dispatch Logic
The main dispatch is in `testBtn.addEventListener` (line 1875) which routes to:
1. `sendStandardTextRequestForVendor()` for IQ tests and `openai_juice` (lines 1919-1948)
2. Inline scenario blocks for tool/image/search scenarios (lines 1950-3240)

### Key Functions
| Function | Lines | Purpose |
|----------|-------|---------|
| `buildEndpoint()` | 133 | OpenAI Chat Completions URL |
| `buildGeminiEndpoint()` | 134-137 | Gemini non-streaming URL |
| `buildGeminiStreamEndpoint()` | 138-141 | Gemini streaming URL |
| `buildAnthropicEndpoint()` | 142-144 | Anthropic URL |
| `buildResponsesEndpoint()` | 146-148 | OpenAI Responses URL |
| `sendStandardTextRequestForVendor()` | 1073-1231 | Multi-vendor text request handler |
| `fetchAndStream()` | 3253-3820 | HTTP transport + SSE parsing |

---

## 7. Complete Scenario-to-Request Mapping

| Scenario | Vendor | Request Body Location | Model In Body? |
|----------|--------|----------------------|----------------|
| IQ tests (all vendors) | vendor-dependent | Lines 1077-1113 | Yes (except Gemini) |
| `openai_juice` | OpenAI | Lines 1077-1113 | Yes |
| `openai_tools` | OpenAI | Line 1999 | Yes |
| `anthropic_tools` | Anthropic | Lines 2188-2195 | Yes |
| `gemini_tools` | Google | Lines 2389-2395 | No (in URL) |
| `responses_tools` | OpenAI | Line 2590 | Yes |
| `responses_search` | OpenAI | Lines 2771-2776 | Yes |
| `gemini_search` | Google | Lines 2856-2860 | No (in URL) |
| `gemini_url_context` | Google | Lines 2918-2922 | No (in URL) |
| `openai_image` (Chat) | OpenAI | Line 2998 | Yes |
| `openai_image` (Responses) | OpenAI | Line 2989 | Yes |
| `anthropic_image` | Anthropic | Lines 3079-3089 | Yes |
| `gemini_image` | Google | Lines 3154-3163 | No (in URL) |

---

## 8. Lines Reference Quick-Start

For adding thinking/effort parameters, the key injection points would be:

### OpenAI Chat Completions (3 sites)
- Line 1106-1110: `sendStandardTextRequestForVendor()` else branch
- Line 1999: `openai_tools` scenario
- Line 2998: `openai_image` Chat Completions branch

### OpenAI Responses API (4 sites)
- Line 1097-1101: `sendStandardTextRequestForVendor()` responses branch
- Line 2590: `responses_tools` scenario
- Lines 2771-2776: `responses_search` scenario
- Line 2989: `openai_image` Responses branch

### Anthropic Messages API (3 sites)
- Lines 1078-1083: `sendStandardTextRequestForVendor()` anthropic branch
- Lines 2188-2195: `anthropic_tools` scenario
- Lines 3079-3089: `anthropic_image` scenario

### Google Gemini API (5 sites)
- Lines 1088-1091: `sendStandardTextRequestForVendor()` google branch
- Lines 2389-2395: `gemini_tools` scenario
- Lines 2856-2860: `gemini_search` scenario
- Lines 2918-2922: `gemini_url_context` scenario
- Lines 3154-3163: `gemini_image` scenario

---

## Caveats / Not Found

1. **No centralized request builder** — each scenario builds requests independently. Any new parameter (like thinking budget) must be injected at each of the ~15 sites listed above, or a refactoring to centralize request building would be needed.

2. **No existing thinking parameter injection** — the codebase only reads thinking/reasoning from responses, never sends thinking configuration in requests.

3. **Gemini model is in URL, not body** — any thinking parameter for Gemini would need to be added to the request body separately from the model parameter.

4. **`max_tokens` is hardcoded per vendor** — not configurable from UI, injected directly in request body construction.

5. **The `stream` parameter** is the only consistently injected parameter across all request bodies, via `isStreamEnabled()`.
