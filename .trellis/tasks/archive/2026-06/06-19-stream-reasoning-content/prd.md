# 流式响应解析模型思考内容

## Goal

在 `fetchAndStream` 中解析并展示各 LLM API 返回的 thinking/reasoning 内容，让用户能看到模型的思考过程，而不是只看到最终回答。

## What I already know

* 当前 `fetchAndStream` 只处理 `delta.content`（Chat Completions）、`delta.text`（Anthropic）、`parts[].text`（Gemini）、`output_text.delta`（Responses API），**reasoning 字段被静默丢弃**
* 用户截图证实：Kimi K2.5 的思考内容未显示，537 秒的响应只展示了最终 JSON 答案
* 各 API 的 reasoning 格式研究已完成：[reasoning-sse-formats.md](research/reasoning-sse-formats.md)

## Research References

* [`research/reasoning-sse-formats.md`](research/reasoning-sse-formats.md) — 各 API reasoning SSE 格式详细对比

## Research Notes

### 三种 reasoning 流式模式

| 模式 | 适用 API | 字段名 | 特点 |
|---|---|---|---|
| **A: `delta.reasoning_content`** | DeepSeek, Kimi, Qwen, GLM, vLLM | `reasoning_content` 或 `reasoning` | 嵌入在同一个 delta 对象中，reasoning 先于 content 流出 |
| **B: Named SSE events** | Anthropic/Claude | `thinking_delta` | 独立 content block，需跟踪 block index |
| **C: Typed events** | OpenAI Responses API | `reasoning_text.delta` / `reasoning_summary_text.delta` | 语义化事件类型 |

### 关键兼容性注意

- Ollama 用 `delta.reasoning`（不是 `reasoning_content`）
- vLLM 字段名取决于 parser 配置，可能是 `reasoning` 或 `reasoning_content`
- 同一 chunk 可能同时包含 `reasoning_content` 和 `content`（vLLM issue #43933）
- Anthropic thinking block 结束前有 `signature_delta`

## Open Questions

(已全部解决)

## Requirements

1. **Chat Completions reasoning 解析**：在 `fetchAndStream` 的 SSE 解析循环中，检测 `delta.reasoning_content` 和 `delta.reasoning` 字段，累积 reasoning 文本
2. **Anthropic thinking 解析**：检测 `content_block_start` 中 `type: "thinking"` 的 block，累积 `thinking_delta` 中的 thinking 文本
3. **Responses API reasoning 解析**：检测 `response.reasoning_text.delta` 和 `response.reasoning_summary_text.delta` 事件，累积 reasoning 文本
4. **Gemini thinking 解析**：检测 `thoughtPart` 或 Gemini 特有的 thinking 格式（如有）
5. **UI 展示**：思考内容折叠在回答消息卡片上方，默认折叠，点击可展开。与回答在同一卡片内，用不同样式（如浅色背景、斜体、thinking 图标）区分
6. **`onPhase` 回调联动**：reasoning chunk 到达时也应触发 `onPhase('receiving_data')`，使等待状态从"等待响应..."切换到"接收数据中..."
7. **非流式响应**：解析非流式 JSON 响应中的 `reasoning_content` / `thinking` 字段并展示

## Acceptance Criteria (evolving)

- [ ] DeepSeek/Kimi/Qwen/GLM 的 `delta.reasoning_content` 被正确解析并展示
- [ ] Ollama 的 `delta.reasoning` 被正确解析并展示
- [ ] Anthropic 的 `thinking_delta` 被正确解析并展示
- [ ] Responses API 的 `reasoning_text.delta` 被正确解析并展示
- [ ] 思考内容折叠在回答上方，默认折叠，点击可展开
- [ ] 思考内容与正式回答有视觉区分（不同样式/颜色）
- [ ] reasoning chunk 到达时触发 `onPhase('receiving_data')`
- [ ] 非流式响应中的 reasoning 字段被解析展示
- [ ] 无 reasoning 内容时不影响现有行为

## Definition of Done

* 手动测试：使用支持 thinking 的模型（如 Kimi K2.7、DeepSeek R1）验证思考内容正确展示
* 不引入新依赖
* 现有功能无回归

## Out of Scope

* reasoning 内容的编辑/修改
* 多轮对话中 reasoning 内容的保留策略（各 API 有不同策略，超出本工具范围）
* Anthropic `signature_delta` 的验证逻辑

## Technical Notes

* 关键文件：`assets/js/script.js`（`fetchAndStream` 函数 ~line 2896）
* `fetchAndStream` 当前返回 `{ isStreamed, json, text, contentType, toolCalls }`，需新增 `reasoningText` 字段
* Chat Completions 路径：在 `if (chunk.choices && chunk.choices[0])` 分支中，检查 `delta.reasoning_content` 和 `delta.reasoning`
* Anthropic 路径：在 `content_block_start` 中检测 `type: "thinking"`，在 `content_block_delta` 中检测 `type: "thinking_delta"`
* Responses API 路径：检测 `response.reasoning_text.delta` 和 `response.reasoning_summary_text.delta` 事件类型
* UI 展示：在 `addMessage` 中增加 reasoning 内容的折叠展示区域，位于回答文本上方，默认折叠
* CSS：新增 `.reasoning-section` 样式（浅色背景、折叠/展开动画、thinking 图标）
* 流式场景：reasoning 文本实时累积，流结束后渲染折叠区域；流式过程中可先显示"思考中..."占位
