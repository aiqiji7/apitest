# 模型列表获取改为 API Key 可选

## Goal

将 `/v1/models` 请求中的 API Key 从必填改为可选，支持本地服务（Ollama、vLLM 等）免认证场景。

## Requirements

- 移除 `fetchModelsFromEndpoint()` 中对 API Key 的硬拦截检查
- 有 Key 时带上 `Authorization: Bearer ${key}` 头，无 Key 时裸请求
- 保留 API URL 的必填检查

## Acceptance Criteria

- [ ] API Key 为空时，点击获取模型列表按钮仍能发请求
- [ ] API Key 非空时，行为与当前一致（带 Bearer Token）
- [ ] API URL 为空时，仍显示"请先填写 API URL"提示

## Technical Notes

- 涉及文件：`assets/js/script.js`
- 改动点：
  1. `fetchModelsFromEndpoint()` 第 1697 行：`if (!apiUrl || !apiKey)` → `if (!apiUrl)`
  2. 第 1717-1720 行：条件性添加 `Authorization` 头
  3. `getModelCacheKey()` 第 1680 行：`if (!normalizedUrl || !normalizedKey)` → `if (!normalizedUrl)`，缓存 key 改为仅基于 URL
