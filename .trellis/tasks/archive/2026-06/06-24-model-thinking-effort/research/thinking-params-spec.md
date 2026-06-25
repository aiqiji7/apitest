# Research: 模型思考等级/推理强度 API 参数规格

- **Query**: 各主流模型提供商的 thinking/reasoning effort API 参数详细规格
- **Scope**: external (API 文档调研)
- **Date**: 2026-06-24

## 1. OpenAI reasoning_effort

### 参数格式

**Chat Completions API** — 顶层参数：
```json
{
  "model": "o3-2025-04-16",
  "messages": [...],
  "reasoning_effort": "medium"
}
```

**Responses API** — 嵌套字典：
```json
{
  "model": "gpt-5.5",
  "input": [...],
  "reasoning": {
    "effort": "high"
  }
}
```

### 支持的值

| 值 | 说明 |
|---|---|
| `"none"` | 不做推理，最快（仅 gpt-5.1+ 支持） |
| `"minimal"` | 最小推理（部分 GPT-5 变体支持） |
| `"low"` | 低推理 |
| `"medium"` | 中等推理（大多数模型默认值） |
| `"high"` | 高推理 |
| `"xhigh"` | 最高推理（gpt-5.1-codex-max 之后的模型） |

### 模型兼容性矩阵

| 模型 | none | minimal | low | medium | high | xhigh |
|---|---|---|---|---|---|---|
| o1-2024-12-17 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| o1-pro-2025-03-19 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| o3-2025-04-16 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| o3-mini-2025-01-31 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| o4-mini | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| gpt-5-2025-08-07 | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ |
| gpt-5-pro-2025-10-06 | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| gpt-5.1-2025-11-13 | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ |
| gpt-5.1-codex-max | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ |
| gpt-5.2-2025-12-11 | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| gpt-5.2-pro-2025-12-11 | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| gpt-5.5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### 默认值

- **o1 / o3 / o4 系列**: 默认 `"medium"`
- **gpt-5**: 默认 `"medium"`
- **gpt-5.1**: 默认 `"none"`（不执行推理）
- **gpt-5-pro**: 默认且仅支持 `"high"`
- **gpt-5.5**: 默认 `"medium"`

### 注意事项

- 推理 token 在 `usage.completion_tokens_details.reasoning_tokens` 中统计
- 推理 token 不会出现在可见输出中
- `reasoning_effort` 仅对推理模型有效，非推理模型传入会报错

---

## 2. Anthropic extended thinking

### 2.1 Claude 3.7 Sonnet — 手动 extended thinking

**参数格式：**
```json
{
  "model": "claude-3-7-sonnet-20250219",
  "max_tokens": 16000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "messages": [...]
}
```

**参数说明：**

| 参数 | 值 | 说明 |
|---|---|---|
| `thinking.type` | `"enabled"` | 启用手动 extended thinking |
| `thinking.type` | `"disabled"` | 禁用（默认） |
| `thinking.budget_tokens` | 整数 (min 1024) | 最大推理 token 数，**必须小于 `max_tokens`** |

### 2.2 Claude 4 / 4.5 — 手动 extended thinking

格式与 3.7 相同，但 Claude 4 模型默认返回 **summarized thinking**（摘要形式）。

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 16000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000,
    "display": "summarized"
  },
  "messages": [...]
}
```

**display 选项：**
- `"summarized"` — 返回思考摘要（Claude 4 默认）
- `"omitted"` — 省略思考过程，降低延迟

### 2.3 Claude 4.6+ / Opus 4.7+ — adaptive thinking

**新范式：`thinking.type: "adaptive"` + `output_config.effort`**

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 16000,
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "high"
  },
  "messages": [...]
}
```

**effort 参数值：**

| 值 | 说明 |
|---|---|
| `"low"` | 低推理强度 |
| `"medium"` | 中等推理强度 |
| `"high"` | 高推理强度 |
| `"xhigh"` | 极高推理强度（Opus 4.7+ 引入） |
| `"max"` | 最大推理强度 |

### 2.4 Claude Fable 5 / Mythos 5 — 自动 adaptive

最新模型（Fable 5, Mythos 5）thinking 默认 always-on，不再支持 `budget_tokens`：

```json
{
  "model": "claude-fable-5",
  "max_tokens": 16000,
  "output_config": {
    "effort": "high"
  },
  "messages": [...]
}
```

### 关键约束

- `budget_tokens` **必须小于** `max_tokens`
- `budget_tokens` 最小值 1024
- `max_tokens: 0`（cache pre-warming）不能与 extended thinking 组合
- Opus 4.7+ 传入 `budget_tokens` 会返回 400 错误
- `budget_tokens` 是推理 token 上限，模型不一定用满

### 禁用 thinking

```json
{
  "thinking": {
    "type": "disabled"
  }
}
```

---

## 3. DeepSeek reasoning_effort

### 参数格式

DeepSeek 使用 **OpenAI 兼容格式**，支持两个相关参数：

