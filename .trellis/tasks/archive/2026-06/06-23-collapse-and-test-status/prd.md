# PRD: 轮次与消息用户信息默认折叠 + 测试状态移至清空结果右侧

## 目标

1. **用户消息默认折叠**：在"轮次与消息"列中，role=user 的消息卡片默认折叠，点击可展开；assistant/tool 消息保持展开不变。
2. **测试状态移至清空结果右侧**：将现有的等待状态指示器（`.waiting-inline`，显示"连接中...""接收数据中..."等）从 `#waitingContainer`（位于 timelineColumn 内部）移到 `.btn-row` 中"清空结果"按钮的右侧。

## 需求细节

### 1. 用户消息默认折叠

**现状**：
- `addMessage(role, label, payload)` 创建 `.card.message.{role}` 卡片，追加到 `#messageTimeline`
- 消息卡片当前无折叠/展开功能
- 项目已有两种折叠模式可复用：代码块折叠（`.code-block.collapsed`）和 Reasoning 折叠（`.reasoning-section.collapsed`）

**改动**：
- 当 `role === 'user'` 时，给消息卡片添加 `collapsed` class
- 添加折叠/展开 toggle 控件（可复用现有 `.toggle-btn` 样式或类似箭头图标）
- 折叠状态下隐藏消息内容（payload），只显示 role 标签 + toggle
- 点击 toggle 切换折叠/展开
- assistant/tool 消息不受影响，保持展开

**实现参考**：
- 代码块折叠：`script.js:475-547`，CSS `styles.css:1472-1504`
- Reasoning 折叠：`script.js:3884-3979`，CSS `styles.css:1596-1646`

### 2. 测试状态移至清空结果右侧

**现状**：
- `#waitingContainer` 是 `#timelineColumn` 内的空 div（`index.html:129`）
- `showWaiting()` 动态创建 `.waiting-inline` 元素并追加到 `#waitingContainer`
- `.waiting-inline` 包含：label（阶段文字+计时）、dots 动画、abort 按钮
- `hideWaiting()` 移除该元素

**改动**：
- 将 `#waitingContainer` 从 `#timelineColumn` 移到 `.btn-row` 中，位于 `#clearBtn` 之后
- 调整 CSS：`.waiting-inline` 在按钮行内需要适配 flex 布局，保持与按钮对齐
- JS 逻辑（`showWaiting`/`hideWaiting`/`ensureWaitingEl`）无需改动，因为它们操作的是 `#waitingContainer`，只是容器换了位置
- 移除原 `#waitingContainer` 在 timelineColumn 中的位置

## 不涉及

- 不改变 assistant/tool 消息的显示方式
- 不改变 inline status blocks（info/success/error）的位置
- 不改变 abort 按钮的功能
- 不改变 phase label 文字内容

## 文件影响

- `index.html` — 移动 `#waitingContainer` 位置
- `assets/js/script.js` — `addMessage()` 添加 user 消息折叠逻辑
- `assets/css/styles.css` — 用户消息折叠样式 + waiting-inline 在按钮行的适配
