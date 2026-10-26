# 集成 LM Fingerpoint Detector 模型指纹检测

## Goal

在当前纯前端 API 测试页中新增「模型指纹」检测：用同一组无语义整数任务对目标 API 采样三次，在浏览器本地与内置参考库比对，展示候选模型排名与闭集置信度。所有 API Key、请求内容和评分均在浏览器本地处理。

## Background

已确认的事实（基于当前仓库与 `Ikaleio/lm-detector` 上游源码）：

- 当前项目是纯前端静态页：`index.html` + `assets/js/script.js`（约 5000 行）+ `assets/css/styles.css`，无构建步骤，部署到 GitHub Pages。
- 现有厂商入口：OpenAI（Chat Completions / Responses）、Anthropic、Google（Gemini 原生）、Images。配置存 LocalStorage，已有流式、思考等级、模型列表、HTTPS 代理等能力。
- 上游项目 MIT 许可，本项目 GPL-3.0，MIT 代码可并入 GPL，需保留上游版权声明。
- 上游网页检测是浏览器本地计算：核心为 `shared-detector.ts`、`positional.ts`、`fingerprint-core.js`，无 Node 运行时依赖、无 WASM。
- 检测需要三次独立采样，每次约 300 个 1–355 的整数；每条至少 80 个有效数字；三条齐全才给闭集置信度，1–2 条只给 partial ranking。
- 参考库当前 63 个模型，构建时间 2026-10-25；`shared_detector.bin` 4.6 MB（gzip 3.78 MB）。
- `unified_bank.json`（12.7 MB）中的计数数据不参与浏览器评分，评分和展示只需要模型 id/display_name/family/family_name/response_count 等元数据，可裁成几十 KB。
- 本机实测三样本评分约 130 ms（Node，使用上游真实数据）。

## Requirements

- **R1 独立入口**：在现有「测试内容」区域新增「模型指纹」入口和专用面板，不改变现有单轮测试流程。
- **R2 复用配置**：复用现有 API URL、API Key、模型、流式开关和代理设置；指纹面板内提供 OpenAI Chat Completions / OpenAI Responses / Anthropic 三种格式选择，不依赖当前厂商 tab 的协议状态；不新增凭据存储位置。
- **R3 三次采样**：用上游挑战生成器生成三条独立提示词，分别请求目标 API；支持并行/串行、单条取消/重试、整体取消；记录每条请求的耗时和状态。
- **R4 响应解析**：支持现有 OpenAI Chat、OpenAI Responses、Anthropic 的流式与非流式响应，提取文本并解析 1–355 的有效整数；每条至少 80 个有效数字，不足时标记未采用。
- **R5 本地评分**：在浏览器内使用内置检测器数据评分，输出预测模型、模型家族、Top N 候选、闭集概率、排名分数、每条样本诊断和序列形态；支持「不像语言模型回答」分支。
- **R6 结果表达**：明确展示「参考库内闭集排序，不是身份证明」；显示参考库 `built_at`、模型数量和评分方法；概率与 partial 结果不得混淆。
- **R7 手动粘贴评分**：提供不调用 API 的备用入口，允许粘贴三条回答后本地评分，便于 CORS 受限或已在别处采样的场景（默认包含，成本低）。
- **R8 数据加载**：检测器数据只在进入「模型指纹」面板时懒加载，显示下载进度，失败可重试；首次加载后缓存，避免每次进入重复下载。
- **R9 归属与合规**：README 增加上游来源、MIT 许可与致谢；UI 内提供上游项目链接；保留上游版权声明；记录参考数据版本和同步方式。
- **R10 隐私**：不引入服务端评分、不上传 API Key 或回答内容、不接入第三方统计；错误信息中的 Key 必须脱敏。
- **R11 数据托管**：检测器数据以固定快照提交进本仓库（`assets/data/lmfpd/`），随 GitHub Pages 发布；上线后不依赖上游站点运行时可用性。

## Non-goals

- Gemini 原生协议的模型指纹检测（第二阶段）。
- 分词器探测（tokenizer probe，第二阶段）。
- 参考库浏览、样本导出、结果图片导出（第二阶段）。
- 部署评分后端或 Cloudflare Worker 评分服务。
- 无人工审查的参考数据自动更新。

## Acceptance Criteria

- [x] **AC1** 打开页面时网络面板不请求检测器数据；进入「模型指纹」后才开始加载，并显示进度。
- [x] **AC2** 使用 OpenAI Chat Completions、OpenAI Responses、Anthropic 三种格式各能完成三次采样，单条失败不会丢失其他已成功样本。
- [x] **AC3** 三条有效回答时显示预测模型、家族、Top 5、闭集概率；只有 1–2 条时显示 partial ranking 且明确标注「置信度不可用」。
- [x] **AC4** 输入排序/规则化数字时命中「不像语言模型回答」分支，不输出误导性排名。
- [x] **AC5** 手动粘贴三条回答的评分结果与上游 conformance 用例的预期预测一致（至少覆盖 `scored-claude-opus-4.8`、`partial-two`、`not-model-sorted`）。
- [x] **AC6** 结果区显示参考库构建时间和模型数量，并包含「闭集排序，不是身份证明」的固定说明。
- [x] **AC7** 页面仍可纯静态部署；不新增构建步骤；现有测试场景回归通过。
- [x] **AC8** API Key 不出现在页面文本、控制台日志或导出的结果中。
- [x] **AC9** README 与 UI 均包含上游 MIT 归属信息，`LICENSE` 兼容性说明清晰。

## Verification

证据与命令见 `verification.md`。摘要：

- `node scripts/sync-lmfpd.mjs --verify-only`：42/42 checks passed（含 12 条上游 conformance）。
- Playwright 端到端：44 项检查通过（三种格式、partial、not_model、手动粘贴、缓存、错误路径、现有厂商回归、Key 不泄露）。
- 并发补充测试：并行采样中单条停止/重试、整体停止均通过，不再卡在未评分状态。
- 375px / 1280px 布局测量：候选概率列、统计卡长值、诊断表均无横向溢出。

## Notes

- 参考库是封闭集合；库外模型也会得到「最像」的候选，UI 不得把排名表述为身份证明。
- 上游数据会继续更新；首版采用固定快照，并提供手动同步脚本/步骤。
- 手动粘贴评分与 API 自动采样共用同一套挑战、解析和评分逻辑，避免两条路径结果不一致。
