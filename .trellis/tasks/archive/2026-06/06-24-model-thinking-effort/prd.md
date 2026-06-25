# 模型思考等级/推理强度设置

## Goal

在用户选择模型后，提供思考等级/推理强度（reasoning effort / thinking budget）的设置能力。采用 **per-model 模式**（参考 ai-toolbox）：通过模型目录（model catalog）定义每个模型的推理能力，用户只需 Toggle + 选等级，系统自动匹配对应 API 参数。

## Requirements

### UI 层
- 在模型输入区域增加 **Toggle 开关** + **等级下拉框**（无厂商下拉，等级由模型名自动匹配）
- Toggle 默认关闭（关闭 = 不发送 thinking 参数）
- 用户开启 Toggle 后显示等级下拉框，选项根据模型名匹配 catalog 决定
- Gemini 3 模型特殊处理：无 Toggle，始终显示等级下拉

### 模型能力目录（Model Catalog）
- 一个内置的模型名→能力映射表，每条记录定义：
  - `pattern`: 正则，匹配模型名
  - `levels`: 支持的思考等级列表
  - `default`: 默认等级
  - `param`: API 参数格式类型
  - `noToggle`: 是否隐藏 Toggle（Gemini 3）
- 子串匹配，支持第三方前缀/后缀
- 未匹配到的模型不显示任何等级选项

### 各模型等级选项与参数格式

| 模型匹配 | 等级选项 | Toggle | API 格式 |
|---------|---------|--------|---------|
| gpt-5-pro | high | 正常 | reasoning_effort |
| gpt-5.1-codex-max | low,medium,high,xhigh | 正常 | reasoning_effort |
| gpt-5.2 | none,low,medium,high,xhigh | 正常 | reasoning_effort |
| gpt-5.5 | none,minimal,low,medium,high,xhigh | 正常 | reasoning_effort |
| gpt-5 | minimal,low,medium,high | 正常 | reasoning_effort |
| o1/o3/o4 | low,medium,high | 正常 | reasoning_effort |
| gpt- (generic) | minimal,low,medium,high | 正常 | reasoning_effort |
| claude-3 | low,medium,high,xhigh,max | 正常 | budget_tokens (映射) |
| claude- (4+) | low,medium,high,xhigh,max | 正常 | adaptive + output_config.effort |
| deepseek- | none,high,max | 正常 | reasoning_effort |
| gemini-3 | minimal,low,medium,high | **无 Toggle** | thinkingConfig.thinkingLevel |
| gemini- | low,medium,high | 正常 | thinkingConfig.thinkingBudget (映射) |
| grok- | none,low,medium,high | 正常 | reasoning_effort |

### 映射表
- Claude 3.7 budget_tokens: low→1024, medium→4096, high→16384, xhigh→32768, max→32768
- Gemini 2.5 thinkingBudget: low→1024, medium→4096, high→16384

### 持久化
- 不持久化，每次刷新恢复默认关闭

## Decisions (ADR-lite)

| 决策 | 选择 | 理由 |
|------|------|------|
| 模式 | per-model catalog | 比 per-vendor 更精准，参考 ai-toolbox |
| Catalog 形式 | 内嵌 JS 数组 | 项目无需额外文件加载，修改简单 |
| UI | Toggle + 等级下拉 | 去掉厂商下拉，模型名自动匹配 |
| 匹配 | 正则子串，按优先级匹配 | 先匹配精确模型（gpt-5-pro），再匹配通用模式（gpt-） |
| Gemini 3 | 无 Toggle | 无法关闭思考 |