```json
{
  "model": "deepseek-v4-pro",
  "messages": [...],
  "thinking": {
    "type": "enabled"
  },
  "reasoning_effort": "high"
}
```

**Python (openai SDK) 示例：**
```python
from openai import OpenAI

client = OpenAI(
    api_key="...",
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello"}],
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}}
)
```

**JavaScript (openai SDK) 示例：**
```javascript
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
});

const completion = await openai.chat.completions.create({
    messages: [{ role: "user", content: "Hello" }],
    model: "deepseek-v4-pro",
    thinking: {"type": "enabled"},
    reasoning_effort: "high",
});
```

### 支持的值

| 值 | 说明 |
|---|---|
| `"none"` | 不做推理 |
| `"high"` | 高推理 |
| `"max"` | 最大推理 |

### 模型支持

| 模型 | 支持 |
|---|---|
| deepseek-r1 | ✓ |
| deepseek-v3.1 | ✓（hybrid thinking mode） |
| deepseek-v4-pro | ✓ |
| deepseek-v4-flash | ✓ |

### 响应格式

DeepSeek 返回两个内容字段：
- `reasoning_content` — 推理链（chain-of-thought）
- `content` — 最终答案

### 注意事项

- DeepSeek 使用 OpenAI 兼容的 Chat Completions API
- `thinking.type: "enabled"` 是 DeepSeek 特有的扩展参数
- `reasoning_effort` 控制推理强度
- V3.1 支持 hybrid thinking（同一模型可在 thinking/non-thinking 模式间切换）

---

## 4. Google Gemini thinking

### 4.1 Gemini 2.5 系列 — thinkingConfig.thinkingBudget

**参数格式（native API）：**
```json
{
  "contents": [{"role": "user", "parts": [{"text": "..."}]}],
  "generationConfig": {
    "thinkingConfig": {
      "thinkingBudget": 8000
    }
  }
}
```

**Python (genai SDK) 示例：**
```python
from google import genai

client = genai.Client()
response = client.models.generate_content(
    model="gemini-2.5-pro",
    contents="...",
    config=genai.types.GenerateContentConfig(
        thinking_config=genai.types.ThinkingConfig(
            thinking_budget=8000
        )
    )
)
```

**thinkingBudget 值：**

| 值 | 说明 |
|---|---|
| `-1` | 动态预算（自动控制） |
| `0` | 禁用思考（仅 Flash/Flash-Lite 支持） |
| `1` ~ `24576` | 固定 token 预算（Flash） |
| `128` ~ `32768` | 固定 token 预算（Pro） |

**模型限制：**

| 模型 | 最小值 | 最大值 | 默认 |
|---|---|---|---|
| Gemini 2.5 Flash | 1 | 24,576 | Auto (≤8192) |
| Gemini 2.5 Pro | 128 | 32,768 | Auto (≤8192) |
| Gemini 2.5 Flash-Lite | 512 | 24,576 | Auto (≤8192) |

### 4.2 Gemini 3 系列 — thinking_level

**参数格式：**
```json
{
  "contents": [{"role": "user", "parts": [{"text": "..."}]}],
  "generationConfig": {
    "thinkingConfig": {
      "thinkingLevel": "high"
    }
  }
}
```

**Python 示例：**
```python
response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents="...",
    config=genai.types.GenerateContentConfig(
        thinking_config=genai.types.ThinkingConfig(
            thinking_level="high"
        )
    )
)
```

**thinking_level 值：**

| 值 | 说明 |
|---|---|
| `"minimal"` | 最小推理（Flash only） |
| `"low"` | 低推理 |
| `"medium"` | 中等推理 |
| `"high"` | 高推理（默认） |

**模型支持：**

| 模型 | 支持的 levels | 默认 |
|---|---|---|
| gemini-3.1-pro-preview | low, medium, high | high |
| gemini-3-flash-preview | minimal, low, medium, high | high |
| gemini-3-pro-preview | low, high | high |

### 4.3 OpenAI 兼容格式

如果通过 OpenAI 兼容端点访问 Gemini，可能需要使用不同的参数名。具体取决于代理/网关实现。

### 注意事项

- Gemini 3 **不能完全禁用** thinking（与 2.5 不同）
- `thinking_level` 不能用于 2.5 系列（会报错）
- `thinkingBudget` 可以用于 3 系列的新版 API，但推荐用 `thinkingLevel`
- 响应中包含 `thoughts_token_count` 统计

---

## 5. Grok (xAI) reasoning_effort

### 参数格式

Grok 使用 OpenAI 兼容格式：

```json
{
  "model": "grok-4.3",
  "messages": [...],
  "reasoning_effort": "high"
}
```

### 支持的值

| 值 | 说明 |
|---|---|
| `"none"` | 不做推理（最快） |
| `"low"` | 低推理 |
| `"medium"` | 中等推理 |
| `"high"` | 高推理 |

### 模型支持

| 模型 | reasoning_effort 支持 |
|---|---|
| grok-4.3 | ✓ (none, low, medium, high) |
| grok-4.20 | ✓ |
| grok-4.20-non-reasoning | 仅 none |
| grok-3 | 已退役，重定向到 grok-4.3 |

