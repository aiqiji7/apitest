# Thinking/Reasoning Models Catalog Research

## Objective
Identify AI models that support thinking/reasoning effort but are NOT covered by the current MODEL_CATALOG. Current coverage includes OpenAI, Anthropic, DeepSeek, Google, xAI.

## Findings

### 1. Qwen (通义千问)
- **Supports thinking**: Yes (hybrid mode)
- **Parameter format**: `enable_thinking` (boolean), `thinking_budget` (integer)
- **Does NOT support** `reasoning_effort` parameter
- **Models**: Qwen3.7, Qwen3.6, Qwen3.5, Qwen3, QwQ, DeepSeek-V3/V4 (when using Qwen endpoints)
- **Notes**: Thinking can be toggled per request with `enable_thinking`. `thinking_budget` caps thinking tokens. Some models have thinking enabled by default (Qwen3.7, Qwen3.6, Qwen3.5), others disabled by default (Qwen3, Qwen3-VL, Qwen3-Omni).

### 2. GLM (智谱)
- **Supports thinking**: Yes
- **Parameter format**: `thinking.type` ("enabled"/"disabled"), `clear_thinking` (boolean)
- **Thinking-effort levels**: GLM-5.2 supports "high" and "max" levels via Anthropic-compatible endpoint
- **Models**: GLM-5.2, GLM-5.1, GLM-5, GLM-4.7, GLM-4.6, GLM-4.5
- **Notes**: Thinking is activated by default in GLM-5.2, GLM-5.1, GLM-5, GLM-4.7 series. Turn-level thinking control available. The `reasoning_effort` parameter may not work on OpenAI-compatible endpoint; effort levels only available via Anthropic endpoint.

### 3. Kimi (月之暗面)
- **Supports thinking**: Yes
- **Parameter format**: `thinking.type` ("enabled"/"disabled"), `thinking.keep` (null/"all")
- **Models**: kimi-k2.7-code (always thinking), kimi-k2.6 (thinking on by default), kimi-k2.5 (thinking on by default)
- **Notes**: kimi-k2.7-code is code-focused with thinking always on and Preserved Thinking always on. kimi-k2.6 supports Preserved Thinking via `thinking.keep: "all"`.

### 4. Mistral
- **Supports reasoning**: Yes (adjustable reasoning)
- **Parameter format**: `reasoning_effort` ("high"/"none")
- **Models**: mistral-small-latest, mistral-medium-3-5
- **Notes**: When `reasoning_effort="high"`, response includes thinking chunks. Native reasoning models (magistral-small-latest, magistral-medium-latest) are deprecated in favor of adjustable reasoning.

### 5. Cohere
- **Supports reasoning**: Yes (hybrid reasoning)
- **Parameter format**: `thinking` (enabled/disabled), thinking token budget
- **Models**: command-a-reasoning-08-2025
- **Notes**: Thinking enabled by default. Can set token budget to limit thinking tokens.

### 6. Amazon Nova
- **Supports reasoning**: Yes (extended thinking)
- **Parameter format**: `reasoningConfig.type` ("enabled"/"disabled"), `reasoningConfig.maxReasoningEffort` ("low"/"medium"/"high")
- **Models**: amazon.nova-2-lite-v1:0 (256k context)
- **Notes**: Extended thinking disabled by default. Three effort levels: low (4,000 token limit), medium, high (up to 32,000 reasoning tokens). Reasoning content redacted in output as `[REDACTED]`.

## Summary Table

| Provider | Model Pattern | Parameter Format | Supported Levels |
|----------|---------------|------------------|------------------|
| Qwen | qwen-*, qwq-* | `enable_thinking` (bool), `thinking_budget` (int) | Toggle on/off + budget |
| GLM | glm-* | `thinking.type` ("enabled"/"disabled") | Toggle + high/max via Anthropic endpoint |
| Kimi | kimi-k2* | `thinking.type` ("enabled"/"disabled") | Toggle + preserved thinking |
| Mistral | mistral-small-latest, mistral-medium-3-5 | `reasoning_effort` ("high"/"none") | high, none |
| Cohere | command-a-reasoning-* | `thinking` (enabled/disabled) | Toggle + token budget |
| Amazon Nova | amazon.nova-2-lite-* | `reasoningConfig.type` + `maxReasoningEffort` | low, medium, high |

## Recommendations for MODEL_CATALOG Addition

1. **Mistral** - Direct `reasoning_effort` parameter, similar to OpenAI format.
2. **Amazon Nova** - `reasoningConfig.maxReasoningEffort` parameter with three levels.
3. **Qwen** - Could be added with custom parameter mapping (`enable_thinking` + `thinking_budget`).
4. **GLM** - Could be added with custom parameter mapping (`thinking.type`).
5. **Kimi** - Could be added with custom parameter mapping (`thinking.type`).
6. **Cohere** - Could be added with custom parameter mapping (`thinking`).

## Sources
- Qwen Cloud documentation: https://docs.qwencloud.com/developer-guides/text-generation/thinking
- Z.AI developer documentation: https://docs.z.ai/guides/capabilities/thinking-mode
- Kimi API platform: https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model
- Mistral documentation: https://docs.mistral.ai/capabilities/reasoning
- Cohere documentation: https://docs.cohere.ai/docs/reasoning
- Amazon Nova documentation: https://docs.aws.amazon.com/nova/latest/userguide/extended-thinking.html