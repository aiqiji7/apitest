# OpenAI Responses API 适配图片支持和 IQ 测试

## Goal

为 OpenAI 厂商下的"图片支持"和"模型智商测试题"两个测试项增加 Responses API 协议支持，通过协议切换开关统一控制，减少按钮数量。

## What I already know

* 当前 OpenAI 厂商下只有工具调用分了两种协议（`openai_tools` / `responses_tools`），以独立按钮呈现
* 图片支持只有 `openai_image`（Chat Completions），IQ 测试只走 Chat Completions 端点
* Responses API 图片格式与 Chat Completions 完全不同：
  - `input[]` 替代 `messages[]`
  - `input_image` 替代 `image_url`（且 `image_url` 是直接字符串，不是嵌套对象）
  - `input_text` 替代 `text`
* IQ 测试在 Responses API 中请求体格式为 `{ model, input, stream }` 而非 `{ model, messages, stream }`
* 搜索已有 `responses_search`，Chat Completions 不支持搜索，无需适配
* UI 结构：`vendorType`（厂商选择）→ `testType`（测试场景按钮，JS 动态渲染）→ 输入区

## Decision (ADR-lite)

**Context**: OpenAI 有两套 API 协议（Chat Completions / Responses），需要让图片和 IQ 测试支持两种协议。独立按钮方案会导致 OpenAI 下按钮过多（6 个 IQ 按钮 + 2 个图片按钮 + 2 个工具按钮 + 1 个搜索 = 11 个）。

**Decision**: 采用协议切换开关方案。在 `vendorType` 和 `testType` 之间增加一个 "Chat Completions / Responses" 分段控件，仅在 OpenAI 厂商下显示。切换开关影响图片和 IQ 测试的请求构建逻辑，工具调用和搜索保持独立按钮不变。

**Consequences**:
- 按钮数量从 11 个减少到 7 个（2 IQ + 1 图片 + 2 工具 + 1 搜索 + 1 图片(Responses)）
- 用户需理解切换开关只影响部分测试项（图片、IQ），工具调用和搜索仍各自标注协议
- 切换开关状态需在厂商切换时重置为 Chat Completions

## Requirements

1. **协议切换开关**：在 `vendorType` 和 `testType` 之间增加分段控件
   - 两个选项：`Chat Completions`（默认）和 `Responses`
   - 仅在 `currentVendor === 'openai'` 时显示，其他厂商隐藏
   - 切换时重置测试场景到第一个按钮
   - 状态变量：`let openaiProtocol = 'chat_completions';`

2. **图片支持适配 Responses API**：
   - 当协议为 Responses 时，`openai_image` 场景的请求构建走 Responses API
   - 端点：`buildResponsesEndpoint(apiUrl)`
   - 请求体：`{ model, input: [{ role: 'user', content: [{ type: 'input_text', text: userText }, { type: 'input_image', image_url: currentImageData, detail: 'auto' }] }], stream }`
   - 图片来源复用现有 `currentImageData`（base64 data URL）
   - 流式/非流式响应解析复用现有 `fetchAndStream` 逻辑

3. **IQ 测试适配 Responses API**：
   - 当协议为 Responses 时，IQ 测试的请求构建走 Responses API
   - 端点：`buildResponsesEndpoint(apiUrl)`
   - 请求体：`{ model, input: [{ role: 'user', content: userText }], stream }`
   - 复用现有 IQ 测试的 prompt、答案验证、参考信息展示逻辑

4. **工具调用和搜索不受影响**：保持独立按钮，不受切换开关控制

5. **按钮标签**：图片按钮在 Responses 协议下显示为"图片支持 (Responses)"，Chat Completions 下显示为"图片支持"；IQ 测试按钮标签不变（协议由切换开关决定）

