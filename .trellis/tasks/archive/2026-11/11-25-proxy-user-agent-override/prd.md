# 统一模型测试入口与客户端画像代理

## Goal

让客户端画像作为全局请求配置作用于兼容的模型测试，并通过用户自建代理把 User-Agent 真正送抵网关。结构化输出、大海捞针、上下文容量及模型指纹与既有测试同级，统一运行、停止及结果入口。

## Background

- 本项目是纯前端静态页面，无服务端组件（README.md:3, 84-87）。
- 开发前，`applyProxy()`（script.js:110-117）只对 `http://` 目标改写为 `${proxy}/proxy/${baseUrl}`；HTTPS 目标直接原样 fetch。所有端点构造函数统一调用它（script.js:143-167），模型列表同样经过（script.js:2065）。这些行号为规划时的定位。
- 代理地址存 localStorage key `httpProxyUrl`（script.js:104-108），UI 输入框在 index.html:48。
- 开发前，仓库中没有代理服务端代码（无 wrangler.toml / fetch handler / server 入口）；`/proxy/` 只是前端拼出的 URL 约定。归档任务 `06-24-http-auto-proxy` 曾把「为用户提供代理服务」列为 Out of Scope；本任务仅交付用户自行部署的源码。
- Fetch 标准已允许 User-Agent，但 Chromium 等浏览器实现仍可能忽略网页设置的值；不能把本地 `testing-core.js:113` 的限制常量视为标准规定。依据见 `research/proxy-runtime.md`。
- 参考项目 all-api-hub 靠浏览器扩展权限 `declarativeNetRequestWithHostAccess` 在网络层改 UA（wxt.config.ts:69,81；headerOverrides.ts:200-215），该路径不适用于纯网页。

## Requirements

### R1 - HTTPS 目标可经代理转发（开关控制）
新增「经代理转发」开关，默认关闭。关闭时 HTTPS 行为与现状完全一致；打开后所有 API 请求（含模型列表）经代理转发。`http://` 目标保持当前自动改道行为不变。

### R2 - 前端传递画像 UA 与身份头
内置 Codex / Claude / Gemini 三套 CLI 画像，分基础档和增强档；允许用户自定义头覆盖任意生成值。所选画像的头信息随请求传给代理，由代理注入上游。

- 基础头（来自 requestProfiles.ts:57-125）：
  - Codex `user-agent: codex_cli_rs/0.164.0 (Windows 10.0; x86_64)`、`originator: codex_cli_rs`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`
  - Claude `user-agent: claude-cli/2.1.306 (external, cli)`、`x-app: cli`、`anthropic-version: 2023-06-01`、`x-claude-code-session-id`
  - Gemini `user-agent: GeminiCLI/0.65.0/${modelId} (win32; x64; cli)`
- 增强头：`x-codex-turn-metadata`（结构见 research 文档）、`x-stainless-*`（8 项）、追加 `anthropic-beta` flags（4 项）。
- 契约需通用：兼容用户已有代理，不绑定单一实现。

### R3 - 随项目交付可部署的 Worker 源码
提供一份可自行部署的 Cloudflare Worker（或等价实现）源码，处理 `/proxy/<目标URL>` 路由：按前端约定接收 UA 与自定义头，注入上游请求；正确转发流式响应（SSE）与非流式 JSON；处理 CORS 与 OPTIONS 预检。用户部署到自己的账号，本项目不在运行时托管服务。

### R4 - 既有能力不回归
默认请求、未开代理开关、模型列表和普通测试场景保留原有行为；指纹检测算法、参考数据、手动评分与采样能力保留，导航按 R5 调整。

### R5 - 统一测试入口与全局客户端画像（用户追加）

- 客户端画像移至 API 请求配置，保留默认/Codex/Claude/Gemini、基础/增强、自定义头及代理提示；兼容的普通模型测试、三项诊断和指纹自动采样都使用本轮画像。
- 删除厂商层的「能力测试」「模型指纹」入口；结构化输出、大海捞针、上下文容量、模型指纹与现有智商题等测试项并列。
- 使用同一运行、停止和清空入口；选中测试后仅展示相关参数及结果，容量搜索保留逐次记录与预算说明，指纹保留自动/手动、并行、重新生成与单样本重试。
- 指纹继承所选协议，补齐 Google 请求与响应适配；检测算法和参考数据不改，参考库仍只在首次选中指纹时加载。
- 画像选择可切换到兼容协议；手动切换不兼容协议时清晰反馈并恢复默认画像，不能发送错误协议形状。模型列表、参考数据和 Images 请求不注入 CLI 画像。
- 每轮快照协议、模型、画像、代理及参数；切换场景/协议或修改代理时停止旧运行，等待参考数据加载期间也不能产生迟到采样。

## Acceptance Criteria

- [x] 「经代理转发」开关默认关闭，关闭时 HTTPS 请求行为与改动前一致
- [x] 开关打开且配置代理后，HTTPS API 端点经代理转发且请求成功
- [x] 选择 Codex/Claude/Gemini 画像并开启增强档时，代理实际发出的请求带对应完整头（用本地 mock 上游验证 UA 真实到达）
- [x] 自定义头能覆盖生成的头值
- [x] 默认画像不注入伪造 UA
- [x] `http://` 目标既有代理行为不回归
- [x] 普通模型请求及三项诊断经代理可用；客户端画像通过实际模型请求验证，另以流式场景及延迟 SSE 验证首段在流结束前到达
- [x] 模型列表在代理开关打开时仍可用
- [x] Worker 源码有部署说明，本地可启动 mock 验证
- [x] 有可复现的端到端验证证据（UA 到达上游的实证）

