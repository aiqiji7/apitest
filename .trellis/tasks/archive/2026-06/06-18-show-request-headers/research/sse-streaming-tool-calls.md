# SSE Streaming Format for Tool Calls — Provider Reference

> Research date: 2026-06-19
> Sources: OpenAI docs, Anthropic docs, Google AI docs, GitHub real-world implementations

---

## 1. OpenAI Chat Completions (`/v1/chat/completions` with `stream: true`)

### SSE Wire Format

Each chunk is a `data:` line containing a JSON object. The stream ends with `data: [DONE]`.

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me "},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"check that."},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"loc"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

### Key Structure: `delta.tool_calls`

Each tool call delta is an array element with:
- `index` (number): Identifies which tool call this delta belongs to (for parallel calls)
- `id` (string, optional): The unique call ID — only present in the **first** delta for that call
- `type` (string, optional): Always `"function"` — only present in the **first** delta
- `function` (object):
  - `name` (string, optional): Function name — only present in the **first** delta (but see edge case below)
  - `arguments` (string): Incremental JSON fragment of the arguments

### Algorithm to Accumulate Tool Calls

```typescript
// State
const toolCalls: Map<number, { id?: string; name?: string; arguments: string }> = new Map();

for (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  const finishReason = chunk.choices[0]?.finish_reason;

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index;
      if (!toolCalls.has(idx)) {
        toolCalls.set(idx, { id: undefined, name: undefined, arguments: '' });
      }
      const existing = toolCalls.get(idx)!;

      if (tc.id) existing.id = tc.id;
      if (tc.type) /* ignore, always "function" */;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.arguments += tc.function.arguments;
    }
  }

  if (finishReason === 'tool_calls') {
    // Stream complete — parse each tool call's arguments
    for (const [idx, tc] of toolCalls) {
      const args = JSON.parse(tc.arguments);
      // tc.id, tc.name, args are now complete
    }
  }
}
```

### Edge Cases

