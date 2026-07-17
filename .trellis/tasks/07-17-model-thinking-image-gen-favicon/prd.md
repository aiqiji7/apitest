# 思考等级更新 + 图片识别 + Images Tab + favicon + 模型选中高亮

## Goal

更新 API 测试页的模型思考等级目录、图片相关测试能力与基础 UI 细节，使页面与最新 OpenAI-compatible 能力对齐，并改善模型选择可读性。

## Background

### 代码现状

- 思考等级：`assets/js/script.js` 中 `MODEL_CATALOG`（约 1007–1043 行）。
- 当前 `gpt-5.5` 含非法 `minimal`（与 2026-04 LiteLLM 实测冲突）。
- 图生文场景：`openai_image` / `anthropic_image` / `gemini_image`，按钮文案「图片支持」。
- 厂商 Tab：OpenAI / Anthropic / Google；协议切换仅 OpenAI 显示。
- 模型下拉：`renderModelDropdown` 无选中态样式。
- 无 favicon。

### 外部证据摘要

详见 `research/thinking-levels-and-images-2026-07.md`。

关键结论：

| 区域 | 结论 |
|------|------|
| gpt-5.5 | none/low/medium/high/xhigh，无 minimal |
| gpt-5.5-pro | medium/high/xhigh |
| gpt-5.6 | none/low/medium/high/xhigh/max |
| Claude 新模型 | adaptive + effort（含 max/xhigh） |
| Gemini 3 | thinkingLevel；Pro 无 minimal |
| DeepSeek | none/high/max 基本正确 |
| Grok 4.5 | low/medium/high，默认 high，无 none |
| Images API | `/v1/images/generations` + `/v1/images/edits` |

### 用户决策

1. 思考等级：**全面复核所有厂商**
2. 文生图/图生图：**独立 Images 厂商 Tab**
3. Favicon：**新建简洁 SVG**
4. 追加：模型列表中**高亮当前已选模型**

## Requirements

### R1 — 思考等级目录全面复核

- 修正 OpenAI 家族（至少 5.5 / 5.5-pro / 5.6）。
- 有证据则更新 Anthropic / Gemini / DeepSeek / Grok。
- Mistral/Qwen/GLM/Kimi/Cohere/Nova：实现前再查；无冲突保持。
- 保持 per-model catalog（specific 优先）。

### R2 — 图片识别改名

- 三厂商「图片支持」→「图片识别」。
- 场景 ID 可不变。
- 成功提示可同步为识别语义。

### R3 — Images 厂商 Tab（文生图 / 图生图）

- 厂商分段新增 **Images**。
- 测试项：
  - 文生图 → `POST {base}/v1/images/generations`
  - 图生图 → `POST {base}/v1/images/edits`
- 使用当前 API URL / Key / Model。
- Images Tab 隐藏 Chat/Responses 协议切换。
- 展示 `b64_json` 或 `url` 结果图 + 请求/响应块。
- 图生图复用图片输入区；文生图不强制图片。
- OpenAI Tab 保留「图片识别」（图生文）。

### R4 — Favicon

- 新增简洁 SVG（主题色贴近页面蓝 `#1e90ff`），`index.html` 引用。

### R5 — 模型列表选中高亮

- 模型下拉中，与 `#model` 当前值匹配的项使用不同背景色突出。
- 过滤/刷新后仍正确高亮。
- 手动输入模型名后再次打开列表时，匹配项高亮。

## Acceptance Criteria

- [ ] AC1: gpt-5.5 等级不含 `minimal`，与 API 一致。
- [ ] AC2: gpt-5.5-pro / gpt-5.6 等条目与 research 一致。
- [ ] AC3: 已复核厂商 catalog 与 research 一致；无证据厂商保持原行为。
- [ ] AC4: 三厂商按钮显示「图片识别」，原图生文可用。
- [ ] AC5: 出现 Images Tab；文生图/图生图可请求并展示结果图。
- [ ] AC6: Images Tab 不显示协议切换。
- [ ] AC7: 页面有 SVG favicon。
- [ ] AC8: 模型下拉中当前模型有明显背景高亮。
- [ ] AC9: 工具调用/搜索/IQ 等非目标场景无回归。

## Out of Scope

- Anthropic / Google 原生文生图 API
- Images 流式 partial images / mask 局部重绘
- 独立后端代理
- 配置管理弹窗内模型列表高亮（仅主页面模型下拉）

## Open Questions

无阻塞项。规划完成后请用户审阅 `prd.md` / `design.md` / `implement.md`，确认后再 `task.py start`。
