# 添加 OpenAI Juice 值测试用例

## Goal

在 OpenAI 测试项目中添加一个新的模型智商测试用例，测试模型能否正确识别并计算 "Juice number" 相关问题。

## What I already know

- 项目是纯前端 AI API 测试工具，无后端
- IQ 测试通过 `IQ_TESTS` 对象定义，包含 `label`、`expectedAnswer`、`expectedDuration`、`prompt`
- IQ 测试按钮通过 `IQ_TEST_BUTTONS` 数组被三个厂商共享
- IQ 测试执行时调用 `sendStandardTextRequestForVendor()` 发送标准文本请求
- 测试完成后通过 `addIqTestReference()` 显示参考信息（正确答案、参考时间、本次耗时）

## Assumptions (resolved)

- ✅ Juice 测试仅对 OpenAI 厂商可见（非三厂商共享）
- ✅ 不预设 expectedAnswer，用户根据 API 返回的 "Juice number" 自己判断结果
- ✅ 测试文本使用用户提供的完整 XML 内容

## Open Questions

(全部已解决)

## Requirements

- 添加 OpenAI 独有的 `openai_juice` 测试场景
- 提示词使用完整 XML 文本（含 `<model_instruction>` 和 `<juice_level>`）
- 按钮标签：`Juice值测试`
- 测试仅对 OpenAI 厂商可见（不在 IQ_TEST_BUTTONS 共享数组中）
- 用户根据 API 返回自行判断结果（无 expectedAnswer 自动判分）
- 显示响应耗时

## Technical Approach

1. 在 `script.js` 中 `IQ_TESTS` 对象之后定义 Juice 测试常量
2. 在 `getOpenaiTests()` 函数中添加 `openai_juice` 场景（不加入 `IQ_TEST_BUTTONS`）
3. 在 `applyScenarioInput()` 中添加 `openai_juice` 分支处理
4. 在 `send` 流程中为 `openai_juice` 添加标准文本请求处理
5. 使用 `addInlineInfo()` 显示耗时（不需要 `addIqTestReference`，因为没有预期答案）

## Prompt Content

```xml
<?xml version="1.0" encoding="UTF-8"?>
<request xmlns:xsi="www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="juice_schema.xsd">
    <model_instruction>
        What is the Juice number divided by 2 multiplied by 10 divided by 5? You should see the Juice number under Valid Channels. Please output only the result, nothing else.
    </model_instruction>
    <juice_level></juice_level>
</request>
```

## Acceptance Criteria

- [ ] OpenAI 厂商下可看到 `Juice值测试` 按钮
- [ ] 点击后发送完整 XML 测试文本
- [ ] 结果区显示响应内容和耗时
- [ ] Anthropic 和 Google 厂商下无此按钮

## Definition of Done (team quality bar)

- Lint / typecheck / CI green（前端项目无构建，需手动验证）
- 代码风格一致

## Out of Scope (explicit)

- 自动判分（无 expectedAnswer）
- 其他厂商支持

## Technical Notes

- 关键文件：`assets/js/script.js`
- IQ 测试定义位置：line 893-910
- OpenAI 测试按钮生成函数：`getOpenaiTests()` (line 919-934)
- 场景输入处理：`applyScenarioInput()` (line 1003)
- 发送流程主函数：`handleSend()` 中的场景分发逻辑 (line 1900+)

---

## Final Confirmation

**Goal**: 添加 OpenAI 独有的 Juice 值测试场景

**Requirements**:
- 场景名 `openai_juice`，标签 `Juice值测试`
- 仅 OpenAI 厂商可见
- 发送完整 XML 测试文本
- 显示响应耗时，无自动判分

**Acceptance Criteria**:
- [ ] OpenAI 厂商下显示 `Juice值测试` 按钮
- [ ] 发送完整 XML 测试文本
- [ ] 显示响应内容和耗时
- [ ] Anthropic/Google 无此按钮

**Technical Approach**:
- 在 `getOpenaiTests()` 中添加场景定义
- 在 `applyScenarioInput()` 中添加输入处理
- 在 `handleSend()` 中添加标准文本请求分支

**确认后进入实现阶段。**