1. **`function.name` arrives in a later chunk**: Some OpenAI-compatible providers send the first delta with `id` and `arguments` but **without** `name`, then send `name` in a subsequent delta. The accumulator must not validate `name` until the stream ends. (Source: vercel/ai#14722)

2. **Mixed text + tool calls**: The model can emit `content` deltas before `tool_calls` deltas in the same response. Both appear in `choices[0].delta` across different chunks.

3. **Multiple parallel tool calls**: Each gets its own `index` (0, 1, 2...). Deltas for different tool calls are interleaved in the stream, distinguished by `index`.

4. **Empty arguments**: For parameterless tools, `arguments` may be `""` (empty string) throughout — no JSON to parse.

5. **`finish_reason: "tool_calls"`**: The terminal chunk has `finish_reason: "tool_calls"` (not `"stop"`).

---

## 2. Anthropic Messages (`/v1/messages` with `stream: true`)

### SSE Wire Format

Uses standard SSE with **named events** (not just `data:` lines). Each event has `event: <type>` followed by `data: <json>`.

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_abc","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01XYZ","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"loc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ation\": \""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"Paris\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

### Event Lifecycle

1. `message_start` — contains metadata (id, model, role), empty `content: []`
2. For each content block:
   - `content_block_start` — declares block `index` and `type` (`text`, `tool_use`, `thinking`, etc.)
   - One or more `content_block_delta` — incremental data
   - `content_block_stop` — block complete
3. `message_delta` — top-level updates (`stop_reason`, usage)
4. `message_stop` — stream complete

### Key Structure: `tool_use` Content Block

**`content_block_start`** (first event for the tool):
```json
{
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "tool_use",
    "id": "toolu_01XYZ",
    "name": "get_weather",
    "input": {}
  }
}
```

**`content_block_delta`** (subsequent events):
```json
{
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\": \"Paris\"}"
  }
}
```

The `partial_json` field contains **partial JSON strings**. The final `tool_use.input` is always a complete JSON object.

### Algorithm to Accumulate Tool Calls

```typescript
// State
const toolCalls: Map<number, { id: string; name: string; jsonBuf: string }> = new Map();
let stopReason: string | null = null;

for await (const event of stream) {
  if (event.type === 'content_block_start') {
    if (event.content_block.type === 'tool_use') {
      toolCalls.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        jsonBuf: '',
      });
    }
  } else if (event.type === 'content_block_delta') {
    if (event.delta.type === 'input_json_delta') {
      const existing = toolCalls.get(event.index);
      if (existing) {
        existing.jsonBuf += event.delta.partial_json;
      }
    }
  } else if (event.type === 'message_delta') {
    stopReason = event.delta.stop_reason;
  }
}

if (stopReason === 'tool_use') {
  for (const [index, tc] of toolCalls) {
    const input = JSON.parse(tc.jsonBuf);
    // tc.id, tc.name, input are now complete
  }
}
```

### Edge Cases

1. **`input_json_delta` delivers one key-value pair at a time**: Anthropic models emit one complete key and its value per delta, then emit multiple sub-deltas to chunk that value. This means there can be **delays between deltas** while the model generates the next key. (Source: Anthropic docs)

2. **Multiple tool calls**: Each gets its own `index` (0, 1, 2...) via separate `content_block_start` events. They are **sequential**, not interleaved — each tool_use block completes before the next starts.

3. **Mixed content blocks**: Text blocks and tool_use blocks alternate, each with their own index. A text block at index 0, then a tool_use block at index 1.

4. **`stop_reason: "tool_use"`**: The `message_delta` event sets `stop_reason` to `"tool_use"` (not `"end_turn"`).

5. **`input` starts as `{}`**: The `content_block_start` declares `input: {}`, and the deltas stream the actual JSON into it.

---

## 3. OpenAI Responses API (`/v1/responses` with `stream: true`)

### SSE Wire Format

Uses standard SSE with **named events** via `event:` lines. Each event has `type` in the JSON payload.

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_abc","object":"response","created_at":1234567890,"status":"in_progress","model":"gpt-4o"}}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_abc","status":"in_progress"}}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_001","type":"function_call","status":"in_progress","arguments":"","call_id":"call_xyz","name":"get_weather"},"output_index":0}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"{\"loc","item_id":"fc_001","output_index":0}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"ation\": ","item_id":"fc_001","output_index":0}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"\"Paris\"}","item_id":"fc_001","output_index":0}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"{\"location\":\"Paris\"}","item_id":"fc_001","output_index":0}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_001","type":"function_call","status":"completed","arguments":"{\"location\":\"Paris\"}","call_id":"call_xyz","name":"get_weather"},"output_index":0}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_abc","status":"completed","output":[{"id":"fc_001","type":"function_call","status":"completed","arguments":"{\"location\":\"Paris\"}","call_id":"call_xyz","name":"get_weather"}],"usage":{"input_tokens":46,"output_tokens":15,"total_tokens":61}}}

data: [DONE]
```

### Event Lifecycle for Function Calls

1. `response.created` — response object with `status: "in_progress"`
2. `response.in_progress` — confirms processing started
3. `response.output_item.added` — declares a new output item (`type: "function_call"`)
   - Contains: `item.id`, `item.type`, `item.name`, `item.call_id`, `item.arguments: ""`
4. Zero or more `response.function_call_arguments.delta` — incremental JSON fragments
   - Contains: `delta` (string fragment), `item_id`, `output_index`
5. `response.function_call_arguments.done` — complete arguments string
6. `response.output_item.done` — complete function call item
7. `response.completed` — final response with all output items and usage
8. `data: [DONE]` — stream end

### Key Structure: Function Call Events

**`response.output_item.added`** (declares the call):
```json
{
  "type": "response.output_item.added",
  "item": {
    "id": "fc_001",
    "type": "function_call",
    "status": "in_progress",
    "arguments": "",
    "call_id": "call_xyz",
    "name": "get_weather"
  },
  "output_index": 0
}
```

**`response.function_call_arguments.delta`** (argument fragments):
```json
{
  "type": "response.function_call_arguments.delta",
  "delta": "{\"location",
  "item_id": "fc_001",
  "output_index": 0
}
```

**`response.function_call_arguments.done`** (complete arguments):
```json
{
  "type": "response.function_call_arguments.done",
  "arguments": "{\"location\":\"Paris\"}",
  "item_id": "fc_001",
  "output_index": 0
}
```

### Algorithm to Accumulate Function Calls

```typescript
// State
const functionCalls: Map<number, {
  itemId: string;
  name: string;
  callId: string;
  argumentsBuf: string;
}> = new Map();

