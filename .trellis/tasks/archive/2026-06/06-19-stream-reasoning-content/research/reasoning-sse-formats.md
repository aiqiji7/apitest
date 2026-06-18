# Research: Reasoning/Thinking Content in LLM SSE Streaming Responses

- **Query**: How different LLM API providers return thinking/reasoning content in SSE streaming responses
- **Scope**: External (API documentation from multiple providers)
- **Date**: 2026-06-19

---

## Executive Summary

There are **three distinct patterns** for streaming reasoning content:

| Pattern | Providers | Field Name | How It Works |
|---------|-----------|------------|--------------|
| **A: `delta.reasoning_content`** | DeepSeek, Kimi/Moonshot, Qwen, GLM/Zhipu | `reasoning_content` | Embedded in the same `delta` object as `content` |
| **B: Separate SSE event types** | Claude/Anthropic | `thinking_delta` | Dedicated event type within content blocks |
| **C: Responses API events** | OpenAI Responses API | `reasoning_text.delta` / `reasoning_summary_text.delta` | Typed streaming events |

---

## 1. OpenAI Chat Completions API (`/v1/chat/completions`)

### Streaming Format
```json
data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### Reasoning Content
The **official OpenAI Chat Completions API does NOT have a `reasoning_content` field**. However:

- OpenAI's Go SDK PR #507 shows that **vLLM and other OpenAI-compatible servers** add `reasoning_content` to the delta
- The field is documented in vLLM as part of their OpenAI-compatible output
- For OpenAI's own o1/o3 models, reasoning is handled differently (see Responses API below)

### Client Handling Pattern
```python
# If using OpenAI-compatible APIs that may include reasoning_content:
content = chunk.choices[0].delta.content or ""
reasoning = getattr(chunk.choices[0].delta, 'reasoning_content', None) or None
```

---

## 2. OpenAI Responses API (`/v1/responses`)

The Responses API is OpenAI's next-generation endpoint with **semantic, typed streaming events**.

### Reasoning Summary Streaming (for o1/o3 models)
Event sequence:
```json
{"type":"response.output_item.added","output_index":0,"item":{"id":"...","type":"reasoning"}}
{"type":"response.reasoning_summary_part.added","item_id":"...","output_index":0,"summary_index":0}
{"type":"response.reasoning_summary_text.delta","item_id":"...","output_index":0,"summary_index":0,"delta":"Let me think..."}
{"type":"response.reasoning_summary_text.delta","item_id":"...","output_index":0,"summary_index":0,"delta":" step by step."}
{"type":"response.reasoning_summary_text.done","item_id":"...","output_index":0,"summary_index":0,"text":"Let me think step by step."}
{"type":"response.reasoning_summary_part.done","item_id":"...","output_index":0,"summary_index":0}
{"type":"response.output_item.done","output_index":0}
```

### Reasoning Text Streaming (for GPT-OSS models)
```json
{"type":"response.content_part.added","item_id":"...","output_index":0,"content_index":0,"part":{"type":"reasoning_text"}}
{"type":"response.reasoning_text.delta","item_id":"...","output_index":0,"content_index":0,"delta":"I need to..."}
{"type":"response.reasoning_text.done","item_id":"...","output_index":0,"content_index":0,"text":"I need to solve..."}
{"type":"response.content_part.done","item_id":"...","output_index":0,"content_index":0}
```

### Key Differences
- `reasoning_summary_text.delta` — Short, shareable summary (for o1/o3)
- `reasoning_text.delta` — Full reasoning text (for GPT-OSS models)
- Both use typed events with `item_id`, `output_index`, `summary_index`/`content_index`

---

## 3. DeepSeek API (OpenAI-Compatible)

### Streaming Format
```json
data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}
data: {"choices":[{"delta":{"reasoning_content":"Let me think"},"index":0}]}
data: {"choices":[{"delta":{"reasoning_content":" about this"},"index":0}]}
data: {"choices":[{"delta":{"content":"The answer"},"index":0}]}
data: {"choices":[{"delta":{"content":" is 42"},"index":0}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### Key Characteristics
- **Field name**: `delta.reasoning_content` (NOT `delta.content`)
- **Reasoning streams FIRST**, then `content` follows
- Both fields are in the **same `delta` object**
- In non-streaming: `response.choices[0].message.reasoning_content`

### Client Handling Pattern
```python
reasoning_content = ""
content = ""

for chunk in response:
    delta = chunk.choices[0].delta
    if delta.reasoning_content:
        reasoning_content += delta.reasoning_content
    elif delta.content:
        content += delta.content
```

### Important Edge Case
vLLM issue #43933 reports that `reasoning_content` and `content` can appear in the **same chunk** when the model transitions from thinking to answering. Clients should check both fields per chunk, not assume mutual exclusivity.

### Models
- `deepseek-reasoner` (R1) — always thinks
- `deepseek-v4-pro` — thinking mode via `reasoning_effort` + `extra_body={"thinking": {"type": "enabled"}}`

---

## 4. Kimi/Moonshot API (OpenAI-Compatible)

### Streaming Format
```json
data: {"id":"cmpl-xxx","object":"chat.completion.chunk","model":"kimi-k2.6","choices":[{"index":0,"delta":{"reasoning_content":"Let me analyze"},"finish_reason":null}]}
data: {"id":"cmpl-xxx","object":"chat.completion.chunk","model":"kimi-k2.6","choices":[{"index":0,"delta":{"reasoning_content":" this problem"},"finish_reason":null}]}
data: {"id":"cmpl-xxx","object":"chat.completion.chunk","model":"kimi-k2.6","choices":[{"index":0,"delta":{"content":"Here is"},"finish_reason":null}]}
data: {"id":"cmpl-xxx","object":"chat.completion.chunk","model":"kimi-k2.6","choices":[{"index":0,"delta":{"content":" the answer"},"finish_reason":"stop"}]}
data: [DONE]
```

### Key Characteristics
- **Field name**: `delta.reasoning_content` (same as DeepSeek)
- **Reasoning streams before `content`**
- For `kimi-k2.7-code`, thinking is always on (cannot be disabled)
- For `kimi-k2.6`, thinking is controlled via `thinking.type: "enabled"`
- `thinking.keep: "all"` preserves historical `reasoning_content` in multi-turn

### Client Handling Pattern
```python
for chunk in response:
    delta = chunk.choices[0].delta
    if delta.reasoning_content:
        reasoning += delta.reasoning_content
    if delta.content:
        content += delta.content
```

### Models
- `kimi-k2.7-code` — thinking always on
- `kimi-k2.6` — thinking toggleable
- `kimi-k2.5` — thinking toggleable
- `kimi-k2-thinking` / `kimi-k2-thinking-turbo` — dedicated thinking models

---

## 5. Qwen/Alibaba API (OpenAI-Compatible)

### Streaming Format
```json
data: {"choices":[{"delta":{"reasoning_content":"First"},"index":0}]}
data: {"choices":[{"delta":{"reasoning_content":"I need to"},"index":0}]}
data: {"choices":[{"delta":{"content":"The answer"},"index":0}]}
data: {"choices":[{"delta":{"content":" is"},"index":0}]}
data: [DONE]
```

### Key Characteristics
- **Field name**: `delta.reasoning_content`
- Same pattern as DeepSeek/Kimi
- Enable thinking via `extra_body={"enable_thinking": True}` (OpenAI-compatible)
- For DashScope SDK: `enable_thinking` as direct parameter
- Some models are **thinking-only** (QwQ) — always think, cannot disable
- Some models are **hybrid** (Qwen3) — toggle with `enable_thinking`

### Client Handling Pattern
```python
for chunk in response:
    delta = chunk.choices[0].delta
    if delta.reasoning_content and delta.content is None:
        # Thinking stage
        reasoning += delta.reasoning_content
    elif delta.reasoning_content is None and delta.content:
        # Answering stage
        content += delta.content
```

### Important: Ollama Compatibility
Ollama uses `delta.reasoning` (NOT `delta.reasoning_content`) for Qwen3 models. Libraries must check both fields:
```python
reasoning = getattr(delta, 'reasoning_content', None) or getattr(delta, 'reasoning', None)
```

### Models
- `qwen3.7-max`, `qwen3.7-plus` — hybrid thinking (enabled by default)
- `qwen3-max`, `qwen-plus` — hybrid thinking (disabled by default)
- `qwq-32b` — thinking-only
- `qwen3-30b-a3b-thinking-2507` — thinking-only

---

## 6. GLM/Zhipu API (OpenAI-Compatible)

### Streaming Format
```json
data: {"choices":[{"delta":{"reasoning_content":"Let me think"},"index":0}]}
data: {"choices":[{"delta":{"reasoning_content":" step by step"},"index":0}]}
data: {"choices":[{"delta":{"content":"The answer"},"index":0}]}
data: [DONE]
```

### Key Characteristics
- **Field name**: `delta.reasoning_content`
- Same pattern as DeepSeek/Kimi/Qwen
- Enable thinking via `extra_body={"thinking": {"type": "enabled"}}`
- `clear_thinking: false` enables Preserved Thinking (keeps CoT in multi-turn)
- GLM-4.7 and GLM-5 have thinking enabled by default

### Client Handling Pattern
```python
for chunk in response:
    delta = chunk.choices[0].delta
    if hasattr(delta, "reasoning_content") and delta.reasoning_content:
        reasoning += delta.reasoning_content
    if hasattr(delta, "content") and delta.content:
        content += delta.content
```

### Models
- `glm-4.7`, `glm-4.7-flash` — thinking enabled by default
- `glm-5` — thinking enabled by default
- `glm-z1-air`, `glm-z1-airx`, `glm-z1-flash` — dedicated reasoning models
- `glm-4.5` — hybrid thinking

---

## 7. Claude/Anthropic API (NOT OpenAI-Compatible)

Claude uses a **completely different SSE format** — NOT OpenAI-compatible.

### SSE Event Types
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","content":[],...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" about this"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIY..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

event: message_stop
data: {"type":"message_stop"}
```

### Key Characteristics
- **NOT OpenAI-compatible** — uses named SSE events, not just `data:` lines
- Thinking content uses `thinking_delta` type (NOT `text_delta`)
- Each content block has an `index` — thinking is typically block 0
- A `signature_delta` is sent before `content_block_stop` for thinking blocks
- `display: "omitted"` skips all `thinking_delta` events (only sends `signature_delta`)
- Multiple content blocks: thinking block → text block → optional tool_use blocks

### Client Handling Pattern
```python
for event in stream:
    if event.type == "content_block_start":
        current_block_type = event.content_block.type  # "thinking" or "text"
    elif event.type == "content_block_delta":
        if event.delta.type == "thinking_delta":
            reasoning += event.delta.thinking
        elif event.delta.type == "text_delta":
            content += event.delta.text
    elif event.type == "content_block_stop":
        pass  # Block complete
```

---

## Summary Comparison Table

| Provider | API Endpoint | Reasoning Field | Event Type | Reasoning Before Content | Multi-turn Handling |
|----------|-------------|-----------------|------------|--------------------------|---------------------|
| **DeepSeek** | `/v1/chat/completions` | `delta.reasoning_content` | Embedded in delta | ✅ Yes | Strip reasoning from history (unless tool call) |
| **Kimi/Moonshot** | `/v1/chat/completions` | `delta.reasoning_content` | Embedded in delta | ✅ Yes | Keep reasoning with `thinking.keep: "all"` |
| **Qwen/Alibaba** | `/v1/chat/completions` | `delta.reasoning_content` | Embedded in delta | ✅ Yes | Optional with `preserve_thinking` |
| **GLM/Zhipu** | `/v1/chat/completions` | `delta.reasoning_content` | Embedded in delta | ✅ Yes | Keep with `clear_thinking: false` |
| **Ollama** | `/v1/chat/completions` | `delta.reasoning` | Embedded in delta | ✅ Yes | N/A |
| **vLLM** | `/v1/chat/completions` | `delta.reasoning` or `delta.reasoning_content` | Embedded in delta | ✅ Yes | Depends on parser |
| **OpenAI Responses** | `/v1/responses` | `reasoning_text.delta` or `reasoning_summary_text.delta` | Typed SSE events | ✅ Yes | Via `previous_response_id` |
| **Claude/Anthropic** | `/v1/messages` | `thinking_delta` in content blocks | Named SSE events | ✅ Yes | Pass thinking blocks back |

---

## Recommended Client Implementation

```python
# Universal handler for OpenAI-compatible APIs
def parse_reasoning_stream(chunk):
    """Extract reasoning and content from a streaming chunk."""
    delta = chunk.choices[0].delta
    
    # Check multiple field names for compatibility
    reasoning = (
        getattr(delta, 'reasoning_content', None) or
        getattr(delta, 'reasoning', None) or
        None
    )
    content = getattr(delta, 'content', None) or None
    
    return reasoning, content

# For Claude (non-OpenAI-compatible)
def parse_claude_stream(event):
    """Extract reasoning from Claude SSE events."""
    if event.type == "content_block_delta":
        if event.delta.type == "thinking_delta":
            return event.delta.thinking, None
        elif event.delta.type == "text_delta":
            return None, event.delta.text
    return None, None
```

---

## Caveats / Not Found

1. **OpenAI Chat Completions** — The `reasoning_content` field is NOT part of OpenAI's official API spec; it's added by OpenAI-compatible servers (vLLM, DeepSeek, etc.). Official OpenAI reasoning models use the Responses API.

2. **vLLM field name ambiguity** — vLLM uses `delta.reasoning` (not `delta.reasoning_content`) in some versions. The field name depends on the reasoning parser configuration.

3. **Ollama field name** — Ollama uses `delta.reasoning`, not `delta.reasoning_content`. This is a known compatibility issue.

4. **Mixed chunks** — Some providers (DeepSeek via vLLM) can emit both `reasoning_content` and `content` in the same chunk. Clients should not assume mutual exclusivity.

5. **Signature verification** — Claude requires `signature_delta` for thinking blocks. This is used for integrity verification and cannot be fabricated.