### 默认行为

- 从旧模型（grok-3, grok-4-0709 等）迁移后，默认使用 `low` reasoning effort
- 非推理模型重定向后使用 `none`

### 注意事项

- Grok 4.3 是当前推荐模型，1M token 上下文窗口
- 原生支持 X (Twitter) 搜索集成
- 定价：$1.25/1M 输入，$2.50/1M 输出

---

## 6. 模型名称匹配规则

### 从模型名推断提供商

| 前缀/模式 | 提供商 | 示例 |
|---|---|---|
| `gpt-` | OpenAI | gpt-4o, gpt-5, gpt-5.1 |
| `o1`, `o3`, `o4` | OpenAI | o1-2024-12-17, o3-mini, o4-mini |
| `claude-` | Anthropic | claude-3-7-sonnet, claude-opus-4-7 |
| `deepseek-` | DeepSeek | deepseek-r1, deepseek-v4-pro |
| `gemini-` | Google | gemini-2.5-pro, gemini-3-flash |
| `grok-` | xAI | grok-4.3, grok-4.20 |

### 推荐匹配逻辑（伪代码）

```javascript
function detectProvider(modelName) {
  const name = modelName.toLowerCase();
  if (/^(gpt-|o1|o3|o4)/.test(name)) return 'openai';
  if (/^claude-/.test(name)) return 'anthropic';
  if (/^deepseek-/.test(name)) return 'deepseek';
  if (/^gemini-/.test(name)) return 'google';
  if (/^grok-/.test(name)) return 'grok';
  return 'unknown';
}
```

### 注意事项

- OpenAI 的 o 系列（o1, o3, o4）不含 `gpt-` 前缀
- DeepSeek 通过 OpenAI 兼容 API 访问，但需要额外的 `thinking` 参数
- Gemini 通过 native API（`generateContent`）访问，不是 Chat Completions 格式
- 部分提供商通过 OpenAI 兼容网关访问（如 OpenRouter），参数格式可能不同

---

## 7. 各提供商参数对照表

| 提供商 | 参数位置 | 参数名 | 值类型 | 禁用方式 |
|---|---|---|---|---|
| OpenAI Chat | 顶层 | `reasoning_effort` | string | `"none"` |
| OpenAI Responses | 嵌套 | `reasoning.effort` | string | `"none"` |
| Anthropic 3.7 | `thinking` 对象 | `thinking.type` + `budget_tokens` | string + int | `type: "disabled"` |
| Anthropic 4.6+ | `thinking` + `output_config` | `thinking.type: "adaptive"` + `effort` | string + string | 不设置 thinking |
| DeepSeek | 顶层 + `thinking` | `reasoning_effort` + `thinking.type` | string + object | `"none"` |
| Gemini 2.5 | `generationConfig` | `thinkingConfig.thinkingBudget` | int | `0` (仅 Flash) |
| Gemini 3 | `generationConfig` | `thinkingConfig.thinkingLevel` | string | 不支持完全禁用 |
| Grok | 顶层 | `reasoning_effort` | string | `"none"` |

---

## 8. 项目代码中的请求构造位置

基于对 `assets/js/script.js` 的检查：

| 场景 | 行号 | 当前格式 |
|---|---|---|
| OpenAI Chat Completions | ~1106 | `{ model, messages, stream }` |
| OpenAI Responses API | ~1097 | `{ model, input, stream }` |
| Anthropic | ~1078 | `{ model, max_tokens, messages, stream }` |
| Google Gemini | ~134 | `{ contents, stream }` |
| Tool calling (multi-turn) | ~1999 | `{ model, messages, tools, tool_choice, stream }` |

**需要插入 thinking 参数的位置：**
- OpenAI Chat: 在 `requestBody` 构造处添加 `reasoning_effort`
- OpenAI Responses: 在 `requestBody` 构造处添加 `reasoning: { effort }`
- Anthropic: 在 `requestBody` 构造处添加 `thinking` 和/或 `output_config`
- Gemini: 在 `requestBody` 构造处添加 `generationConfig.thinkingConfig`
- Grok: 同 OpenAI 格式（顶层 `reasoning_effort`）

---

## Caveats / Not Found

1. **OpenAI xhigh 的精确支持范围**: xhigh 仅在 gpt-5.1-codex-max 之后的模型上支持，具体边界需查阅各模型发布说明
2. **DeepSeek budget_tokens**: DeepSeek API 文档提到可能存在 `budget_tokens` 参数，但在写本文档时未确认其在所有 API 版本中的可用性
3. **Gemini OpenAI 兼容端点**: 如果通过 OpenRouter 等网关访问 Gemini，参数格式可能需要适配
4. **Anthropic output_config 的确切位置**: `output_config.effort` 的确切 JSON 路径在不同 SDK 版本中可能不同
5. **Grok 4.20 的具体 effort 值**: Grok 4.20 的完整 effort 值列表未在官方文档中明确列出
