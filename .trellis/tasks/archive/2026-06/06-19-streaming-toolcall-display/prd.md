# 流式多轮工具调用时，中间文本截断显示为独立消息

## Goal

修复流式模式下多轮工具调用场景的 UI 显示问题：当模型同时输出文本和工具调用时，流式过程中创建的"回答（流式）"卡片与流式结束后创建的"模型响应 #N"卡片重复出现，导致用户看到截断的中间文本作为独立消息。

## Requirements

* 流式多轮工具调用场景下，每轮只显示一个 assistant 消息卡片
* 流式过程中显示的临时文本卡片，在流式结束后应被更新为完整内容（而非新建卡片）
* 流式过程中文本应正常实时更新（保持现有行为）
* 非流式路径行为不变
* 无工具调用的纯文本流式响应行为不变

## Technical Approach

**方案：更新现有卡片（复用流式临时卡片）**

流式结束后，不调用 `addMessage()` 创建新卡片，而是：
1. 更新现有 `assistantCard` 的 `<pre>` 内容：从纯文本替换为完整的结构化 JSON（content + tool_calls）
2. 更新标签：从"回答（流式）"改为"模型响应 #N"
3. 复用已有的 `finalizeReasoningInCard()` 逻辑处理思考过程折叠

具体实现：
- 在 `addMessage()` 旁新增 `updateMessageCard(card, label, payload)` 辅助函数，更新已有卡片的标签和 `<pre>` 内容
- 4 个 vendor 路径中，流式+工具调用分支：将 `addMessage('assistant', ...)` 替换为 `updateMessageCard(assistantCard, ...)`
- 纯文本流式路径（无工具调用）保持现有行为不变（已有 finalize 逻辑处理标签更新）

## Acceptance Criteria

* [ ] 流式+工具调用场景：每轮只出现一个 assistant 卡片
* [ ] 流式过程中文本实时更新
* [ ] 流式结束后，assistant 卡片显示完整内容（含 tool_calls 信息）
* [ ] 非流式路径不受影响
* [ ] 纯文本流式响应不受影响
* [ ] 所有 4 个 vendor 路径（OpenAI CC、Anthropic、Gemini、Responses API）均修复

## Definition of Done

* 代码修改完成，所有 vendor 路径统一处理
* 手动测试验证流式+工具调用场景显示正确
* Lint / typecheck 通过

## Out of Scope

* 非流式路径的改动
* 纯文本流式响应的改动
* 工具调用逻辑本身的改动

## Technical Notes

* 关键文件：assets/js/script.js
* 问题代码位置（4 处，每个 vendor 一处）：
  - OpenAI CC: L1858-1882 — 流式 onChunk 创建 assistantCard，L1882 再 addMessage
  - Anthropic: L2047-2076 — 同样模式
  - Gemini: L2238-... — 同样模式
  - Responses API: L2430-... — 同样模式
* `addMessage()` (L516) 创建卡片，payload 为 string 时直接作为 pre.textContent，为 object 时 JSON.stringify
* 流式过程中 payload 是 string（纯文本），流式结束后 payload 是 object（含 tool_calls）
