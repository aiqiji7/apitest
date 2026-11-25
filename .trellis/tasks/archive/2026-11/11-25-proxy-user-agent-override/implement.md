# Implement: 统一模型测试入口与客户端画像代理

## 前置阅读

- `research/cli-profile-headers.md` — 三套基础头、增强档字段、通用覆盖规则
- `design.md` — 契约（`X-APITest-Override-Headers`）、Worker 行为、权衡
- `.trellis/spec/frontend/quality-guidelines.md`、`.trellis/spec/guides/code-reuse-thinking-guide.md`

## 分阶段清单

### 阶段 1 — 画像头生成增强（纯逻辑，可单测）

- [x] 1.1 扩展 `testing-core.js` 的 `buildProfileHeaders(profile, modelId, options)`
  - `options.enhanced` 布尔，控制增强档
  - `options.custom` 用户覆盖映射，最后 merge（优先级最高）
  - 文件：`assets/js/testing-core.js:148-184`
- [x] 1.2 新增 Codex 增强档：`x-codex-turn-metadata` JSON 字符串（结构见 research）、`x-client-request-id` 覆盖为 `thread-id`
- [x] 1.3 新增 Claude 增强档：8 项 `x-stainless-*` + 4 项 `anthropic-beta` 追加
- [x] 1.4 同一套已生成的头用于增强 body/query 字段，避免重复生成身份；未新增无必要的 extras helper
- [x] 1.5 `applyRequestProfile()` 保持旧签名兼容，接受 options 并返回 profileHeaders；更新 send 调用以传入和消费 url

### 阶段 2 — 前端代理开关与改道（script.js）

- [x] 2.1 `applyProxy(baseUrl)` 增加开关判断：`httpsProxyEnabled === '1'` 时 HTTPS 也改写
  - 文件：`assets/js/script.js:110-117`
  - `http://` 分支逻辑保持不变
- [x] 2.2 新增 `isHttpsProxyEnabled()` / `saveHttpsProxyEnabled()` localStorage 读写
- [x] 2.3 index.html 代理区新增「经代理转发（HTTPS）」开关，含「API Key 会经过代理」警示文案
  - 文件：`index.html:47-50`
- [x] 2.4 开关 UI 事件绑定 + 持久化（参照现有 `httpProxyUrl` 绑定方式，script.js:5064-5072）
- [x] 2.5 `updateHttpProxyUI()` 联动新开关（script.js:5029）

### 阶段 3 — 覆盖头透传（前端 → 代理）

- [x] 3.1 新增 bridge `prepareProfileTransport`，从本次 profileHeaders 生成 ASCII 安全覆盖头，不重新生成身份
- [x] 3.2 在请求发送处附加该头：仅当「非默认画像成功应用、开关开启、实际经已配置代理」
  - 主路径：`fetchAndStream` 调用前（script.js:5088-5109 bridge 区域或 buildXxxEndpoint 调用点）
  - 画像路径：capability.js `send()`（capability.js:204-231）
- [x] 3.3 确认默认画像 / 开关关闭时不附加该头

### 阶段 4 — Worker 源码交付

- [x] 4.1 新建 `proxy/worker.js`（Cloudflare Workers fetch handler 风格）
- [x] 4.2 实现 OPTIONS 预检、`/proxy/<target>` 路由解析
- [x] 4.3 解析并应用 `X-APITest-Override-Headers`，转发前剥离
- [x] 4.4 流式透传 `text/event-stream`，非流式原样返回
- [x] 4.5 CORS 响应头 + 结构化上游错误
- [x] 4.6 新建 `proxy/wrangler.toml` 与 `proxy/README.md`（部署步骤、通用契约、本地验证命令与运行时限制）
- [x] 4.7 验证输入并过滤浏览器/连接级头；拒绝重定向且不跟随；错误响应含 CORS 且不回显凭证

### 阶段 5 — 验证

