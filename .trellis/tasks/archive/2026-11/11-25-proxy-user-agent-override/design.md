# Design: 统一模型测试入口与客户端画像代理

## 架构与边界

```
浏览器页面（纯前端）
  ├─ testing-core.js  生成画像头（纯逻辑，不区分是否走代理）
  ├─ script.js        全局画像 + 同级场景 + 统一传输与代理改道
  ├─ capability.js    结构化 / 大海捞针 / 容量三个单项控制器
  └─ fingerprint.js   指纹采样 / 手动评分控制器（继承本轮配置）
          │  HTTPS 请求（带 X-APITest-Override-Headers）
          ▼
用户自建 HTTPS 代理（本项目交付 Worker 源码，用户自行部署）
  ├─ 解析覆盖头 → 注入 User-Agent 等身份头
  ├─ 转发到真实上游（支持 SSE 流式透传）
  └─ 补 CORS 响应头、处理 OPTIONS 预检
          ▼
真实 API 网关
```

**边界**：本项目仍无运行时服务端。Worker 是交付给用户的源码，不是被托管的服务。前端契约通用，兼容用户已有代理（只要对方实现同一个覆盖头约定）。

## 数据流与契约

### 代理改道开关

- localStorage key：`httpsProxyEnabled`（默认 `'0'`）。
- 只有「开关开启 + 已配置代理地址 + 目标为 HTTPS」三者同时满足，`applyProxy()` 才改写 URL 为 `${proxy}/proxy/${baseUrl}`。
- 开关关闭时 HTTPS 目标原样返回，行为与改动前完全一致。
- `http://` 目标的既有自动改道不变（不受开关影响）。

### 覆盖头传递契约（前端 → 代理）

前端在发往代理的请求上附加一个头：

```text
X-APITest-Override-Headers: <JSON 字符串，键为头名，值为头值>
```

示例：

```json
{"user-agent":"codex_cli_rs/0.164.0 (Windows 10.0; x86_64)","originator":"codex_cli_rs","session-id":"..."}
```

- 只有非默认画像成功应用、开关开启且本请求实际经已配置代理转发时才附加此头。
- 默认画像、未开开关时不附加。
- 头名固定，大小写不敏感（HTTP 头语义）。
- 覆盖映射使用本次 `applyRequestProfile()` 返回的 `profileHeaders`，不重新生成 ID。JSON 序列化为 ASCII 安全字符串；实际头名和值仍须符合 HTTP 头限制。

### Worker 行为契约

1. 路由 `OPTIONS` 预检：返回 `204`，带允许方法与允许头（含 `x-apitest-override-headers`、`authorization`、`x-api-key`、`content-type`）。
2. 路由沿用 `/proxy/<完整原始目标URL>`，截取路径时保留外层查询串，不整体解码目标路径。可额外接受整体编码一次的目标，但不得重复解码。仅接受 http/https、有 hostname、无 username/password 的 URL。
3. 读取 `X-APITest-Override-Headers`，JSON.parse 后覆盖到上游请求头（覆盖优先级最高，含 `user-agent`）。
4. 剥离代理专属头后再转发，避免把覆盖头泄露给上游。
5. 使用 `fetch` 转发上游请求，保留 method / body / signal，设置 `redirect: 'manual'`。上游 301/302/303/307/308 返回 502 `UPSTREAM_REDIRECT`，不向浏览器返回 Location，避免凭证随跳转泄露或请求绕过代理。
6. 其余响应原样透传状态码与响应体；对 `text/event-stream` 用流式透传（`res.body`），不缓冲整段。
7. 给响应补 CORS 头（`Access-Control-Allow-Origin` 等）。
8. 上游错误（不可达/DNS 失败）返回结构化 JSON 错误，便于前端归类。
9. 覆盖映射必须是字符串值对象；无效名称、CR/LF/NUL、不可表示的值、代理控制头和连接级头返回 400。移除浏览器 Cookie/Origin/Referer/Sec-*、Host/Content-Length 和 hop-by-hop 头，包括 Connection 动态列出的头；保留 API 凭证和普通业务头。
10. 预检允许实际业务头，Authorization 显式允许；正常及错误响应均补 CORS。使用 Node 原生适配器做本地真实网络验证；若无已安装的 workerd/Wrangler，不以 Node 验证声称 Cloudflare 运行时已验证。

### 画像头生成