for await (const event of stream) {
  if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
    functionCalls.set(event.output_index, {
      itemId: event.item.id,
      name: event.item.name,
      callId: event.item.call_id,
      argumentsBuf: '',
    });
  } else if (event.type === 'response.function_call_arguments.delta') {
    const existing = functionCalls.get(event.output_index);
    if (existing) {
      existing.argumentsBuf += event.delta;
    }
  } else if (event.type === 'response.function_call_arguments.done') {
    const existing = functionCalls.get(event.output_index);
    if (existing) {
      existing.argumentsBuf = event.arguments; // complete JSON
    }
  } else if (event.type === 'response.completed') {
    // Final response with complete output items
    for (const item of event.response.output) {
      if (item.type === 'function_call') {
        // item.arguments is complete, item.call_id and item.name are set
      }
    }
  }
}
```

### Edge Cases

1. **`response.completed` provides the complete state**: Even if you miss some deltas, the final `response.completed` event contains the full `output` array with complete `arguments` strings. You can fall back to this.

2. **Mixed text + function calls**: The response can contain both `message` items (with text) and `function_call` items in the same `output` array. They appear as separate `output_item.added` events.

3. **Multiple parallel function calls**: Each gets its own `output_index` (0, 1, 2...). The `response.output_item.added` event declares each one.

4. **`sequence_number`**: Each event has a monotonically increasing `sequence_number` for detecting gaps.

5. **`response.output_item.done`**: Provides the complete item state after streaming is done.

---

## 4. Gemini (`streamGenerateContent?alt=sse` with `tools`)

### SSE Wire Format

Each `data:` line contains a **complete** `GenerateContentResponse` (not deltas). Gemini streaming sends full response objects per chunk, not incremental deltas.

```
data: {"candidates":[{"content":{"parts":[{"text":"Let me "},"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4,"totalTokenCount":14}}

data: {"candidates":[{"content":{"parts":[{"text":"check that."}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"totalTokenCount":16}}
```

**With function calls (classic `streamGenerateContent`):**

```
data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"Paris"}}}],"role":"model"},"finishReason":"STOP","index":0,"finishMessage":"Model generated function call(s)."}],"usageMetadata":{"promptTokenCount":15,"candidatesTokenCount":12,"totalTokenCount":27}}
```

**With parallel function calls:**

```
data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"sum","args":{"a":2,"b":3}}},{"functionCall":{"name":"sum","args":{"a":4,"b":5}}},{"functionCall":{"name":"sum","args":{"a":6,"b":7}}}],"role":"model"},"finishReason":"STOP","index":0,"finishMessage":"Model generated function call(s)."}],"usageMetadata":{"promptTokenCount":171,"candidatesTokenCount":54,"totalTokenCount":225}}
```

### Key Structure: `functionCall` Part

```json
{
  "candidates": [{
    "content": {
      "parts": [
        {
          "functionCall": {
            "name": "get_weather",
            "args": {"location": "Paris"},
            "id": "abc123"  // Gemini 3+ only
          }
        }
      ],
      "role": "model"
    },
    "finishReason": "STOP",
    "index": 0
  }]
}
```

### Algorithm to Accumulate Function Calls

```typescript
// Gemini streaming sends COMPLETE response objects per chunk, not deltas
const functionCalls: Array<{ name: string; args: Record<string, any>; id?: string }> = [];