- [x] 5.1 纯逻辑单测：`buildProfileHeaders` 基础/增强/自定义覆盖三态
- [x] 5.2 本地 mock 上游：验证 UA 与 `x-codex-turn-metadata` 真实到达
- [x] 5.3 浏览器端到端：开关关闭 vs 开启行为对照
- [x] 5.4 能力测试四探针在代理模式下全跑通；另外验证普通流式场景和延迟 SSE 首段
- [x] 5.5 `http://` 既有行为回归
- [x] 5.6 模型列表在开关开启时可用

## 验证命令

```bash
# 语法
for f in assets/js/*.js proxy/*.js; do node --check "$f"; done

# 持久化纯逻辑与 Worker 真实网络测试
node --test tests/testing-core-profiles.test.mjs tests/testing-core-capabilities.test.mjs proxy/worker.test.mjs

# 仅在已有 Wrangler 环境时做 workerd 运行时验证；不自动安装依赖
wrangler dev --config proxy/wrangler.toml --local --ip 127.0.0.1 --port 8787

# 浏览器端到端
node tests/proxy-browser.e2e.mjs
```

## 风险与回滚点

- 阶段 2.1 改动 `applyProxy` 是所有端点共用路径 → 改完立即跑 `http://` 回归（5.5）
- 阶段 3.2 涉及请求头注入 → 必须先确认默认画像不注入（否则污染普通测试）
- 阶段 4.4 SSE 透传是最易出错点 → 用能力测试探针做端到端证据
- 回滚：`httpsProxyEnabled` 默认 `'0'`，删除分支即恢复原行为；`proxy/` 为独立新增目录

## 开工前检查

- [x] PRD 三项决策已在设计中体现
- [x] `.trellis/spec` 相关规范已读
- [x] 无未决 open question；用户要求继续既有任务

## 写入分工与依赖

- Core lane: only `assets/js/testing-core.js` plus focused core regression tests. Publishes the API in design.md.
- UI lane: only `assets/js/script.js`, `assets/js/capability.js`, `index.html`, `assets/css/styles.css`. Owns controls and transport integration against the agreed core API.
- Worker lane: only `proxy/`. Owns Worker source, deploy configuration, instructions, and Node built-in real-network regression tests.
- Verification follows all terminal results: browser plus local mock validates actual UA, query, model listing, direct/proxy matrix, masking, and incremental SSE; no production keys or external API credits.

## 代理阶段验收基线（2026-11-25）

- 核心及 Worker 持久化测试：131/131 通过（画像 45、能力 37、Worker 49）。既有 run.mjs 76/76、capacity.mjs 24/24 通过。
- 原生 Chrome → 实际 Node 代理 → 本地 HTTP/HTTPS mock：34/34 通过，65 次上游请求、62 次代理请求、11 次代理预检；0 运行时异常，2 条精确匹配的预期脱敏错误日志。
- 最终报告：`/tmp/opencode/proxy-ua-e2e-NB4mAU/report.json`；脱敏网络记录：同目录 `network-evidence.json`。
- 最终截图：同目录 `desktop.png`、`desktop-advanced.png`、`mobile.png`、`mobile-advanced.png`。375/768/1024/1440 宽度检查通过；视觉审查未发现实质问题。
- 覆盖证据：三套完整 UA 实收到达、单次身份一致、自定义大小写覆盖、Gemini/Claude 查询串、四探针、普通 SSE 首段先于结束、取消传播、无重定向外跳、模型列表、HTTP 兼容、默认隔离、凭证及空 statusText 错误标题/详情/复制/控制台脱敏。
- 审查发现的六项问题均已修复并回归：空白凭证脱敏、身份值规范化、面板退出、Responses 保留、schema 整数/额外字段、容量估算上下界统一。
- 已同步 `.trellis/spec/frontend/proxy-profile-contract.md` 及关联索引与协议规范；上下文清单验证与 `git diff --check` 通过。
- 验证边界：未部署 Cloudflare，未验证 workerd 或真实外部网关。未安装项目依赖，未使用真实 API Key 或消耗模型额度。
- 交付状态：实现与本地验收完成，任务进入 review；工作区保留未提交供审阅。用户尚未明确授权 Git 提交，因此未执行提交、自动归档或 journal 自动提交。
- 后续分派并发上限为 2，遵守用户本轮新增限制。

