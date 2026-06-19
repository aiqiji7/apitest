# 简化工具调用测试题为单步转换以限制3轮以内

## Goal

将工具调用测试的随机题目从"两步链式进制转换"简化为"单步进制转换"，使正常流程在 2-3 轮对话内即可完成，同时将 MAX_TURNS 从 8 降为 3。

## What I already know

- 当前 `generateRandomTask()` 生成两步链式转换题（b1→b2→b3），至少需要 3 轮（2 次 convert_base + 1 次 submit_answer）
- MAX_TURNS = 8，4 个场景各写了一份（openai_tools / anthropic_tools / gemini_tools / responses_tools）
- 简化为单步转换后，最少 2 轮即可完成（1 次 convert_base + 1 次 submit_answer）
- 4 个场景的 system prompt 中提到"多轮工具调用"，简化后措辞也应调整

## Requirements

1. 修改 `generateRandomTask()`：从 4 种进制中随机选 2 个不同的进制（from → to），生成单步转换题，格式为"请将{进制名}数 {数值} 转换为{进制名}。你可以使用 convert_base 工具完成转换，完成后调用 submit_answer 提交结果。"
2. 修改 4 个场景中的 `MAX_TURNS`：从 8 改为 3
3. 调整 4 个场景的 system prompt：去掉"多轮"措辞，改为通用描述
4. 调整验证成功/失败时的提示文案：去掉"经过多轮工具调用"的措辞

## Acceptance Criteria

- [ ] `generateRandomTask()` 生成单步进制转换题（如"请将十六进制数 FF 转换为十进制"）
- [ ] 4 个场景的 MAX_TURNS 均为 3
- [ ] system prompt 不再包含"多轮"措辞
- [ ] 验证提示文案适配单步场景
- [ ] 页面功能正常运行，工具调用测试可完成

## Definition of Done

- 代码修改完成
- 浏览器中可正常运行工具调用测试

## Out of Scope

- 不改变工具定义（convert_base / submit_answer 保持不变）
- 不改变流式/非流式处理逻辑
- 不改变 UI 布局

## Technical Notes

- 关键文件：`assets/js/script.js`
- `generateRandomTask()` 在 line 844-857
- MAX_TURNS 在 line 1848, 2032, 2228, 2424
- system prompt 在 line 1838（openai），其余 3 个场景需对应查找
- 验证提示文案在 line 1910-1912（openai），其余场景需对应查找
