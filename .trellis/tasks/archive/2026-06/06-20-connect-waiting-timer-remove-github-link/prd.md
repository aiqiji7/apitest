# 连接中等状态显示耗时并移除 GitHub 跳转

## Goal

在发送测试请求进入等待/连接中状态时，显示从等待开始累计的耗时；同时移除页面头部跳转到 `https://github.com/aiqiji7/apitest` 的 GitHub 链接，避免用户误触跳转。

## What I already know

* 项目是单页纯前端网页，主要入口为 `index.html`，逻辑在 `assets/js/script.js`，样式在 `assets/css/styles.css`。
* 当前等待器由 `ensureWaitingEl()` 创建，标签初始文案为 `连接中...`，随后 `createOnPhaseCallback()` 会按请求阶段更新为 `等待响应...`、`接收数据中...`、`处理响应中...`。
* 请求期间 `showWaiting()` 会把等待器追加到 `messageTimeline` 下，请求结束后 `finally` 中 `hideWaiting()` 移除。
* 页面头部 `index.html` 存在 `.subnote.github-link`，包含 GitHub 图标与 `<a href="https://github.com/aiqiji7/apitest" target="_blank"...>@aiqiji7</a>`。

## Assumptions (temporary)

* 耗时从 `showWaiting()` 显示“连接中...”开始计时。
* 等待器标签保留当前阶段文案，并在同一行追加 `已等待 Xs` 或 `已等待 Xm Xs`。
* 请求结束、清空结果、中止请求时停止并移除计时器，避免后台继续更新。
* 不改变请求超时逻辑与中止逻辑。

## Requirements (evolving)

* 连接中等状态显示持续计时耗时。
* 计时显示应随请求阶段文案一起更新，例如：`连接中... 已等待 0:05`。
* 请求结束、用户中止、清空结果时计时停止并清理。
* 移除 `https://github.com/aiqiji7/apitest` 的跳转链接。

## Acceptance Criteria (evolving)

* [ ] 点击“发送测试请求”后，等待器显示 `连接中...` 与实时耗时。
* [ ] 等待超过 1 秒后，耗时数字会递增更新。
* [ ] 请求结束、中止或清空结果后，等待器消失且计时器不再更新。
* [ ] 页面头部不再包含 `https://github.com/aiqiji7/apitest` 或可点击 GitHub 链接。
* [ ] 现有 API 请求、模型列表获取、错误展示逻辑不受影响。

## Definition of Done

* 代码改动仅覆盖本次需求相关文件。
* 通过基础静态检查（至少用 `node --check assets/js/script.js` 或等价校验）。
* 如项目无测试/构建脚本，则记录未执行测试的原因。

## Out of Scope (explicit)

* 不新增依赖。
* 不改变 API 请求超时时间。
* 不新增构建系统或测试框架。
* 不移除或重写其他页面说明文案。

## Technical Approach

* 在 `assets/js/script.js` 的等待器辅助函数中增加：
  * `waitingStartedAt`
  * `waitingTimerId`
  * `formatWaitingDuration()`
  * `startWaitingTimer()`
  * `stopWaitingTimer()`
  * `refreshWaitingLabel()`
* `showWaiting()` 调用 `startWaitingTimer()`；`hideWaiting()`、`clearResults()` 和中止按钮路径调用 `stopWaitingTimer()`。
* `updateWaitingLabel()` 改为调用 `refreshWaitingLabel()`，保留阶段文案并追加当前耗时。
* 在 `index.html` 删除 `.subnote.github-link` 块；在 `styles.css` 删除对应 `.github-link` 样式。

## Technical Notes

* 已检查文件：
  * `assets/js/script.js:189-237` 等待器创建/显示/隐藏。
  * `assets/js/script.js:873-884` 请求阶段文案。
  * `assets/js/script.js:1742-1771` 发送请求时显示等待器。
  * `assets/js/script.js:3093-3097` 请求结束清理等待器。
  * `index.html:15-20` GitHub 跳转链接。
  * `assets/css/styles.css:100-109` GitHub 链接样式。
* 未发现项目根 `package.json`，因此可能没有现成 lint/typecheck；需根据仓库实际脚本决定最终校验。