for await (const chunk of stream) {
  const candidate = chunk.candidates?.[0];
  if (!candidate) continue;

  for (const part of candidate.content?.parts || []) {
    if (part.functionCall) {
      functionCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args,  // Already a complete object!
        id: part.functionCall.id,       // Gemini 3+ only
      });
    }
  }
}
```

### Edge Cases

1. **Complete objects, not deltas**: Unlike OpenAI and Anthropic, Gemini sends the **full `functionCall` object** in a single chunk. No incremental JSON accumulation needed for `args`. However, there may be multiple chunks per response, and function calls may appear in any chunk.

2. **`functionCall.id` only in Gemini 3+**: Older Gemini models (2.0, 2.5) do **not** return an `id` field in `functionCall`. You must generate synthetic IDs for these. Gemini 3+ always returns a unique `id`.

3. **`thoughtSignature`**: Gemini 2.5+ and 3+ models may include `thoughtSignature` fields in parts. These are opaque encrypted strings that must be returned exactly as-is in subsequent conversation turns.

4. **Parallel calls in one chunk**: Multiple `functionCall` parts can appear in the same chunk's `parts` array. They are **not** streamed incrementally — all args arrive at once.

5. **`finishReason: "STOP"` with `finishMessage`**: When function calls are present, `finishReason` is still `"STOP"` (not a separate code), but `finishMessage` may indicate `"Model generated function call(s)."`

6. **No named SSE events**: Unlike Anthropic and OpenAI Responses API, Gemini uses plain `data:` lines without `event:` type names.

---

## 5. Comparison Summary

| Feature | OpenAI Chat Completions | Anthropic Messages | OpenAI Responses API | Gemini |
|---|---|---|---|---|
| **SSE format** | `data:` only | `event:` + `data:` | `event:` + `data:` | `data:` only |
| **Stream end signal** | `data: [DONE]` | `message_stop` event | `data: [DONE]` | Last chunk |
| **Tool call declaration** | `delta.tool_calls[0].id` + `.name` | `content_block_start` with `type: "tool_use"` | `response.output_item.added` with `type: "function_call"` | `functionCall` in `parts` |
| **Argument streaming** | Incremental string in `delta.tool_calls[].function.arguments` | `input_json_delta` partial JSON | `function_call_arguments.delta` string | **Complete args** in one chunk |
| **Argument completion** | `finish_reason: "tool_calls"` | `content_block_stop` | `function_call_arguments.done` | N/A (already complete) |
| **Parallel calls** | Different `index` in `delta.tool_calls` array | Sequential `content_block_start` blocks | Different `output_index` | Multiple `functionCall` parts in one chunk |
| **Call ID field** | `tool_calls[].id` | `content_block.id` | `item.call_id` | `functionCall.id` (Gemini 3+ only) |
| **Mixed text + tools** | `content` deltas before `tool_calls` deltas | Separate `content_block_start` events | Separate `output_item.added` events | Text parts + functionCall parts in same chunk |
| **Accumulation key** | `index` (0-based) | `index` (from `content_block_start`) | `output_index` | N/A (complete objects) |

---

## 6. Cross-Provider Accumulation Pattern

Despite the differences, all providers follow a common pattern:

1. **Declaration event**: Identifies the tool call (name, ID)
2. **Delta events**: Stream argument JSON fragments (except Gemini which sends complete args)
3. **Completion event**: Signals the tool call is fully received
4. **Assembly**: Concatenate all argument fragments, then `JSON.parse()` the result

The key differences are in naming conventions and whether arguments arrive incrementally (OpenAI/Anthropic) or as complete objects (Gemini).
