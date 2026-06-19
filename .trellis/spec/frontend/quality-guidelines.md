# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

### Don't: Create duplicate message cards in streaming+tool-call paths

**Problem**:
```js
// During streaming: creates card A
assistantCard = addMessage('assistant', '回答（流式）', fullText);
// After streaming ends: creates card B (duplicate!)
addMessage('assistant', '模型响应 #1', assistantMsg);
```

**Why it's bad**: Users see two assistant cards for the same turn — a truncated streaming card and a final structured card. The streaming card shows partial text that looks like a broken, incomplete message.

**Instead**:
```js
// During streaming: creates card A
assistantCard = addMessage('assistant', '回答（流式）', fullText);
// After streaming ends: UPDATE card A, don't create card B
updateMessageCard(assistantCard, '模型响应 #1', assistantMsg);
```

### Don't: Use CSS `:empty` / `::after` on streaming content containers

**Problem**:
```css
pre.answer-content:empty {
  border: 2px dashed red;
}
pre.answer-content:empty::after {
  content: '（模型未输出正式回答）';
}
```

**Why it's bad**: During streaming, if reasoning/thinking content arrives before text content, the `<pre>` element is briefly empty. The `:empty` pseudo-class triggers a flash of red border + placeholder text that disappears the instant text content arrives, causing visual flicker.

**Instead**: Handle empty-state display in JS after streaming completes (e.g., check `accumulatedText` and set `pre.textContent` explicitly). Use `min-height` on the base rule to prevent layout collapse when empty.

---

## Required Patterns

### Required Pattern: Sanitize User-Visible Fetch Errors

User-visible fetch errors may include backend response bodies or attempted URLs. Always sanitize before rendering:

- Mask `sk-...` OpenAI-style keys.
- Mask `Bearer ...` and obvious `api_key`, `token`, `authorization`, `secret`, `password`, or `cookie` values.
- Remove URL credentials and sensitive query parameters.
- Prefer `textContent` over string-concatenated HTML when rendering user-controlled error content.

Example:

```js
function sanitizeSensitiveText(text) {
  return String(text || '')
    .replace(/(sk-)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/([?&#;](?:api[_-]?key|token|access_token|authorization|secret|password|cookie)=)[^&#;\s]+/gi, '$1***')
    .trim();
}
```

---

## API Response Parsing

### Gotcha: CDATA-wrapped thinking content in `content` string field

> **Warning**: Some providers (e.g., GLM) embed thinking/reasoning content inside the `content` string field wrapped in `<![CDATA[...]]>` tags, instead of using dedicated `reasoning_content` / `reasoning` fields.
>
> Example:
> ```json
> {
>   "role": "assistant",
>   "content": "<![CDATA[\n我需要将十进制数 4404251 转换为八进制...\n]]>",
>   "tool_calls": [...]
> }
> ```
>
> The code must extract CDATA blocks as reasoning text and strip them from the displayed content. Key edge cases:
> - **Streaming**: `<![CDATA[` opening tag may be split across SSE chunks — use a `cdataOpenBuffer` to buffer partial opening tags
> - **Multiple CDATA blocks**: A single `content` string may contain multiple `<![CDATA[...]]>` blocks — use global regex for extraction
> - **Unclosed CDATA**: If the stream ends with an unclosed CDATA block, treat buffered content as reasoning (graceful degradation)
> - **Content after CDATA**: Text before/after CDATA blocks is still normal content and must be displayed

### Gotcha: XML-tag thinking blocks (` thinking\n...`) in `content` string field

> **Warning**: Some providers (e.g., DeepSeek via certain API proxies) embed thinking/reasoning content inside the `content` string field using XML-style tags ` thinking\n` and ` response\n`, instead of using dedicated `reasoning_content` fields.
>
> Example (thinking only, no response separator):
> ```json
> {
>   "role": "assistant",
>   "content": " thinking\n用户想要将二进制数转换为十六进制。我需要使用 convert_base 工具。",
>   "tool_calls": [...]
> }
> ```
>
> Example (with ` response\n` separator):
> ```json
> {
>   "role": "assistant",
>   "content": " thinking\n转换完成了。结果是 f33abe。\n response\n转换完成！结果是 `f33abe`。",
>   "tool_calls": [...]
> }
> ```
>
> **Format rules**:
> - ` thinking\n` — marks the start of thinking content
> - ` response\n` — marks the end of thinking and start of actual response (**optional**)
> - When no ` response\n` is present, everything after ` thinking\n` to end of content is thinking
>
> The code must extract the thinking portion as reasoning text and strip it from the displayed content. Key edge cases:
> - **Streaming**: ` thinking\n` opening tag may be split across SSE chunks — use a `thinkOpenBuffer` to buffer partial opening tags (same pattern as CDATA handling)
> - **End marker detection**: In streaming, check each chunk for `\n response\n` to detect the transition from thinking to response content
> - **Unclosed block**: If the stream ends while still inside a thinking block, treat buffered content as reasoning (graceful degradation)
> - **Non-streaming**: Use `startsWith(' thinking\n')` to detect, then `indexOf('\n response\n')` to split — simpler than streaming since the full content is available

### Pattern: Reasoning content extraction priority

When extracting reasoning/thinking content from API responses, check in this order:

1. `choices[0].message.reasoning_content` (DeepSeek, Kimi, Qwen, GLM)
2. `choices[0].message.reasoning` (Ollama, vLLM)
3. `content[].type === "thinking"` blocks (Anthropic)
4. `output[].type === "reasoning"` items (Responses API)
5. `candidates[].content.parts[].thought` (Gemini)
6. `<![CDATA[...]]>` in `content` string (GLM and similar)
7. ` thinking\n...` XML-tag blocks in `content` string (DeepSeek via certain proxies)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
