# Research: GLM Thinking/Reasoning Parameter Compatibility

- **Query**: Compare Z.AI, BigModel, and Aliyun GLM thinking parameter specs; map to current repo constraints
- **Scope**: external + internal
- **Date**: 2025-06-29

## Findings

### 1. Parameter Differences Across Providers

| Provider | Endpoint | Enable Thinking | Disable Thinking | Reasoning Effort | Notes |
|---|---|---|---|---|---|
| **Z.AI** | `api.z.ai/api/paas/v4/chat/completions` | `thinking.type: "enabled"` (default) | `thinking.type: "disabled"` | `reasoning_effort` (GLM-5.2+ only) | Top-level param |
| **BigModel** | `open.bigmodel.cn/api/paas/v4/chat/completions` | `thinking.type: "enabled"` (default) | `thinking.type: "disabled"` | `reasoning_effort` (GLM-5.2+ only) | Identical to Z.AI |
| **Aliyun OpenAI-compat** | `dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `enable_thinking: true` (default) | `enable_thinking: false` | `reasoning_effort` (GLM-5.2+ only) | **Different param name!** |
| **Aliyun DashScope** | `dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation` | `enable_thinking: true` (in `parameters`) | `enable_thinking: false` (in `parameters`) | `reasoning_effort` (in `parameters`) | N/A for this frontend |

### 2. Key Incompatibility: Aliyun Uses `enable_thinking` Instead of `thinking.type`

This is the **critical finding**. The current repo code at `assets/js/script.js:1104-1105` sends:
```js
case 'glm_thinking':
    return { thinking: { type: level === 'disabled' ? 'disabled' : 'enabled' } };
```

This works for **Z.AI and BigModel** endpoints but **does NOT work for Aliyun**. Aliyun expects:
```json
{ "enable_thinking": true }
// or
{ "enable_thinking": false }
```

Aliyun ignores `thinking.type` entirely — the request would silently default to thinking enabled.

### 3. Model Version Differences for `reasoning_effort`

| Model | Supported Values | Max Level |
|---|---|---|
| GLM-5.2 | `low`, `medium`, `high`, `xhigh`, `max` | `max` |
| GLM-5.1 | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | `xhigh` (no `max`) |
| GLM-5 | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | `xhigh` (no `max`) |
| GLM-4.7 | N/A (forced thinking, no effort control) | — |
| GLM-4.6 | Auto-judges, no reasoning_effort | — |
| GLM-4.5 | Auto-judges, no reasoning_effort | — |

- `low`/`medium` map to `high` on Z.AI/BigModel
- `xhigh` maps to `max` on Z.AI/BigModel
- Aliyun: passing unsupported values returns `invalid_parameter_error`
- Aliyun: `enable_thinking: false` takes priority over `reasoning_effort`

### 4. Response Format (Same Across All Providers)

All providers return `reasoning_content` in the `message` object:
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "final answer",
      "reasoning_content": "thinking process"
    }
  }]
}
```

Streaming: `reasoning_content` appears in `delta` objects.

### 5. Current Repo Implementation Analysis

**File**: `assets/js/script.js`

- **MODEL_CATALOG entry** (line 1035-1036): GLM uses `param: 'glm_thinking'` with levels `['disabled', 'enabled']`
- **buildThinkingParams** (line 1104-1105): Sends `{ thinking: { type: 'enabled' | 'disabled' } }`
- **Streaming parsing** (line 3728-3737): Already handles `delta.reasoning_content` correctly
- **Non-streaming parsing** (line 4146-4149): Already handles `message.reasoning_content` correctly
- **Endpoint** (line 139): Built from user's API URL via `buildEndpoint(base)` → appends `/v1/chat/completions`

### 6. Recommended Implementation Approach

**Option A (Recommended): Detect provider by API URL**

