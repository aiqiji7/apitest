# 兼容 GLM 全模型推理参数

## Goal

让当前纯前端 API 测试页在使用 GLM 系列模型时，能按不同模型版本和不同 GLM 提供方发送正确的思考/推理参数，覆盖 Z.AI、智谱 BigModel 和阿里云百炼 OpenAI 兼容接口的主要差异，避免当前只发送 `thinking.type` 导致阿里云 GLM 参数不生效的问题。

## What I already know

* 用户要求：修改当前代码以兼容 GLM 的所有模型。
* 当前项目是纯前端页面，主要逻辑集中在 `assets/js/script.js`。
* 当前 GLM catalog 只有 `disabled/enabled` 两档，参数构造只返回 `{ thinking: { type: ... } }`。
* Z.AI / BigModel 原生 GLM 接口使用 `thinking.type` 控制思考开关，GLM-5.2 及以上支持顶层 `reasoning_effort`。
* 阿里云百炼 OpenAI 兼容 GLM 接口使用顶层 `enable_thinking: true/false` 控制思考开关，不使用 `thinking.type`。
* 现有响应解析已经支持 `reasoning_content` 和部分 GLM CDATA thinking 内容，主要缺口是请求参数构造。

## Requirements

* GLM 参数构造必须兼容 Z.AI / BigModel 原生格式：
  * 启用：`thinking: { type: "enabled" }`
  * 禁用：`thinking: { type: "disabled" }`
  * GLM-5.2+ 非禁用等级同时发送顶层 `reasoning_effort`。
* GLM 参数构造必须兼容阿里云百炼 OpenAI 兼容格式：
  * 启用：`enable_thinking: true`
  * 禁用：`enable_thinking: false`
  * GLM-5.2+ 非禁用等级同时发送顶层 `reasoning_effort`。
* Provider 判断基于用户填写的 API URL，至少识别：
  * `dashscope.aliyuncs.com`
  * `dashscope-intl.aliyuncs.com`
  * `maas.aliyuncs.com`
* GLM model catalog 必须把更具体模型放在通用 `glm-` 规则前，避免被泛化规则截获。
* GLM-5.2+ 的 UI 等级必须包含禁用和官方推理等级：`disabled`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`。
* 通用 GLM 模型仍保留 `disabled/enabled` 开关，避免对不支持 `reasoning_effort` 的旧模型发送非法参数。
* 当用户选择 `disabled` 时，不应额外发送 `reasoning_effort`。
* 改动应复用现有 catalog + `buildThinkingParams` 模式，尽量不改 UI 结构、不引入依赖、不改响应解析。

## Acceptance Criteria

* [ ] 模型 `glm-5.2` + Z.AI/BigModel URL + 等级 `max` 构造请求包含 `thinking.type: "enabled"` 和 `reasoning_effort: "max"`。
* [ ] 模型 `glm-5.2` + Z.AI/BigModel URL + 等级 `disabled` 构造请求只禁用 thinking，不发送 `reasoning_effort`。
* [ ] 模型 `glm-5.2` + 阿里云 URL + 等级 `high` 构造请求包含 `enable_thinking: true` 和 `reasoning_effort: "high"`。
* [ ] 模型 `glm-5.2` + 阿里云 URL + 等级 `disabled` 构造请求包含 `enable_thinking: false`，不发送 `thinking.type` 或 `reasoning_effort`。
* [ ] 模型 `glm-5`, `glm-5.1`, `glm-4.7`, `glm-4.6`, `glm-4.5` 默认仍至少提供启用/禁用思考模式，不错误发送 GLM-5.2 专属参数。
* [ ] 非 GLM 模型的现有 thinking 参数行为不回退。
* [ ] 页面仍能加载，现有请求体展示能看到实际发送参数。

## Definition of Done

* 代码改动完成并符合前端 spec 中的 catalog、请求构造、错误展示和响应解析约定。
* 执行可用的静态/语法检查；若项目没有正式测试脚本，则至少用轻量方式验证 JS 语法。
* 完成 `trellis-check` 质量检查。
* 判断是否需要更新 `.trellis/spec/`，如有新约定则沉淀。
* 按 Trellis Phase 3 生成提交计划，不混入用户已有无关改动。

## Technical Approach

* 在 `assets/js/script.js` 内扩展 `MODEL_CATALOG`：先匹配 `glm-5.2`，再匹配通用 `glm-`。
* 为 GLM 参数构造增加 URL-aware provider 判断，基于当前 API URL 判断是否是阿里云百炼 OpenAI 兼容入口。
* 在 `buildThinkingParams` 中新增 GLM-5.2 专用参数分支，保留通用 GLM 分支。
* 尽量把变化限制在请求参数构造层，不改测试场景、UI DOM 结构、响应解析和本地配置结构。

## Decision (ADR-lite)

**Context**: GLM 不同提供方虽然模型名相同，但请求参数不同；当前 catalog 只按模型名判断，无法区分阿里云与 Z.AI/BigModel。

**Decision**: 保持现有 per-model catalog 作为主结构，同时在 GLM 参数构造分支里加入 API URL provider 判断。这样能最小化改动，并覆盖同一模型名在不同 provider 下的参数差异。

**Consequences**: 需要读取当前 API URL 来构造参数；自定义代理或兼容服务如果伪装为阿里云但 URL 不含已知域名，仍会走 Z.AI/BigModel 格式。该风险可接受，因为 UI 是用户手动配置 API URL，且当前任务不引入 provider 选择器。

## Out of Scope

* 不新增独立 GLM provider 按钮或 provider 选择 UI。
* 不实现 DashScope 原生 `/api/v1/services/aigc/text-generation/generation` 请求结构。
* 不修改响应流解析，除非检查发现当前请求参数改动必须配套修复。
* 不修改非 GLM provider 的思考等级策略。
* 不处理阿里云 GLM-4.6 / GLM-4.7 下架迁移提示。

## Research References

* [`research/glm-thinking-compatibility.md`](research/glm-thinking-compatibility.md) — GLM thinking/reasoning 参数在 Z.AI、BigModel、阿里云之间的差异和推荐实现方式。

## Technical Notes

* 主要代码位置：`assets/js/script.js` 的 `MODEL_CATALOG`、`buildThinkingParams()` 和各请求构造点。
* 相关规范：`.trellis/spec/frontend/component-guidelines.md` 的 per-model catalog 模式；`.trellis/spec/frontend/hook-guidelines.md` 的请求体展示约定；`.trellis/spec/frontend/quality-guidelines.md` 的响应解析注意事项。
