# CLI 画像头部契约（来自 all-api-hub 源码）

来源：`/tmp/opencode/aah/repo/src/services/verification/aiApiVerification/requestProfiles.ts` 与 `claudeRequestProfile.ts`、`headerOverrides.ts`。为只读调研所得，本地未复制其 TS 代码，仅提炼数据结构与行为契约。

## 三套基础头

```json
{
  "codex": {
    "user-agent": "codex_cli_rs/0.164.0 (Windows 10.0; x86_64)",
    "originator": "codex_cli_rs",
    "session-id": "<UUID v4>",
    "thread-id": "<UUID v4>",
    "x-client-request-id": "<UUID v4>",
    "x-codex-window-id": "<thread-id>:0"
  },
  "claude": {
    "user-agent": "claude-cli/2.1.306 (external, cli)",
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "x-claude-code-session-id": "<UUID v4>",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
  },
  "gemini": {
    "user-agent": "GeminiCLI/0.65.0/<modelId> (win32; x64; cli)"
  }
}
```

## 增强档追加 / 覆盖项

### Codex
- `x-client-request-id` 覆盖为 `thread-id`（不再是新 UUID）
- `x-codex-turn-metadata`：JSON 字符串，结构如下

```json
{
  "installation_id": "<UUID v4>",
  "session_id": "<同 session-id 头>",
  "thread_id": "<同 thread-id 头>",
  "window_id": "<thread-id>:0",
  "window_number": 0,
  "turn_id": "<UUID v4>",
  "root_turn_id": "<同 turn_id>",
  "request_kind": "turn",
  "history_initialization": "new",
  "model": "<modelId>",
  "turn_started_at_unix_ms": "<Date.now() 数字>"
}
```

- 写入三处：头本身、`body.client_metadata['x-codex-turn-metadata']`（字符串）、`body.client_metadata['x-codex-installation-id']`（从上面解析出的 installation_id）
- `body.prompt_cache_key = session-id`

### Claude
- 追加 8 项 `x-stainless-*`：`lang=js`、`package-version=0.128.0`、`os=Windows`、`arch=x64`、`runtime=node`、`runtime-version=v26.3.0`、`retry-count=0`、`timeout=600`
- `anthropic-beta` 追加 4 项：`thinking-token-count-2026-05-13`、`context-management-2025-06-27`、`prompt-caching-scope-2026-01-05`、`effort-2025-11-24`
- URL 加 `?beta=true`
- body.system 插入 billing header（含 SHA-256 指纹）与伪造 CWD/日期，并加 `cache_control`

### Gemini
- 增强档不加头，只往 `body.systemInstruction.parts` 注入身份文本。

## 通用规则

- 每个画像的头对象末尾 `...custom`：用户自定义头覆盖任意生成值。
- 身份为本地生成，不复制登录态客户端凭证。
- Fetch 标准允许 `user-agent`，但部分浏览器实现会忽略网页设置的值；本项目用自建代理设置上游 UA（见 prd.md R3 与 proxy-runtime.md）。
- 参考项目靠扩展权限 `declarativeNetRequestWithHostAccess` 改 UA（wxt.config.ts:69,81；headerOverrides.ts:200-215），不适用于本项目纯网页形态。

## 真实性边界

头是客户端自报信息，可伪造；这套模拟只证明「网关接受某种请求形状」，不构成严格身份认证。签名/token/mTLS 不在能力范围内。
