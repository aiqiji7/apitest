# 技术设计：集成 LM Fingerpoint Detector 模型指纹检测

## 1. 目标与边界

在不引入构建步骤、不引入服务端的前提下，把上游 `Ikaleio/lm-detector` 的浏览器端检测能力嵌入当前静态页面：

- 复用现有 API 配置、代理和流式传输。
- 三次采样在浏览器内完成，评分也在浏览器内完成。
- 首版支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
- 参考数据固定快照提交进仓库，运行时只从同源静态路径加载。
- 不包含 Gemini 原生协议、分词器探测、参考库浏览和图片导出。

## 2. 总体结构

```text
index.html
  ├─ #vendorType 新增 fingerprint 按钮
  ├─ #fingerprintPanel（隐藏，仅 fingerprint 模式显示）
  ├─ assets/js/script.js       现有主流程 + 暴露 window.APITestBridge
  ├─ assets/js/fingerprint.js  新增：面板状态、采样、评分、渲染
  └─ assets/vendor/lmfpd/lmfpd-core.js  按需注入的 IIFE bundle（window.LMFPD）
        └─ assets/data/lmfpd/{shared_detector.bin, models.json, VERSION.json, LICENSE}
```

职责边界：

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| `script.js` | 现有配置读取、端点拼接、`fetchAndStream`、代理逻辑 | 指纹业务状态与评分 |
| `fingerprint.js` | 指纹面板、三次采样、手动粘贴、调用评分、结果渲染 | 现有单轮测试流程 |
| `lmfpd-core.js` | 上游算法原样打包：挑战生成、数字解析、数据解码、评分 | DOM、网络、配置 |
| `models.json` | 展示名、家族、`response_count`、`built_at` | 计数矩阵/训练数据 |

## 3. 文件布局

新增：

```text
assets/vendor/lmfpd/
  lmfpd-core.js          # IIFE bundle，window.LMFPD
  LICENSE                # 上游 MIT 原文
assets/data/lmfpd/
  shared_detector.bin    # 4.6 MB 固定快照
  models.json            # 裁剪后的元数据，约几十 KB
  VERSION.json           # upstream ref / built_at / sha256 / 许可
assets/js/fingerprint.js # 指纹面板控制器（classic script）
scripts/sync-lmfpd.mjs   # 维护者同步/校验脚本（不参与站点运行）
```

修改：

```text
index.html               # 厂商按钮、面板、脚本标签
assets/js/script.js      # fingerprint 模式切换 + 暴露 bridge
assets/css/styles.css    # 指纹面板样式（由 designer 主导）
README.md                # 来源、MIT、数据版本、同步方式
```

## 4. 数据管线

### 4.1 固定上游版本

同步脚本固定到一个上游 commit（当前调查版本 `1e58ed83c1cde17f88cba89560ad4d083042ae92`），只下载需要的文件，避免克隆上游 1.9 GB 数据目录：

- `shared/shared-detector.ts`
- `shared/positional.ts`
- `shared/fingerprint-core.js`
- `shared/challenge-browser.js`
- `shared/detector-codec.ts`
- `shared/types.ts`（类型解析兜底）
- `data/shared_detector.bin`
- `data/unified_bank.json`
- `sdk/conformance/analyze.json`（仅本地校验，不发布）
- `LICENSE`

### 4.2 生成物

1. **核心 bundle**：用 esbuild 打包为 IIFE，全局名 `LMFPD`，只导出：
   - `generateChallenges(count, usedLengths)`
   - `parseNumbers(text)`
   - `decodeDetector(bytes)`
   - `analyzeSharedOutputs(outputs, bank, detector, options)`

   命令形态：

   ```bash
   npx --yes esbuild <tmp>/entry.ts --bundle --format=iife \
     --global-name=LMFPD --target=es2020 \
     --banner:js="/*! LM Fingerpoint Detector ... MIT ... */" \
     --outfile=assets/vendor/lmfpd/lmfpd-core.js
   ```

   选择 IIFE 而不是 ESM：当前站点全部是 classic script，且需要兼容直接打开 `index.html` 的场景；IIFE 不引入模块/CORS 差异。