验收记录与复现命令见 `implement.md` 的最终验证部分。证据覆盖本地 Chrome → Node 代理 → HTTP/HTTPS mock；不代表 Cloudflare/workerd、外部网关或真实模型能力已验证。

### 追加验收：统一测试入口

- [x] 厂商栏只保留真实协议类别，四个诊断/指纹入口与智商题位于同一测试项栏
- [x] 画像配置在测试区外，普通文本、工具多轮、流式、诊断及指纹兼容请求均真实应用一次
- [x] 模型列表、Images multipart/JSON、参考库下载不应用画像；默认请求和敏感值遮罩不回归
- [x] 四协议下结构化输出/大海捞针/容量可分别运行，参数和结果对应当前单项
- [x] 指纹自动采样、手动评分、并行、重试、取消与首次懒加载可用，Google 使用原生协议
- [x] 场景/协议/代理切换取消旧运行，指纹加载阶段无迟到采样，各样本与多轮请求使用本轮快照
- [x] 桌面及移动端可达、无横向溢出；原生浏览器及本地 mock 提供以上行为证据

追加验收已通过 77 项原生浏览器检查，含收到 200/401 响应头后取消、切换或重跑的八项回归。普通测试为抽样覆盖；完整证据及运行命令见 `implement.md`。

## Technical Notes

- 三项已定决策：① 代理服务端「两者都要」——交付可部署 Worker 源码 + 通用前端契约；② UA「内置三套 + 基础/增强两档 + 自定义覆盖」；③ 代理改道「显式开关，默认关」。
- 代理会看到 API Key，UI 需在开启开关时明确提示这一点（用户已据此选择显式开关）。
- 代码复用优先：扩展现有 `applyProxy` / `getProxyUrl`，不新造第二套代理机制；画像头注入复用 `testing-core.js` 的 `buildProfileHeaders`，不复制参考项目 TS 代码原文。
- 仅在非默认画像实际经过已配置代理且显式开关开启时发送覆盖契约；同一次请求只生成一套身份 ID。自定义头按名称大小写不敏感覆盖。
- Worker 保留目标 URL 的编码与查询串。为避免浏览器绕过代理继续跳转，上游重定向返回可读代理错误；普通上游错误保留其状态与响应体。

## Out of Scope

- 把项目改造成浏览器扩展（放弃纯静态形态）
- 伪造签名 / token / mTLS 证书等严格身份认证要素
- 运行时托管公共代理服务
- 修改参考项目 all-api-hub 本身