- 扩展 `testing-core.js` 的 `buildProfileHeaders(profile, modelId, options)`，`options.enhanced` 控制增强档，`options.custom` 为用户覆盖映射。
- 保持纯函数特性（无 DOM / 无网络），沿用现有 `uuid()` / `randomHex()`。
- 增强档 Codex 的 `x-codex-turn-metadata` 为 JSON 字符串；相关系数生成在纯逻辑层完成，不在 Worker 里做。
- `applyRequestProfile({ profile, vendor, url, headers, body, modelId, options: { enhanced, custom } })` 保持旧调用兼容，额外返回本次 `profileHeaders`，并按生成后的同一套头更新 body 和 URL。调用者发送返回的 url，保留现有查询参数并处理 Claude 增强档 beta=true。
- `APITestBridge.prepareProfileTransport({ url, headers, profileHeaders, applied })` 返回 `{ url, headers, proxyRouted, overrideRequested }`；负责实际代理判定、覆盖载荷与从浏览器请求头中移除 UA，不重新生成画像。
- 自定义头使用 JSON 字符串映射；合并顺序为基础、增强、自定义，最后一次合并后不再追加 beta flags。默认画像不应用增强或自定义头。
- 原有基础画像 body 行为保留。此次增强限于 PRD 的头字段及 Codex metadata、Claude beta query；不新增研究记录中的伪造 billing、CWD 或日期内容。

## 关键权衡

### 用户追加：场景统一（取代旧面板导航契约）

- `currentVendor` 仅表示 OpenAI/Anthropic/Google/Images；主脚本维护唯一选中场景。`structured`、`needle`、`capacity`、`fingerprint` 是同级 scenario，不再冒充 vendor。
- 主脚本拥有全局画像控件、选项校验、协议兼容及统一运行/停止入口；能力控制器复用三个 runner；指纹控制器保留算法、数据缓存和采样机制。
- 统一 bridge：`registerScenarioController(id, { activate, deactivate, run, stop, clear })`；主脚本用本轮 ctx 调用 `run(ctx)`；controller 调用 `setScenarioRunState(id, { running, label?, stopEnabled? })` 同步主运行按钮与停止状态。controller 的 activate/deactivate 不触发模型请求。
- `captureRunContext()` 返回独立配置副本，含原有配置、`scenario`、`profile: { id, enhanced, custom }`；`bindRunContext(signal, ctx)` 将本轮快照绑定给传输。主脚本普通测试及控制器都在启动前捕获，指纹的子请求/重试绑定同一快照。
- 在 `fetchAndStream` 网络前统一识别兼容模型端点并调用 core 画像一次，然后复用原代理契约。能力控制器删除自行应用画像路径，防止重复；Images、模型列表及参考数据不应用画像。
- 传输第六个参数 `{ runContext, onPrepared, profileMode }` 供控制器显式传入本轮配置及接收实际画像信息；`onPrepared` 接收 `{ url, options, applied, transport }`，普通调用通过 signal 绑定保留原签名。调试展示实际准备后的头/body，敏感值照常遮罩。
- 指纹：协议取本轮 `ctx.protocol`，Google 使用 Gemini generate/streamGenerateContent；异步加载前捕获 epoch 和 ctx，返回后核验仍是当前运行；各样本解析使用快照协议。退出或协议切换停止加载后的迟到工作。
- UI 保留 `profileSelect/profileOptions/profileCustomHeaders` 等已有 ID；全局主运行仍为 `testBtn`，停止为 `stopTestBtn`。指纹保留 mode/regenerate/parallel/data/retry/sample/result 元素，移除内部格式选择器和重复主运行按钮。
- 双写入分工：designer 独占 index/styles/script/capability；fixer 独占 fingerprint.js，通过上述 bridge 合同整合。测试在两路结束后统一更新，避免同时修改 harness。
- 取消覆盖 fetch、成功/错误正文读取及 SSE：外部取消统一抛 AbortError，普通运行及回调同时检查 signal/epoch；过期运行不得记录错误、渲染响应、冲刷缓存或重置新运行状态。内部超时保留 TimeoutError。

| 决策 | 选择 | 理由 |
|---|---|---|
| 代理开关默认值 | 关 | API Key 会经过代理；用户需显式知情开启 |
| UA 注入位置 | 代理层 | 部分浏览器忽略网页设置的 UA；服务端可控制出站头 |
| 覆盖头格式 | JSON 字符串单头 | 无需改代理路由形状，兼容已有 `/proxy/<url>` 约定 |
| 增强档实现层 | 前端纯逻辑 | 便于单测，Worker 只做透传，职责单一 |
| Worker 运行时 | Cloudflare Workers 风格 fetch handler | 与已有 `/proxy/` URL 约定一致，部署简单 |

## 兼容性与迁移

- 归档任务 `06-24-http-auto-proxy` 的 `http://` 自动改道行为完全保留。
- 未配置代理、未开开关的用户：所有请求路径字节级等价。
- 已有自建代理的用户：只要实现 `X-APITest-Override-Headers` 约定即可复用；不实现也能继续用原有 http 代理能力。

## 风险与回滚

- **风险**：代理 sees API Key。缓解：显式开关 + UI 警示文案 + 文档说明。
- **风险**：SSE 缓冲导致流式失效。缓解：Worker 明确流式透传，端到端用能力测试探针验证。
- **风险**：覆盖头被上游看到造成混淆。缓解：Worker 转发前剥离。
- **回滚**：删除 localStorage `httpsProxyEnabled` 相关分支即可回到原行为；Worker 为独立新增文件，删除不影响现有页面。