2. **裁剪元数据**：从 `unified_bank.json` 只保留评分与展示需要的字段：

   ```json
   {
     "schema": "robust-number-fingerprint-bank",
     "built_at": "2026-10-25T10:04:10.682171+00:00",
     "models": [
       {"id": "...", "display_name": "...", "family": "...", "family_name": "...", "response_count": 36}
     ]
   }
   ```

   `analyzeSharedOutputs` 只通过这些字段做版本校验和结果展示；12.7 MB 的计数矩阵不进入浏览器。

3. **VERSION.json**：记录 `upstream_ref`、`built_at`、`detector_sha256`、`models_sha256`、`license`，用于 UI 展示和缓存失效。

4. **自检**：同步脚本最后用 Node 加载生成的 `lmfpd-core.js`，对 `sdk/conformance/analyze.json` 的用例评分，断言预测与决策；失败则中止写入，避免发布错误 bundle。

### 4.3 更新方式

```bash
node scripts/sync-lmfpd.mjs --ref <commit>
```

脚本不参与 `index.html` 加载，也不要求部署环境安装 esbuild。

## 5. 核心模块契约

`window.LMFPD`：

```ts
generateChallenges(count?: number, usedLengths?: number[]): Challenge[]
// Challenge = {id, expected_count, prompt}

parseNumbers(text: string): number[]
// 只返回最长的一段 1..355 连续数字；其它文字/代码块不会误判

decodeDetector(bytes: Uint8Array): SharedDetector

analyzeSharedOutputs(
  outputs: {text: string, expected_count: number}[],
  bank: BankMeta,
  detector: SharedDetector,
  options?: {allowPartial?: boolean}
): Analysis
```

`Analysis` 关键字段：`prediction`、`prediction_name`、`probability`、`probability_status`、`family_prediction_name`、`results[]`、`diagnostics[]`、`sequence`、`decision`、`evidence`。

评分前必须校验：

- `bank.built_at === detector.bank_built_at`
- `bank.models.length === detector.model_ids.length`
- `bank.models[i].id === detector.model_ids[i]`
- `bank.models[i].response_count === detector.response_counts[i]`

任一不满足时显示“参考数据与检测器版本不匹配”，不输出排名。

## 6. 请求与解析

### 6.1 格式矩阵

指纹面板自带格式选择，不依赖当前厂商 tab：

| 格式 | 端点 | Header | Body |
| --- | --- | --- | --- |
| OpenAI Chat | `buildEndpoint(apiUrl)` | `Authorization: Bearer` | `{model, messages:[{role:'user',content}], stream}` |
| OpenAI Responses | `buildResponsesEndpoint(apiUrl)` | `Authorization: Bearer` | `{model, input:[{role:'user',content}], stream, store:false}` |
| Anthropic | `buildAnthropicEndpoint(apiUrl)` | `x-api-key`, `anthropic-version: 2023-06-01` | `{model, max_tokens:8192, messages:[{role:'user',content}], stream}` |

固定参数，不发送思考等级/effort/temperature，避免不同轮次参数漂移。`stream` 默认 `true`，遵循面板内开关。

### 6.2 端点与代理

直接调用 `script.js` 暴露的端点构造函数，保证与现有流程一致：

- `applyProxy` 只在目标是 `http://` 且配置了代理时改写 URL。
- 不在指纹模块里重复代理判断，避免两套行为。

### 6.3 文本提取

流式：`fetchAndStream` 的 `result.text` 已经是拼接后的正文，可直接解析。

非流式：`fetchAndStream` 返回 `{json, text}`，按格式提取：

- Chat：`json.choices[0].message.content`（字符串或 `[{type:'text',text}]`）
- Responses：`json.output[]` 中 `type==='message'` 的 `content[]` 里 `type==='output_text'` 的 `text`；兜底 `json.output_text`
- Anthropic：`json.content[]` 中 `type==='text'` 的 `text`

提取后统一交给 `LMFPD.parseNumbers`。有效数字少于 `max(80, ceil(expected_count*0.55))` 时标记该样本未采用。

### 6.4 采样策略

