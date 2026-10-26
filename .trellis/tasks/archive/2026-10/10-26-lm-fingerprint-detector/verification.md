# Verification: LM Fingerpoint Detector integration

日期：2026-10-26
上游快照：`Ikaleio/lm-detector@1e58ed83c1cde17f88cba89560ad4d083042ae92`
参考库：63 个模型，`built_at=2026-10-25T10:04:10.682171+00:00`

## 1. 算法与数据一致性

命令：

```bash
node scripts/sync-lmfpd.mjs --verify-only
```

结果：**42/42 checks passed**

覆盖：

- bundle 导出 `generateChallenges` / `parseNumbers` / `decodeDetector` / `analyzeSharedOutputs`
- detector schema / size / hash
- `models.json` 与 detector 的 `built_at`、模型数、id 顺序、`response_count`
- `supportsSharedDetector`
- LICENSE 与 MIT 版权行
- 12 条上游 conformance 用例
- 任务要求的 6 条断言（scored / partial / unscorable / not_model / truncated / strict-two）

关键结果：

| 用例 | 结果 |
| --- | --- |
| `scored-claude-opus-4.8` | `scored`，`claude-opus-4.8`，`probability=0.999763` |
| `partial-two` | `partial`，`claude-haiku-4.5`，`probability=null` |
| `unscorable-short` | `unscorable`，`results=[]` |
| `not-model-sorted` | `not_model`，`results=[]` |
| `truncated` | `scored`，`used_outputs=3` |
| `strict-two` | `allowPartial=false` → `unscorable` |

## 2. 端到端（本地静态页 + mock API）

环境：

- 静态页：`python3 -m http.server 4173 --bind 127.0.0.1`
- Mock API：`/tmp/opencode/lmfpd-mock.cjs`，返回上游 conformance 样本的 SSE / JSON
- Playwright：`/tmp/opencode/lmfpd-e2e.cjs`

结果：**44 项检查全部通过**

覆盖：

- 首屏不请求 `shared_detector.bin`，指纹面板隐藏
- 进入指纹页后才加载 `lmfpd-core.js` / `VERSION.json` / `models.json` / `shared_detector.bin`
- 显示 63 个模型与 `built_at`
- Chat Completions / Responses / Anthropic 三种格式各完成三次采样，Top 1 = `claude-opus-4.8`
- 三条有效样本显示闭集概率
- 手动模式：`partial-two` → 预测 `claude-haiku-4.5`，概率显示 `—` 且标注「置信度不可用」
- 手动模式：`not-model-sorted` → 「不像语言模型回答」，无候选排名
- 手动模式：`scored-claude-opus-4.8` → 预测正确，Top 5 + 其余候选可展开
- 页面文本不含测试 API Key；console/pageerror 为空
- 切回 OpenAI / Anthropic / Google / Images，原有测试按钮正常渲染，指纹面板隐藏
- 刷新后使用 IndexedDB 缓存，不重复下载 detector
- 连接失败时显示可读错误，且 Key 不泄露

## 2.1 数据失败与版本不匹配

命令：

```bash
node /tmp/opencode/lmfpd-data-errors.cjs
```

结果：**6 项检查通过**

- 首屏不请求 `lmfpd-core.js` / `VERSION.json` / `models.json` / `shared_detector.bin`
- `shared_detector.bin` 下载失败时显示「参考数据加载失败」和「重试」
- 解除拦截后点击「重试」可恢复就绪
- `models.json` 的 `built_at` 与 detector 不一致时显示可读的版本错误
- 错误场景页面文本不含 API Key

## 3. 并发与单样本操作

命令：

```bash
node /tmp/opencode/lmfpd-concurrency.cjs
```

慢速 mock：`/tmp/opencode/lmfpd-mock-slow.cjs`（每 60 字符 sleep 40ms）

结果：**全部通过**

- 三条并行流式中停止样本 1：其余两条完成，最终 `评分完成（部分样本）`，预测 `claude-opus-4.8`，不卡在请求中
- 三条并行流式中重试样本 1：三条最终 `完成`，`评分完成`
- 整体停止：三条均 `已停止`，stop 按钮禁用，不会重新进入请求中

## 4. 布局与移动端

Playwright 测量：

- 375px：`#fingerprintResult` 291/291，无横向溢出
- 375px：`.fingerprint-candidate` 291/291，概率列 68/68
- 375px：`.fingerprint-stat-value` 全部 `scrollWidth == clientWidth`（长 `built_at` 换行）
- 375px：诊断表 289/289
- 1280px：`#fingerprintResult` 1102/1102，无横向溢出
- 页面 `documentElement` 无横向溢出

截图（临时，未提交）：

- `/tmp/opencode/shots/e2e-desktop.png`
- `/tmp/opencode/shots/e2e-mobile.png`
- `/tmp/opencode/shots/fix-candidate-mobile.png`
- `/tmp/opencode/shots/fix-stat-mobile.png`

## 5. 语法与文件检查

```bash
node --check assets/js/fingerprint.js
node --check assets/js/script.js
node --check scripts/sync-lmfpd.mjs
```

全部通过。

数据：

```text
assets/data/lmfpd/shared_detector.bin  4,597,032 bytes
assets/data/lmfpd/models.json          10,566 bytes (63 models)
assets/data/lmfpd/VERSION.json         369 bytes
assets/vendor/lmfpd/lmfpd-core.js      38,489 bytes
assets/vendor/lmfpd/LICENSE            1,064 bytes
scripts/sync-lmfpd.mjs                 23,274 bytes
```

## 6. 未覆盖 / 限制

- **未使用真实付费模型 API 做验收**：端到端使用上游 conformance 输出和本地 mock，避免产生费用；真实渠道的 CORS、限流、截断行为仍需实际检测时观察。
- **数据是固定快照**：新模型或上游数据更新后，需要重新运行同步脚本并复跑 conformance。
- **Gemini 原生协议、分词器探测、参考库浏览** 按 PRD 不在首版范围。
- **未提交 Git**：等待用户确认后再提交。

## 7. AC 映射

| AC | 证据 |
| --- | --- |
| AC1 | E2E 首屏无 detector 请求；面板默认 hidden |
| AC2 | E2E 三种格式 3/3 样本完成；并发测试覆盖单条停止/重试 |
| AC3 | E2E scored / partial；partial 概率为 `—` 且标注「置信度不可用」 |
| AC4 | E2E not-model-sorted 无排名 |
| AC5 | `--verify-only` 42/42；E2E 手动模式三种用例 |
| AC6 | E2E 显示 `built_at` / 63 个模型；静态 caveat 文本 |
| AC7 | 纯静态部署；无构建步骤；现有厂商按钮 smoke 通过 |
| AC8 | E2E 页面文本与错误场景不含 Key；console 为空 |
| AC9 | README、UI 归因链接、`assets/vendor/lmfpd/LICENSE` |
