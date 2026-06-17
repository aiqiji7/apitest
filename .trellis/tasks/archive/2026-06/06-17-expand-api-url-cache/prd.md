# API URL 手动展开缓存列表按钮

## Goal

在 API URL 输入区域增加一个按钮，让用户可以手动展开 API URL 输入框下方已有的最近连接/缓存列表，而不是只能通过聚焦输入框触发。

## Requirements

* 在 `.url-input-group` 内的 API URL 输入框旁增加缓存列表展开按钮
* 按钮样式：紧凑图标按钮，沿用 `.model-fetch-btn` 风格（SVG 图标）
* 点击按钮后，在 API URL 输入框下方展开已有的最近连接列表（`recentDropdown`）
* 列表内容与 API URL 输入框聚焦/输入时出现的最近连接列表保持一致
* 无最近连接缓存时按钮 disabled 不可点击
* 点击最近连接项后保持现有行为：填入 API URL、API Key 和模型输入框

## Confirmed Decisions

* 按钮放在 API URL 输入区域（`.url-input-group` 内），输入框旁
* 最近连接/缓存列表展示在 API URL 输入框下方
* 无缓存时按钮 disabled 状态
* 按钮样式：图标按钮，与 `.model-fetch-btn` 一致
* 列表样式：复用现有 `.recent-dropdown` 模式
* 最近连接项点击 → 填入 API URL、API Key 和模型输入框

## Decision (ADR-lite)

**Context**: 用户需要在 API URL 区域手动展开最近连接/缓存列表，而非只能通过输入框聚焦触发
**Decision**: 在 URL 输入框旁加图标按钮展开现有 `recentDropdown`
**Consequences**: 低风险，纯增量改动，不改变现有缓存逻辑

## Acceptance Criteria

* [ ] API URL 输入框旁出现缓存展开按钮（图标风格，与 `.model-fetch-btn` 一致）
* [ ] 点击按钮展开 API URL 最近连接/缓存列表（URL 输入框下方），复用 `.recent-dropdown` 样式
* [ ] 无最近连接缓存时按钮 disabled
* [ ] 点击最近连接项自动填入 API URL、API Key 和模型输入框
* [ ] 样式与现有 UI 一致，无布局破坏

## Definition of Done (team quality bar)

* Lint / typecheck 通过
* 样式与现有 UI 一致

## Out of Scope (explicit)

* 不改变现有最近连接存储逻辑
* 不影响模型输入框已有的下拉/刷新功能
* 不新增单独的模型缓存列表入口

## Technical Notes

* 关键文件：`index.html`（URL 区域）、`assets/js/script.js`（最近连接渲染和事件绑定）、`assets/css/styles.css`（样式）
* 最近连接渲染：`renderRecentDropdown(filterText)`
* 最近连接读取：`loadRecentConnections()`
* 现有模式：`.model-fetch-btn` 图标按钮、`.recent-dropdown` 下拉样式