- 默认并行 3 条，面板提供“并行请求”开关。
- 每条独立 `AbortController`；整体取消会中止所有。
- 单条重试：只替换该条题目并重新请求，保留其它已成功样本；`usedLengths` 传入其它两条的长度，保证题目长度不重复。
- 整体重来：重新生成三条题目并清空状态。
- 请求超时沿用 `fetchAndStream` 的连接/空闲超时；错误信息经 Key 脱敏后显示。

## 7. 状态机

```text
idle
  └─ start ──> sampling ──> scoring ──> result
                    │            │
                    ├─ all fail ─┴─> error
                    └─ stop ───────> idle/partial
```

每个样本：`idle | requesting | streaming | done | rejected | aborted`。

评分条件：

- 0 条有效：`decision: unscorable`，提示每条至少 80 个数字。
- 1–2 条有效：`decision: partial`，显示排名，概率列显示“置信度不可用”。
- 3 条有效：`decision: scored`，显示闭集概率。
- 序列形态不像语言模型：`decision: not_model`，不显示排名，显示解释。

## 8. UI 集成

### 8.1 入口

在 `index.html` 的 `#vendorType` 增加：

```html
<button class="seg-btn" data-vendor="fingerprint">模型指纹</button>
```

`script.js`：

- `renderTestButtons('fingerprint')` 清空 `#testType`，不设置默认输入。
- `setActiveVendor` 增加 `document.body.classList.toggle('fingerprint-mode', vendor === 'fingerprint')`。
- 切换时派发 `window.dispatchEvent(new CustomEvent('apitest:vendor-change', {detail:{vendor}}))`，由 `fingerprint.js` 激活/中止。
- `#openaiProtocol` 在 fingerprint 模式保持隐藏。
- `#testBtn` 点击处理在 fingerprint 模式直接返回（按钮也会被 CSS 隐藏）。

CSS 在 `body.fingerprint-mode` 下隐藏：`#testType`、现有用户消息输入、图片输入区、现有发送/清空按钮行、现有流式开关行。API 配置区和厂商切换保持可见。

### 8.2 面板结构

```html
<section id="fingerprintPanel" class="fingerprint-panel" hidden>
  <div class="fingerprint-header">标题 / 说明 / API 格式 / 模式（API·手动）</div>
  <div class="fingerprint-toolbar">开始 / 停止 / 重新生成 / 并行开关 / 状态</div>
  <div class="fingerprint-data-status">参考数据加载进度 / 版本 / 重试</div>
  <div class="fingerprint-samples">三张样本卡</div>
  <div class="fingerprint-result">评分结果</div>
  <div class="fingerprint-attribution">上游链接 / MIT / 数据版本</div>
</section>
```

样本卡：

- 序号、题目长度、题目折叠区
- API 模式下只读输出区（流式追加），手动模式下 textarea
- 状态、耗时、有效数字数、错误/重试/停止

结果卡：

- 预测模型名 + 家族 + 概率（scored 时）
- Top 5 候选，概率条，其余可展开
- `evidence.reason` 中文说明
- 诊断：每条 `parsed_numbers / minimum_numbers / accepted`
- 序列形态：`autocorrelation`、`small_step_share`
- 固定提示：**参考库内闭集排序，不是身份证明**
- 数据版本：`built_at`、模型数量

视觉与响应式由 `@designer` 主导；实现必须保留上面的信息层级与状态，不把警告/partial 状态弱化。

## 9. 数据加载与缓存

`fingerprint.js` 首次进入面板时：

1. 注入 `lmfpd-core.js`（`<script>`，只注入一次）。
2. `fetch('assets/data/lmfpd/models.json')`。
3. 从 IndexedDB 读取 `shared_detector.bin`：
   - key：`built_at + ':' + detector_sha256`（来自 `VERSION.json`）
   - 命中直接 `decodeDetector`
   - 未命中：流式 `fetch` + `ReadableStream` 统计进度，下载完成后写入 IndexedDB
4. 校验 `models.built_at` 与 detector 的 `bank_built_at`。
5. 失败时显示错误和“重试”，不阻塞页面其它功能。

降级：

- IndexedDB 不可用：只在内存缓存，提示下次进入会重新下载。
- `file://` 打开导致 fetch 失败：提示“请通过 http(s) 访问页面以加载参考数据”。

## 10. 错误处理与隐私

