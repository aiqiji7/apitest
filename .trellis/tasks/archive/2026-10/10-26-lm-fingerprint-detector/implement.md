# 执行计划：集成 LM Fingerpoint Detector 模型指纹检测

## 0. 前置检查

- [ ] `git status` 干净；记录当前分支与 HEAD。
- [ ] 确认 Node.js ≥ 22、`npx esbuild` 可用、Playwright 浏览器可用（本机已有 `~/.cache/ms-playwright`）。
- [ ] 只读确认上游固定 commit：`1e58ed83c1cde17f88cba89560ad4d083042ae92`。
- [ ] 不创建提交，除非用户明确要求；所有回滚依赖 Git 工作区。

## 1. 数据与核心 bundle（Lane A，新文件）

负责人：`@fixer`。只新增文件，不改现有页面。

- [ ] 新增 `scripts/sync-lmfpd.mjs`：
  - 参数：`--ref <commit>`、`--verify-only`、`--upstream <local-path>`（可选，便于无网调试）。
  - 从 GitHub raw 下载固定版本的上游源码、`shared_detector.bin`、`unified_bank.json`、`analyze.json`、`LICENSE` 到临时目录。
  - 生成 `assets/vendor/lmfpd/lmfpd-core.js`（esbuild IIFE，`window.LMFPD`，保留 MIT banner）。
  - 生成 `assets/data/lmfpd/models.json`（只保留 `schema`、`built_at`、`models[].{id,display_name,family,family_name,response_count}`）。
  - 复制 `assets/data/lmfpd/shared_detector.bin`。
  - 写入 `assets/data/lmfpd/VERSION.json`（upstream ref、built_at、detector/models sha256、license）。
  - 复制 `assets/vendor/lmfpd/LICENSE`。
  - 自检：解码 detector，校验 `built_at` / 模型数量 / id / response_count，再跑 conformance 用例；失败不写最终文件。
- [ ] 运行 `node scripts/sync-lmfpd.mjs --ref 1e58ed83c1cde17f88cba89560ad4d083042ae92`。
- [ ] 确认生成物：
  - `lmfpd-core.js` 暴露 `generateChallenges`、`parseNumbers`、`decodeDetector`、`analyzeSharedOutputs`。
  - `models.json` 模型顺序与 detector 的 `model_ids` 完全一致。
  - `shared_detector.bin` 大小 4,597,032 bytes。
  - `VERSION.json` 中 `built_at` 与 `models.json` 一致。

验证：

```bash
node scripts/sync-lmfpd.mjs --verify-only
node --input-type=module -e "/* 或者运行脚本内置校验，确认 5 个 conformance 用例通过 */"
```

门禁 G1：conformance 全部通过；若失败，停在 Lane A，不进入 UI。

## 2. UI 骨架（Lane B）

负责人：`@designer`。只改 `index.html`、`assets/css/styles.css`，不写业务逻辑。

- [ ] 在 `#vendorType`（`index.html:106` 附近）增加「模型指纹」按钮。
- [ ] 在现有测试区增加 `#fingerprintPanel`，包含设计文档 8.2 的结构；默认 `hidden`。
- [ ] 用 `body.fingerprint-mode` 控制现有单轮控件隐藏，不影响现有厂商页面。
- [ ] 样式复用现有 CSS 变量与 `.btn`、`.seg-btn`、`.input-group` 等类；新增类统一 `.fingerprint-*` 前缀。
- [ ] 移动端 375px 与桌面 1280px 截图自检；结果卡、样本卡、警告状态不得拥挤或丢失层级。
- [ ] 不引入新字体、新图标库或外部资源。

门禁 G2：设计稿截图通过；DOM id/class 与 `design.md` 一致，交给 Lane C。

## 3. 桥接与指纹逻辑（Lane C）

负责人：`@fixer`。依赖 G1/G2 完成。

### 3.1 `script.js` 最小改动

- [ ] `renderTestButtons('fingerprint')` 清空 `#testType`，不设置默认输入。
- [ ] `setActiveVendor`：
  - 切换 `body.fingerprint-mode`。
  - 派发 `apitest:vendor-change` 事件。
  - fingerprint 模式下不渲染 OpenAI 协议开关。
- [ ] `#testBtn` 点击处理在 fingerprint 模式直接返回。
- [ ] 在 IIFE 结束前暴露窄 bridge：

  ```js
  window.APITestBridge = {
    getRequestContext() { /* apiUrl/apiKey/model/stream/proxyUrl */ },
    buildEndpoint, buildResponsesEndpoint, buildAnthropicEndpoint,
    fetchAndStream, sanitizeSensitiveText
  };
  ```

- [ ] 不改现有 `fetchAndStream` 的错误语义；不复制代理判断。
- [ ] `git diff assets/js/script.js` 只包含上述最小改动。

### 3.2 `assets/js/fingerprint.js`

