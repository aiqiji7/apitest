# 模型智商测试结果时间显示优化

## Goal

优化模型智商测试题的结果文本显示，将"本次响应耗时"信息另起一行并用不同颜色突出显示，提升可读性和视觉层次。

## What I already know

* 当前实现：`addIqTestReference`函数（assets/js/script.js:982）调用`addInlineInfo`显示纯文本信息
* 文本格式：`${test.label} 对比参考：正确答案：${test.expectedAnswer}；参考思考时间：${test.expectedDuration}；本次响应耗时：${formatDuration(durationMs)}。未自动判分，请手动对比模型输出。`
* `addInlineInfo`函数（assets/js/script.js:283）创建`div.info-inline`元素，使用`textContent`设置纯文本
* `formatDuration`函数（assets/js/script.js:554）格式化毫秒为可读时间
* 智商测试场景在`isIqTestScenario`函数中判断（assets/js/script.js:978）

## Assumptions (temporary)

* 用户希望保持其他信息（正确答案、参考思考时间）的显示方式不变
* 需要支持HTML格式以实现换行和颜色样式
* 颜色需要足够醒目但不影响整体UI美观

## Open Questions

* ~~响应时间应该使用什么颜色？（红色、橙色、蓝色等）~~ **已决定：橙色**
* 是否需要保持原有的句号结尾？
* 是否需要调整其他部分的标点符号？
* 是否需要为颜色添加CSS类以便主题一致性？

## Requirements (evolving)

* 将"本次响应耗时：${formatDuration(durationMs)}"部分放在新的一行
* 保持原有文本格式，仅将响应时间部分换行
* 使用橙色突出显示响应时间
* 保持其他信息的显示方式不变
* 确保HTML格式的安全性（避免XSS）

## Acceptance Criteria (evolving)

* [ ] 响应时间显示在新的一行
* [ ] 响应时间使用不同于其他文本的颜色
* [ ] 整体文本格式清晰易读
* [ ] 不影响其他智商测试功能

## Definition of Done

* 代码修改完成，功能正常
* 通过现有测试（如果有）
* UI在不同浏览器中显示一致
* 代码符合项目规范

## Expansion Sweep

**Future evolution**: 如果未来有更多测试类型需要类似格式，可以考虑将格式化逻辑提取为通用函数
**Related scenarios**: 其他测试类型的结果显示目前不需要修改
**Failure/edge cases**: 响应时间为0或负数的情况已由`formatDuration`处理

## Out of Scope

* 修改其他测试类型的结果显示
* 添加响应时间的动画效果
* 修改`addInlineInfo`函数的通用实现（只修改智商测试特定部分）

## Decision (ADR-lite)

**Context**: 需要将响应时间另起一行并用橙色突出显示
**Decision**: 修改`addIqTestReference`函数，使用HTML格式，添加`<br>`换行和`<span class="duration-highlight">`标签，CSS类定义橙色
**Consequences**: 需要添加CSS类，但保持代码清晰和可维护性

## Technical Notes

* 关键文件：assets/js/script.js
* 关键函数：`addIqTestReference`、`addInlineInfo`、`formatDuration`
* 需要考虑HTML注入安全性
* 可能需要添加CSS样式类