## 追加执行：统一测试入口（用户要求）

此前 131 单测 + 34 浏览器检查为代理阶段基线；以下追加验收完成前，不把旧导航断言作为新结构通过证据。

- [x] U1 更新 PRD/设计并恢复 in_progress，沿用既有任务，不新建任务
- [x] U2 designer：index/styles/script/capability 统一协议与场景、全局画像、共用运行停止、集中一次画像处理与真实请求展示
- [x] U3 fixer：仅 fingerprint.js，继承场景及本轮协议/画像，Google 适配、异步 epoch 防护、手动/并行/重试与数据懒加载保留
- [x] U4 更新持久化浏览器测试，覆盖普通文本/工具多轮/搜索/图片识别画像、三项诊断、指纹四协议与手动/懒加载/取消/快照，以及排除路径
- [x] U5 运行核心/Worker 回归、原生浏览器网络验证与响应式视觉验收；修复延迟正文取消问题并补充八项真实浏览器回归
- [x] U6 同步规范与最终任务状态；不自动提交或部署

写入期间 subagent 最多 2 个，无重叠文件所有权。该阶段不更改检测核心、参考数据或 Worker，也不添加依赖。

## 最终统一入口验收（2026-11-25）

- 核心及 Worker 回归：131/131 通过（画像 45、能力 37、Worker 49）。
- 指纹控制器适配定向检查：32/32 通过；普通请求取消修复定向检查：27/27 通过。
- 持久化原生浏览器套件：77/77 通过，113 次本地上游请求、110 次代理请求、15 次预检；0 运行时异常，2 条精确匹配的预期脱敏错误日志。源码哈希在运行前后保持一致。
- 最终报告：`/tmp/opencode/proxy-ua-e2e-LhCBH3/report.json`；脱敏网络记录：同目录 `network-evidence.json`。
- 最终截图：同目录 `desktop-settings.png`、`desktop-diagnostic.png`、`desktop-fingerprint.png` 及对应 `mobile-*.png`。375/768/1024/1440 宽度可达性检查通过；六张同版布局截图经视觉检查无阻断问题。
- 验证范围：同级导航与公共操作；全局三套画像在普通 IQ、工具两轮、诊断中的一次注入；三项诊断 × 四协议；指纹四协议的真实核心/数据、自动/手动、串并行、重试、快照及懒加载取消；Images/模型列表/参考数据排除；SSE 首段与取消；敏感值及空 statusText 错误遮罩。
- 终审发现的非流式取消问题已关闭：200/401 × 停止、切换诊断、切换协议、立即重跑，均先由 CDP 确认响应头和部分正文到达，再取消；旧响应不产生迟到消息、错误、调试块、日志或控件覆盖。
- fix-5 指纹适配、fix-6 取消修复、fix-7 规范同步结果均已逐项核对整合；终审确认无剩余阻塞。规范与上下文清单已同步。
- 普通测试为抽样覆盖，不代表遍历每道 IQ 题或每个搜索/图片分支；所有网络证据来自本地 Chrome → Node 代理 → HTTP/HTTPS mock，未验证 Cloudflare/workerd 或外部模型能力。
- 代码与验收完成后进入 review；用户随后明确授权 Git 提交。已创建功能提交 `c4e5e07`（`feat: 统一模型测试入口并支持客户端画像代理`），源码哈希与最终浏览器验收一致；随后归档任务并记录会话。未推送远端或部署 Cloudflare。