6. **等待状态四阶段细化**：将当前单一的"请求中"等待动画细化为四个阶段，实时反映请求生命周期：
   - **阶段 1 - 连接中**：从 `fetch()` 发出到收到 HTTP 响应头（`await fetch()` 返回）
   - **阶段 2 - 等待首个 chunk**：从收到响应头到流式读取器返回第一个有效数据 chunk（`reader.read()` 首次返回非空数据）
   - **阶段 3 - 接收数据中**：从首个 chunk 到流式读取完毕（`reader.read()` 返回 `done: true`）
   - **阶段 4 - 处理响应中**：从流式读取完毕到 UI 渲染完成（非流式响应则为从收到响应头到 JSON 解析 + UI 渲染完成）
   - 实现方式：扩展 `ensureWaitingEl()` / `showWaiting()` 使 label 文案可动态更新；在 `fetchAndStream` 中通过回调或事件通知调用方切换阶段文案
   - 非流式响应：阶段 1 → 阶段 4（跳过阶段 2、3）
   - 阶段文案：`连接中...` → `等待响应...` → `接收数据中...` → `处理响应中...`

## Acceptance Criteria

- [ ] OpenAI 厂商下出现 Chat Completions / Responses 协议切换开关
- [ ] 切换到 Anthropic/Google 时开关隐藏，切回 OpenAI 时显示
- [ ] 协议为 Responses 时，图片测试使用 `input_image` + `input_text` 格式发送请求
- [ ] 协议为 Responses 时，IQ 测试使用 `input[]` 格式发送请求
- [ ] 协议为 Chat Completions 时，行为与当前完全一致
- [ ] 流式和非流式模式均正常工作
- [ ] 工具调用和搜索按钮不受切换开关影响
- [ ] 等待动画显示四阶段文案：连接中... → 等待响应... → 接收数据中... → 处理响应中...
- [ ] 非流式响应跳过阶段 2、3，直接从连接中进入处理响应中
- [ ] 多轮工具调用场景下，每轮请求都正确显示四阶段状态

## Definition of Done

* 手动测试：切换协议开关，确认请求体格式正确、响应正常渲染
* 不引入新依赖
* 现有功能无回归

## Out of Scope

* 搜索测试项适配（Chat Completions 不支持搜索，无需适配）
* 工具调用按钮合并到切换开关（保持独立按钮，逻辑更清晰）
* Responses API 的 `file_id` 图片输入方式
* `detail` 参数的 UI 选择器（使用默认 `auto`）

## Technical Notes

* 关键文件：`assets/js/script.js`（~3155 行）、`index.html`（~202 行）
* `buildResponsesEndpoint()` 已存在（line 125）
* `vendorTests.openai` 数组定义在 line 785
* `IQ_TEST_BUTTONS` 是共享的，三个厂商都引用同一组按钮；无需拆分，协议切换在请求构建层处理
* `sendStandardTextRequestForVendor` 需要扩展：当 `vendor === 'openai'` 且 `openaiProtocol === 'responses'` 时走 Responses API 路径
* `IMAGE_SCENARIOS` 常量无需修改（`openai_image` 场景名不变，协议由切换开关决定）
* `isIqTestScenario` 无需修改（scenario 名不变）
* HTML：在 `vendorType` div 后、`testType` div 前插入协议切换分段控件
* CSS：复用现有 `.segmented` / `.seg-btn` 样式
* 等待状态细化关键改动点：
  - `ensureWaitingEl()`（line 190-208）：label 需改为可动态更新的元素，初始文案为"连接中..."
  - 新增 `updateWaitingLabel(text)` 函数：更新 waiting 动画中的 label 文案
  - `fetchAndStream`（line 2896）：新增 `onPhase` 回调参数，在关键节点通知调用方切换阶段
    - `await fetch()` 返回后 → 通知阶段 2（等待响应...）
    - 流式：`reader.read()` 首次返回有效数据 → 通知阶段 3（接收数据中...）
    - 流式：`reader.read()` 返回 `done: true` → 通知阶段 4（处理响应中...）
    - 非流式：`await res.text()` 返回后 → 通知阶段 4（处理响应中...）
  - 所有调用 `fetchAndStream` 的地方需传入 `onPhase` 回调，回调内调用 `updateWaitingLabel()`
  - `showWaiting()` 调用前需先重置 label 为"连接中..."
* Research: [responses-api-image-format.md](research/responses-api-image-format.md)