- [ ] 数据加载：动态注入 `lmfpd-core.js`；`models.json` + IndexedDB 缓存 `shared_detector.bin`；显示进度/错误/重试。
- [ ] 模式：API / 手动；格式选择：Chat Completions / Responses / Anthropic；并行开关；流式开关。
- [ ] 三条挑战：`LMFPD.generateChallenges(3)`；重试单条时传入其它两条的 `expected_count` 作为 `usedLengths`。
- [ ] 请求：按 `design.md` 6.1 构造 body/header/endpoint；复用 `APITestBridge.fetchAndStream`。
- [ ] 文本提取：流式用 `result.text`；非流式按 Chat/Responses/Anthropic 提取；统一 `LMFPD.parseNumbers`。
- [ ] 状态机：`idle → sampling → scoring → result`；每样本独立取消/重试；整体停止。
- [ ] 评分：`analyzeSharedOutputs(outputs, models, detector, {allowPartial:true})`；0/1–2/3 条分别渲染 unscorable/partial/scored；`not_model` 不显示排名。
- [ ] 结果：Top 5 + 可展开其余；概率条；诊断；序列形态；闭集警告；`built_at` 与模型数。
- [ ] 手动模式：展示三条题目 + textarea；评分走同一函数。
- [ ] 所有错误先脱敏；不写 localStorage/console。
- [ ] 切回其它厂商时中止运行中的请求，但保留结果；再次进入不重复下载数据。

### 3.3 `index.html` 脚本顺序

- [ ] `fingerprint.js` 在 `script.js` 之后加载（classic script）。
- [ ] `lmfpd-core.js` 不在首屏加载，由 `fingerprint.js` 动态注入。

门禁 G3：本地 mock API 端到端通过；现有厂商 smoke 通过。

## 4. 文档与归属（Lane D）

- [ ] README 增加「模型指纹检测」小节：功能、三次采样、闭集限制、数据版本、上游链接、MIT 许可。
- [ ] 确认 `assets/vendor/lmfpd/LICENSE`、bundle banner、UI 归因链接都存在。
- [ ] 记录同步命令与 `--ref` 固定版本。
- [ ] 不新增无关文档。

## 5. 验证（Lane E）

### 5.1 算法

```bash
node scripts/sync-lmfpd.mjs --verify-only
```

必须覆盖 `scored-claude-opus-4.8`、`partial-two`、`unscorable-short`、`not-model-sorted`、`truncated`。

### 5.2 端到端

- [ ] 启动静态服务器：

  ```bash
  python3 -m http.server 4173
  ```

- [ ] 启动临时 mock API（只放 `/tmp`，不提交）：
  - Chat SSE：`choices[0].delta.content`
  - Responses SSE：`response.output_text.delta`
  - Anthropic SSE：`content_block_delta`
- [ ] Playwright 脚本断言：
  1. 首屏无 `shared_detector.bin` 请求。
  2. 进入指纹页后数据加载完成。
  3. 三种格式各完成三次采样，Top 1 = `claude-opus-4.8`。
  4. 两条有效 → partial，概率列为空。
  5. 排序数字 → `not_model`，无排名。
  6. 手动粘贴 → 与 API 模式一致。
  7. 结果包含闭集提示和 `built_at`。
  8. 切回 OpenAI/Anthropic/Google/Images，原有测试按钮正常渲染。
- [ ] 移动端 375px 截图；桌面 1280px 截图。
- [ ] 检查页面文本、console、网络请求中无 API Key。

### 5.3 最终检查

- [ ] `git status` 只包含预期文件。
- [ ] `git diff --stat` 中 `script.js` 改动行数在预期范围（约 30–60 行）。
- [ ] 没有新增构建依赖到运行路径；`scripts/sync-lmfpd.mjs` 不影响站点加载。
- [ ] 失败场景：数据 404、IndexedDB 禁用、单条请求 500、整体取消，都有可读提示。

## 6. 回滚点

| 阶段 | 回滚方式 |
| --- | --- |
| Lane A 后 | 删除 `assets/vendor/lmfpd/`、`assets/data/lmfpd/`、`scripts/sync-lmfpd.mjs` |
| Lane B 后 | 还原 `index.html`、`assets/css/styles.css` 对应 diff |
| Lane C 后 | 还原 `script.js` bridge 段，删除 `fingerprint.js` 与脚本标签 |
| 全量 | `git restore` 相关文件（需用户确认后再执行破坏性命令） |

## 7. 风险文件

- `assets/js/script.js`：5000 行 IIFE，改动必须最小；每次改动后跑现有 smoke。
- `index.html`：脚本顺序错误会导致 `APITestBridge` 未定义。
- `assets/css/styles.css`：新增样式必须限定在 `.fingerprint-*` 与 `body.fingerprint-mode`，避免污染现有页面。
- `assets/data/lmfpd/shared_detector.bin`：二进制文件，禁止手工编辑；只能由同步脚本生成。

## 8. 完成定义

- PRD 的 AC1–AC9 全部有对应验证证据。
- 设计文档中的错误/partial/not_model/加载失败状态均已实现。
- 用户完成最终人工验收或明确接受。
