# 错误信息显示优化与 HTTP URL 兼容

## Goal

修复两个前端 UX 问题：(1) 上游 API 返回错误时，页面只显示 HTTP 状态码（如"HTTP 401"），完整错误信息被藏在折叠区域，用户无法一眼看到失败原因；(2) 不带协议前缀的 URL 输入（如 `localhost:8080`）被强制补为 `https://`，导致本地 HTTP 服务无法测试——通过在输入框下方添加提示文字引导用户显式输入 `http://` 前缀。

## Requirements

* 错误信息主标题应包含 HTTP 状态码 + statusText（如 `HTTP 401 Unauthorized`），让用户一眼知道失败原因
* 当 statusText 为空时，尝试从 JSON 响应体提取错误摘要（如 `error.message`、`error`、`message`、`detail`），格式为 `HTTP 500: <msg>`
* 无协议前缀的 URL 仍默认补 `https://`，但在 API URL 输入框下方添加提示文字："本地服务请输入 http:// 前缀"，引导用户手动指定协议
* 提示文字仅在输入框获得焦点且值为空/无协议前缀时显示，失焦或已有协议前缀时隐藏

## Acceptance Criteria

* [ ] 上游返回 401 时，错误标题显示为"错误：HTTP 401 Unauthorized"（而非仅"错误：HTTP 401"）
* [ ] 上游返回 429 时，错误标题显示为"错误：HTTP 429 Too Many Requests"
* [ ] 上游返回无 statusText 的错误时，尝试从 JSON 响应体提取错误摘要（如"错误：HTTP 500: Internal server error"）
* [ ] JSON 响应体提取失败或非 JSON 时，回退到仅显示状态码（如"错误：HTTP 502"）
* [ ] API URL 输入框下方有提示文字，告知用户本地服务需加 `http://` 前缀
* [ ] 提示文字在输入框有 `http://` 或 `https://` 前缀时自动隐藏
* [ ] 输入 `http://` 前缀的地址行为不变
* [ ] 输入 `https://` 前缀的地址行为不变
* [ ] 无前缀时仍补 `https://`（现有行为不变）

## Definition of Done

* 改动仅限前端 JS/CSS/HTML
* 手动验证错误显示和 URL 提示行为
* 不破坏现有正常流程

## Technical Approach

### 错误信息：在 Error 构造时把 statusText 纳入 message，statusText 为空时解析 JSON 响应体

`fetchAndStream` 改为：
```javascript
let statusLabel = res.statusText ? `HTTP ${res.status} ${res.statusText}` : `HTTP ${res.status}`;
if (!res.statusText && text) {
  try {
    const json = JSON.parse(text);
    const msg = (json?.error?.message) || (typeof json?.error === 'string' && json.error)
              || json?.message || json?.detail;
    if (msg && typeof msg === 'string' && msg.length <= 200) {
      statusLabel = `HTTP ${res.status}: ${msg}`;
    }
  } catch { /* 非 JSON，忽略 */ }
}
const e = new Error(statusLabel);
```

### URL 提示：在 API URL 输入框下方添加动态提示

在 `apiUrlEl` 下方插入一个 `<small>` 提示元素，通过 JS 控制显隐：
- focus 且值无 `https?://` 前缀 → 显示
- blur 或值有协议前缀 → 隐藏

## Out of Scope

* 后端改动
* 错误信息国际化/多语言
* URL 格式校验

## Technical Notes

* 关键文件：`assets/js/script.js`、`assets/css/styles.css`
* 错误构造：L3217-3227 `fetchAndStream`
* 错误展示：L3146 catch handler + L303-358 `addInlineError`
* URL 规范化：L106-113 `normalizeApiUrl`
* URL 输入框：L7 `apiUrlEl`，L795-796 blur 事件