- 所有错误先经过现有 `sanitizeSensitiveText`/Key 替换再渲染。
- 不把响应正文、API Key、请求头写入 `console` 或 localStorage。
- 指纹结果默认只保存在内存；刷新即丢失。
- 不接入第三方统计；数据请求仅同源。
- 采样请求必然会把提示词和模型输出发给用户配置的 API，这一点在 UI 说明中写清。

## 11. 兼容性与回滚

兼容性：

- 目标浏览器：Chrome/Edge 92+、Safari 15.4+、Firefox 90+（`crypto.randomUUID`、`AbortSignal.any` 已有降级）。
- 数据文件 4.6 MB，低于 GitHub Pages 单文件限制；只在进入面板时加载。
- 不新增构建步骤；`scripts/sync-lmfpd.mjs` 仅维护者使用。

回滚：

- 删除 `#fingerprintPanel`、厂商按钮、两个脚本标签。
- 删除 `script.js` 中的 bridge 暴露和 fingerprint 分支（约 30 行）。
- 删除 `assets/vendor/lmfpd/`、`assets/data/lmfpd/`、`assets/js/fingerprint.js`、`scripts/sync-lmfpd.mjs` 和对应 CSS。
- 不涉及数据迁移；最多残留一个 `fingerprintFormat` localStorage 键。

## 12. 验证策略

### 12.1 算法一致性（无网络、无 API Key）

Node 脚本在 `vm` 沙箱中加载 `lmfpd-core.js`，提供 `window`、`crypto`、`TextEncoder/TextDecoder`，然后：

- 解码 `shared_detector.bin`
- 读取 `models.json`
- 对 `sdk/conformance/analyze.json` 用例评分

断言：

| 用例 | 期望 |
| --- | --- |
| `scored-claude-opus-4.8` | `decision=scored`，`prediction=claude-opus-4.8`，`probability>0.9` |
| `partial-two` | `decision=partial`，`probability=null` |
| `unscorable-short` | `decision=unscorable`，`results=[]` |
| `not-model-sorted` | `decision=not_model`，`results=[]` |
| `truncated` | `decision=scored`，`used_outputs=3` |

### 12.2 端到端（本地静态页 + mock API）

- 启动 `python3 -m http.server` 或等价静态服务器。
- 启动 mock API，按三种格式返回 conformance 样本：
  - Chat：SSE `choices[0].delta.content`
  - Responses：SSE `response.output_text.delta`
  - Anthropic：SSE `content_block_delta`
- Playwright 断言：
  1. 初始加载不请求 `shared_detector.bin`。
  2. 进入指纹页后显示数据加载进度并最终就绪。
  3. 三种格式各完成三次采样，结果 Top 1 为 `claude-opus-4.8`。
  4. 两条有效回答显示 partial 且无概率。
  5. 排序数字显示 `not_model` 且无排名。
  6. 手动粘贴三条 conformance 回答得到相同结果。
  7. 结果区包含闭集提示与 `built_at`。
  8. 切回现有厂商，原有测试按钮和发送流程仍正常。

### 12.3 人工验收

- 桌面 + 375px 移动宽度截图检查。
- 检查首屏不因新增面板产生布局跳动。
- 检查 Key 在错误场景中不出现于页面文本。

## 13. 关键权衡

| 决策 | 选择 | 理由 | 代价 |
| --- | --- | --- | --- |
| 入口 | 第 5 个厂商按钮 + 独立面板 | 复用现有 API 配置区，改动最小 | 语义上“厂商”包含一个工具 |
| 代码复用 | `script.js` 暴露窄 bridge | 不重构 5000 行主文件 | 新增一个全局对象 |
| 核心打包 | IIFE + `window.LMFPD` | 兼容 classic script / 直接打开页面 | 无法按需 tree-shake 到函数级 |
| 数据 | 4.6 MB 原始 bin 提交仓库 | 无解压兼容问题、离线可用 | 仓库增大约 4.6 MB |
| 评分线程 | 主线程 + “计算中” | 实测约 130 ms | 极低端设备可能短暂卡顿 |
| 默认并发 | 三条并行 | 缩短等待 | 可能触发渠道限流，提供开关 |
| 参数 | 固定，不带思考等级 | 保证重复检测可比 | 用户不能为检测单独调 effort |
