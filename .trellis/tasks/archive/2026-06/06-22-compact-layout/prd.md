# Compact Page Layout

## Goal

将现有 AI API 测试页面重新设计为更紧凑的布局，使所有内容在无需滚动的情况下完全显示，提升用户体验。

## What I already know

- 当前页面是纯静态 HTML/CSS/JS 应用
- 使用 `.container` 作为主容器，最大宽度 1200px
- 主要内容在 `.main-card` 中，包含配置区域和测试区域
- 使用 CSS Grid 实现 3 列布局（在 900px 以下变为单列）
- 有多个输入组、按钮组和分段控件
- 结果区域使用 `.split-columns` 双栏布局

## Assumptions (temporary)

- 用户希望在标准桌面分辨率（1920x1080 或类似）下无需滚动
- 移动端可能仍需滚动，但应尽量减少
- 不改变功能，只优化布局和间距

## Open Questions

（无，需求已明确）

## Requirements (evolving)

- 减少各元素之间的垂直间距（section margin、label gap、header margin）
- 优化输入框和按钮的内边距（padding 缩小）
- 保持响应式设计，桌面优先（1920x1080+）
- 配置区域保持展开，只压缩间距和内边距
- 测试区域（选择控件、输入框、按钮）压缩间距
- 结果区域双栏保持现状，有结果时才显示内容
- 缩小字体层级中的冗余空间（h2/h3 margin、section margin）
- 压缩 segmented 按钮组和 btn-row 的间距

## Acceptance Criteria (evolving)

- [ ] 在 1920x1080 分辨率下，配置区 + 测试输入区（不含结果）无需滚动即可完整显示
- [ ] 在 1366x768 分辨率下，核心功能区域（配置 + 厂商选择 + 消息输入 + 按钮）可见
- [ ] 移动端体验仍然可用（布局不破损）
- [ ] 所有现有功能保持不变（配置管理、测试发送、结果展示）
- [ ] 间距压缩后视觉仍然协调，不显得拥挤

## Definition of Done (team quality bar)

* 所有现有功能正常工作
* 响应式设计在不同屏幕尺寸下表现良好
* 视觉设计保持一致性

## Decision (ADR-lite)

**Context**: 页面内容较多，用户希望减少滚动，让主要内容一屏可见
**Decision**: 纯 CSS 间距压缩方案 — 不改变 HTML 结构，通过缩小 margin/padding/gap 让布局更紧凑
**Consequences**: 最小改动风险，不涉及 JS 逻辑，纯样式调整可快速回滚

## Out of Scope (explicit)

- 不改变 JavaScript 逻辑
- 不添加新的功能特性
- 不重构为现代前端框架
- 不折叠/隐藏任何区域（仅压缩间距）
- 不改变 HTML 结构（仅调整 CSS）

## Technical Notes

- 主要修改文件：`assets/css/styles.css`
- 可能需要小幅调整：`index.html`
- 当前布局使用 Flexbox 和 CSS Grid
- 有多个媒体查询断点（600px, 900px）
- 桌面优先优化策略
- 桌面优先优化策略
