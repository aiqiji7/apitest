# 支持 content 中嵌入 thinking XML 标签的思考过程解析

## Goal

当 API 返回的 assistant message 的 `content` 字段中直接嵌入 ` thinking\n...` 格式的思考文本时（非 CDATA 包裹、非原生 reasoning 字段），正确提取为思考过程并展示，同时从回答内容中剥离。

## What I already know

* **格式规则（从用户提供的完整对话分析得出）**：
  * ` thinking\n` — 思考块开始标记
  * ` response\n` — 思考块结束 + 实际回答开始的分隔标记（**可选**）
  * 无 ` response\n` 时：` thinking\n` 之后到 content 末尾全部是思考内容
  * 有 ` response\n` 时：` thinking\n...思考...\n response\n实际回答...`
* 当前代码已支持：OpenAI `reasoning_content`、Anthropic `thinking_delta`、Gemini `thoughtPart`、Responses API `reasoning_text`、CDATA 包裹的思考内容
* 当前代码**不支持**：content 中直接嵌入 ` thinking\n...` 这种 XML 标签式思考块
* 涉及文件：`assets/js/script.js`
  * 流式处理：`fetchAndStream()` (lines 3150-3623)
  * 非流式处理：`extractReasoningFromJson()` (lines 3626-3706)
* 现有 CDATA 处理逻辑可作为参考模板

## Requirements

* 在流式响应（`fetchAndStream`）中，识别 content delta 中的 ` thinking\n...` 块：
  * 以 ` thinking\n` 为开始标记
  * 以 ` response\n` 为结束标记（可选，不存在则到 content 末尾）
  * 提取思考内容到 reasoning，从 content 中剥离
* 在非流式响应（`extractReasoningFromJson`）中，识别完整 content 中的 ` thinking\n...` 块，同上规则提取
* 提取的思考内容通过现有的 `updateReasoningInCard` / `addReasoningToCard` 等 UI 函数展示
* 不影响现有的 CDATA、原生 reasoning 字段等处理逻辑

## Acceptance Criteria

* [ ] 流式响应中，` thinking\n...` 块被正确提取到思考区域，不出现在回答文本中
* [ ] 非流式响应中，` thinking\n...` 块被正确提取到思考区域，不出现在回答文本中
* [ ] 现有的 CDATA、原生 reasoning 字段处理不受影响
* [ ] 思考区域 UI 正常展示（可折叠、标签正确）

## Definition of Done

* 代码修改完成
* 手动测试通过（用示例格式的响应验证）

## Out of Scope

* 其他 XML 标签格式的思考块（如 `<reasoning>`、`<think>` 等）
* 跨 chunk 的 ` thinking` 标签拆分处理（先按简单场景实现）

## Technical Notes

* 文件：`assets/js/script.js`
* 参考：现有 CDATA 处理逻辑（`fetchAndStream` 中 lines 3458-3566，`extractReasoningFromJson` 中 lines 3672-3703）
* 正则匹配模式：`/ thinking\n([\s\S]*?)(?:\n response\n|$)/` — 匹配 ` thinking\n` 到 ` response\n` 或字符串末尾
* 流式场景需处理跨 chunk 的标签拆分（` think` 在一个 chunk，`ing\n` 在下一个 chunk）