When building GLM thinking params, check if the API URL contains `dashscope.aliyuncs.com` or `maas.aliyuncs.com`:
- If Aliyun: use `enable_thinking: true/false` + `reasoning_effort` for GLM-5.2
- If Z.AI/BigModel: use `thinking.type: "enabled"/"disabled"` + `reasoning_effort` for GLM-5.2

**Changes needed in `script.js`:**

1. **MODEL_CATALOG** (line 1035-1036): Expand GLM entry to support `reasoning_effort` levels for GLM-5.2+:
   ```js
   // GLM-5.2 on Aliyun: enable_thinking + reasoning_effort
   { pattern: /glm-5\.2/i, levels: ['disabled','low','medium','high','xhigh','max'], def: 'high', param: 'glm52_thinking' },
   // GLM older on Aliyun: enable_thinking only
   { pattern: /glm-/i, levels: ['disabled','enabled'], def: 'enabled', param: 'glm_thinking' },
   ```
   Note: Order matters — GLM-5.2 pattern must come before the generic `glm-` pattern.

2. **buildThinkingParams** (line 1104-1105): Add URL-aware branching:
   ```js
   case 'glm52_thinking':
     // Detect Aliyun vs Z.AI/BigModel by current API URL
     if (isAliyunEndpoint()) {
       if (level === 'disabled') return { enable_thinking: false };
       return { enable_thinking: true, reasoning_effort: level };
     }
     // Z.AI / BigModel
     if (level === 'disabled') return { thinking: { type: 'disabled' } };
     return { thinking: { type: 'enabled' }, reasoning_effort: level };
   case 'glm_thinking':
     if (isAliyunEndpoint()) {
       return { enable_thinking: level !== 'disabled' };
     }
     return { thinking: { type: level === 'disabled' ? 'disabled' : 'enabled' } };
   ```

3. **Helper function** `isAliyunEndpoint()`: Read the current API URL input and check for Aliyun domains.

### 7. Edge Cases

1. **Aliyun `reasoning_effort` validation**: GLM-5.1/5 do NOT support `max`; passing it returns `invalid_parameter_error`. Must clamp to `xhigh` for those models.
2. **GLM-4.7 forced thinking**: Cannot be disabled. UI should either hide the toggle or show only effort levels.
3. **GLM-4.5/4.6 no effort control**: Only enabled/disabled. No `reasoning_effort` param.
4. **User custom endpoint**: A user could point at any URL. The `isAliyunEndpoint()` check must be permissive (check for known Aliyun patterns) but not overly strict.
5. **Aliyun `enable_thinking: false` priority**: When `enable_thinking: false` is set, `reasoning_effort` is ignored — so don't send `reasoning_effort` when disabled.
6. **Token budget**: Thinking tokens are billed as output tokens. `max_tokens` must accommodate both thinking and final answer.
7. **glm-4.6/glm-4.7 deprecation on Aliyun**: Aliyun docs note these will be removed on 2026-07-09. Users may migrate to Qwen models.

### 8. Acceptance Notes

- Streaming `reasoning_content` parsing already works (line 3728-3737)
- Non-streaming `reasoning_content` parsing already works (line 4146-4149)
- CDATA-wrapped thinking fallback already exists (line 3878)
- The main gap is **request parameter construction** — no Aliyun-specific `enable_thinking` param is sent today
- No backend changes needed — this is purely frontend (`script.js`)

### Related Specs

- Current GLM catalog entry: `assets/js/script.js:1035-1036`
- Current buildThinkingParams: `assets/js/script.js:1104-1105`
- Streaming parser: `assets/js/script.js:3728-3737`
- Non-streaming parser: `assets/js/script.js:4146-4149`

## Caveats / Not Found

- Could not confirm if Aliyun's `enable_thinking` is truly ignored (vs. causing error) when `thinking.type` is sent. The docs only say it's the supported param — no mention of accepting the Z.AI format. Safest assumption: it's ignored silently.
- No DashScope-native endpoint analysis included (out of scope for frontend which uses OpenAI-compat endpoint only).
