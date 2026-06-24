# PRD: 状态指示器与清空按钮垂直对齐 + 用户消息框高度增加0.25倍

## 目标

1. **垂直对齐**：`.btn-row` 中"清空结果"按钮与 `.waiting-inline` 状态指示器的文本中心在同一水平线上。
2. **用户消息框高度增加 0.25 倍**：用户消息卡片中 `pre.answer-content` 的 `max-height` 从 120px 增至 150px（120 × 1.25）。

## 需求细节

### 1. 垂直对齐

**现状**：
- `.btn-row` 是 `display: flex; gap: 10px; flex-wrap: wrap`（默认 `align-items: stretch`）
- `.btn` 有 `padding: 8px 14px`，font-size 继承（~14px）
- `.waiting-inline` 有 `display: inline-flex; align-items: center; margin: 0; padding-left: 10px`
- `.waiting-inline .label` 有 `font-size: 12px`
- 两者文本中心不在同一水平线

**改动**：
- `.btn-row` 添加 `align-items: center` 使 flex 子项垂直居中对齐
- 这会让按钮和状态指示器的中心线对齐

### 2. 用户消息框高度增加 0.25 倍

**现状**：
- `.card pre` 和 `.code-block pre` 共享 `max-height: 120px`（line 534）
- `.message.assistant pre.answer-content` 有 `min-height: 24px`（line 734）但无覆盖 max-height

**改动**：
- 为 `.message.user pre.answer-content` 添加 `max-height: 150px` 覆盖默认的 120px

## 文件影响

- `assets/css/styles.css` — 两处 CSS 调整
