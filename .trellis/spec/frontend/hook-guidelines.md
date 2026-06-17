# Hook Guidelines

> How hooks are used in this project.

---

## Overview

<!--
Document your project's hook conventions here.

Questions to answer:
- What custom hooks do you have?
- How do you handle data fetching?
- What are the naming conventions?
- How do you share stateful logic?
-->

(To be filled by the team)

---

## Custom Hook Patterns

<!-- How to create and structure custom hooks -->

(To be filled by the team)

---

## Data Fetching

### Fetch Error Display Contract

When frontend code fetches data and renders errors in the UI, preserve the distinction between an HTTP response and a browser/network failure.

**HTTP response exists**:
- Show a concise title with `HTTP <status> <statusText>`.
- Show the attempted method and sanitized URL.
- Show a sanitized backend response summary when available.

**No HTTP response exists** (`TypeError: Failed to fetch`):
- Do not claim a backend reason that the browser did not expose.
- Show contextual hints only: backend unavailable, wrong URL/port, CORS, or proxy issue.
- Include the attempted method and sanitized URL so the user can verify configuration.

**Secret safety**:
- Never render request headers, cookies, API keys, tokens, or `Authorization` values.
- Sanitize response bodies and URLs before inserting them into the UI.

Example:

```js
if (err && err.status) {
  renderModelError({
    title: `请求失败：HTTP ${err.status}${err.statusText ? ' ' + err.statusText : ''}`,
    details: [
      `请求：GET ${sanitizeUrlForDisplay(modelUrl)}`,
      `后端返回：${getBackendResponseSummary(err.responseBody)}`
    ]
  });
} else if (err && err.name === 'TypeError') {
  renderModelError({
    title: '无法连接 API',
    details: [
      `请求：GET ${sanitizeUrlForDisplay(modelUrl)}`,
      '浏览器未返回后端响应，无法判断具体原因。',
      '可能原因：后端不可用、URL/端口错误、跨域(CORS) 或代理问题。'
    ]
  });
}
```

### Generic Request Test Flow

The request-test flow uses `fetchAndParse()` instead of `renderModelDropdownError()`. It must still convert browser `TypeError: Failed to fetch` into a named `FetchNetworkError` with `url` and `method`, then render the same contextual network hints. Do not show the raw browser message as the user-facing error.

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

<!-- Hook-related mistakes your team has made -->

(To be filled by the team)
