# HTTP API 自动代理功能

## Goal

当用户在前端填写 `http://` 开头的 API URL 时，自动通过 HTTPS 代理转发请求，解决 HTTPS 页面无法访问 HTTP API 的混合内容限制问题。

## Requirements

- 在 API URL 输入框旁添加一个代理地址输入框
- 检测 API URL 是否以 `http://` 开头
- 如果是 `http://` 且已配置代理地址，自动将请求 URL 改写为 `${proxyUrl}/proxy/${原始httpUrl}` 格式
- 如果是 `https://` 地址，保持原行为，不经过代理
- 当 API URL 输入 `http://` 但未配置代理地址时，在输入框旁显示醒目的警告标识，提示用户需要配置代理
- 代理地址通过 localStorage 独立存储（key: `httpProxyUrl`），与现有 `apiConfigs` 分离
- 用户正常填写原始 `http://` URL，无需手动改写代理前缀

## Acceptance Criteria

- [ ] API URL 输入 `http://` 地址且已配置代理时，请求自动走代理转发
- [ ] `https://` 地址保持原行为，不走代理
- [ ] 代理地址输入框在 API URL 输入框旁，默认可见
- [ ] 代理地址修改后自动持久化到 localStorage
- [ ] `http://` URL 未配置代理时，显示警告标识提示

## Definition of Done

- 功能在 GitHub Pages 部署后可用（HTTPS 页面请求 HTTP API 走代理成功）
- 本地测试通过（`https://` 地址不受影响）
- 兼容现有配置管理机制（命名配置、最近连接等）

## Out of Scope

- 为用户提供代理服务（用户需自行搭建 Cloudflare Worker 或其他 HTTPS 代理）
- 多代理地址管理（一个全局代理地址即可）
- 为每个命名配置单独配置代理地址

## Technical Approach

### UI 变更

- 在 `index.html` 的 API URL 输入框旁新增一个代理地址输入框
- 在 API URL 输入框旁添加一个警告图标，当检测到 `http://` 且未配置代理时显示

### 逻辑变更（`script.js`）

1. **新增函数** `getProxyUrl()` — 从 localStorage 读取代理地址
2. **新增函数** `saveProxyUrl(url)` — 保存代理地址到 localStorage
3. **新增函数** `applyProxy(baseUrl)` — 如果 baseUrl 以 `http://` 开头且有 proxyUrl，改写为 `${proxyUrl}/proxy/${baseUrl}`；否则原样返回
4. **修改所有 `buildXxxEndpoint()` 函数** — 在拼路径前先调用 `applyProxy(base)`
5. **修改模型列表获取逻辑** — GET `/v1/models` 也需走代理
6. **添加 input 事件监听** — API URL 输入框变化时检测 `http://`，切换警告图标显示/隐藏

### 数据存储

- localStorage key: `httpProxyUrl`
- 读取: `localStorage.getItem('httpProxyUrl') || ''`
- 保存: 输入框 `change`/`input` 事件时自动保存

## Decision (ADR-lite)

**Context**: HTTPS 页面无法发起 HTTP 请求（Mixed Content 限制），API 服务器无法升级 HTTPS，需要前端自动代理。
**Decision**: 在 API URL 输入框旁添加代理地址配置，检测到 `http://` 时自动改写 URL 走代理；代理地址 localStorage 独立存储。
**Consequences**: 用户需要自行搭建 HTTPS 代理；全局单一代理地址；代理格式约定为 `${proxyUrl}/proxy/${originalUrl}`。

## Technical Notes

- 关键文件：`assets/js/script.js`（URL 处理逻辑）、`index.html`（UI）
- `script.js:106-130` — URL 处理核心函数
- `script.js:114-130` — 所有 endpoint 构建函数需修改
- `index.html:30` — API URL 输入框位置
- 代理格式参考 Cloudflare Worker 通用代理设计：`/proxy/http://target:port/path`
