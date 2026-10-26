# Upstream contract notes: Ikaleio/lm-detector

调查对象：`https://github.com/Ikaleio/lm-detector`，本地只读快照 `/tmp/opencode/lm-detector`，commit `1e58ed83c1cde17f88cba89560ad4d083042ae92`（2026-10-26）。

## 1. 许可与形态

- 许可证：MIT，版权行 `Copyright (c) 2026 xqy2006`（`LICENSE`）。
- 入口：网页、CLI（`fpd`）、SDK（TS/Rust/Go/Python）。
- 网页检测完全在浏览器内评分；上游网页把静态数据放在 `web/public/data/`，由 `web/scripts/sync-data.ts` 生成。
- 参考库数据是封闭集合；README 明确说明“不在库中的模型也会得到一个‘最像’的候选，排名分数和置信度都不是身份证明”。

## 2. 检测流程

- 提示词：`shared/challenge-browser.js:195` `generateChallenges(count, usedLengths)`。
  - 每条题目随机选择语言（zh/en/ja/ko/fr），随机开头、动作、结尾、分隔符。
  - 数字范围 1–355；每条期望数量在 292–332 之间，且三条长度互不重复。
  - 要求模型直接输出，不调用工具、不排序/去重。
- 采样：`shared/detection.ts` `testApi`，三条挑战可并行或串行。
- 有效样本：`parseNumbers` 取最长一段 1–355 数字；每条至少 `max(80, ceil(expected_count * 0.55))` 个数字。
- 评分：`shared/shared-detector.ts:123` `analyzeSharedOutputs(outputs, bank, detector, options)`。
  - 0 条有效：`decision=unscorable`。
  - 1–2 条且 `allowPartial`：`decision=partial`，给排名，`probability=null`。
  - 3 条有效：`decision=scored`，给闭集概率。
  - 序列形态异常（排序/规则化）：`decision=not_model`，不输出排名。
- 评分方法：`shared-detector-v2`，频率特征 + 位置特征 + LDA + kNN 参考距离 + 校准温度。

## 3. 数据格式

- `data/shared_detector.bin`：4,597,032 bytes。
  - `detector-codec.ts:36` `decodeDetector`：前 4 字节 little-endian header 长度，随后 UTF-8 JSON header，4 字节对齐，随后按位置分组的 float32 数据。
  - header 中每个数字数组表示为 `{"$f32": offset, "n": length}`。
- `data/unified_bank.json`：12,732,981 bytes。
  - 顶层：`schema`、`built_at`、`method`、`recommended_queries`、`minimum_valid_numbers`、`providers`、`sources`、`models`、`robust`、`calibration`、`reference_sha256`。
  - `models` 当前 63 个，每个含 `id`、`display_name`、`family`、`family_name`、`response_count`、`counts`、`sources`、`conditions` 等。
  - 浏览器评分只需要元数据；`counts` 等计数矩阵不参与 `analyzeSharedOutputs`。
- `data/unified_reference.jsonl`：17,265,061 bytes，用于参考库浏览/导出，检测不需要。
- `data/tokenizer_bank.json`：78,722 bytes，用于可选分词器探测，首版不需要。

压缩参考（gzip -9，用于估算）：

| 文件 | 原始 | gzip |
| --- | --- | --- |
| `shared_detector.bin` | 4,597,032 | 3,779,783 |
| `unified_bank.json` | 12,732,981 | 750,531 |
| `unified_reference.jsonl` | 17,265,061 | 1,999,334 |
| `tokenizer_bank.json` | 78,722 | 18,396 |

## 4. 浏览器评分依赖

`analyzeSharedOutputs` 的浏览器依赖链：

```text
shared-detector.ts
  ├─ fingerprint-core.js   (纯 JS)
  ├─ positional.ts         (纯 JS)
  └─ types.ts              (仅类型)
detector-codec.ts          (TextEncoder/TextDecoder/DataView/Float32Array)
challenge-browser.js       (crypto.getRandomValues / crypto.randomUUID)
```

`ml-matrix` 只在 `shared/builder.ts`（训练/构建）使用，评分路径不依赖它。

## 5. 上游 conformance 用例

文件：`sdk/conformance/analyze.json`（不发布到本仓库站点，只用于校验）。

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| `scored-claude-haiku-4.5` | 3 条完整回答 | `decision=scored`，预测 `claude-haiku-4.5` |
| `scored-claude-opus-4.8` | 3 条完整回答 | `decision=scored`，预测 `claude-opus-4.8` |
| `partial-two` | 2 条完整回答 | `decision=partial`，`probability=null` |
| `partial-one` | 1 条完整回答 | `decision=partial`，`probability=null` |
| `truncated` | 3 条，每条 100 个数字 | `decision=scored`，`used_outputs=3` |
| `strict-two` | 2 条完整回答 | `allowPartial=false` 时 `unscorable` |
| `unscorable-short` | 3 条无有效数字 | `decision=unscorable` |
| `not-model-sorted` | 3 条排序数字 | `decision=not_model`，`results=[]` |

本机用 Node + `tsx` 对 `scored-claude-opus-4.8` 评分耗时约 130 ms，预测正确。

## 6. 网页端集成参考

- `web/src/lib/client.ts`：
  - `generateChallenges` 来自 `shared/challenge-browser.js`。
  - `analyze` 优先用 `fingerprint.worker.ts`，失败时回退到主线程 `analyzeSharedOutputs`。
  - 手动模式也使用生成的 3 条挑战，用户把回答粘贴到样本卡，`expected_count` 来自挑战。
- `web/src/lib/detector.ts`：
  - 每个页面只下载一次 detector；`decodeDetector` 后共享。
  - 下载失败会清空 `loading`，下一次调用重试。
- `web/src/lib/static-data.ts`：
  - 读取 `manifest.json`，按 chunk 流式下载，使用 `fzstd` 解压。
  - 本集成不需要 chunk/manifest：直接提交单个 bin，避免引入 zstd 解压依赖。

## 7. 对本项目的直接影响

1. 需要打包 `shared-detector.ts`、`positional.ts`、`fingerprint-core.js`、`detector-codec.ts`、`challenge-browser.js`，输出 IIFE。
2. 需要从 `unified_bank.json` 生成 slim `models.json`，保留 `built_at`、`id`、`display_name`、`family`、`family_name`、`response_count`，顺序必须与 detector 的 `model_ids` 一致。
3. 需要固定上游 commit 和 `built_at`，并在 UI 展示；数据更新必须重新跑同步脚本和 conformance 校验。
4. 首版只支持 OpenAI Chat/Responses、Anthropic；Gemini 原生协议和分词器探测留到第二阶段。
