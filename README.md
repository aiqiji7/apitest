<h1 align="center">AI API 特殊调用测试</h1>

<p align="center">纯前端的多厂商 API 调用测试页面，用来测试 OpenAI/Anthropic/Google 等 API 的特殊调用方式（工具调用、搜索、URL 上下文等）。所有数据仅在浏览器本地处理与保存。</p>

> 来源：本项目基于 [CookSleep/newapi-special-test](https://github.com/CookSleep/newapi-special-test)（GPL-3.0）二次开发，感谢原作者的开源贡献。

## 功能特性

- **纯前端与本地存储：**
  - 所有配置保存在浏览器 LocalStorage 中
  - 不上传数据到第三方服务器，安全可控
- **多厂商与多场景测试：**
  - **OpenAI:** 工具调用（Chat Completions/Responses）、搜索（Responses）
  - **Anthropic:** 工具调用
  - **Google Gemini:** 工具调用、搜索、URL 上下文
  - **模型指纹:** OpenAI Chat Completions / Responses、Anthropic、Google Gemini，支持 API 自动采样与手动粘贴评分
- **配置管理与一键默认：**
  - 通过“管理配置”弹窗新增/编辑/删除配置
  - 支持星标“默认配置”，页面加载自动应用
  - **安全性：** 支持 API Key 显隐切换，配置仅保存在本地 LocalStorage
- **交互与可视化：**
  - 分厂商切换测试类型，自动填充默认测试输入
  - 左侧“轮次与消息”时间线，右侧“请求与响应”代码块
  - 支持一键复制请求/响应内容
- **健壮的错误处理：**
  - 自动识别并提示错误的 API URL（如返回 HTML）
  - 支持非 JSON 响应的原始预览
  - 实时显示请求状态与耗时统计

## 如何使用

1. **直接打开页面：**
   - 用浏览器打开 https://aiqiji7.github.io/apitest
2. **填写 API 信息：**
   - 在“API 配置”中填写 `API URL`、`API Key`、`模型`，或点击“管理配置”从右侧列表选择并应用。
3. **选择测试类型：**
   - 首先在“测试内容”中选择厂商（OpenAI / Anthropic / Google / Images）。
   - 然后选择具体的测试场景（如工具调用、搜索等）。页面会自动填充推荐的测试消息。
   - 如需模型指纹检测，在所选模型厂商下选择「模型指纹」场景；OpenAI 使用页面上的 Chat Completions / Responses 切换。点击「开始检测」自动采样，或切换到「手动粘贴」粘贴三条回答后点击「评分」。
4. **输入用户消息并发送：**
   - 普通测试在文本框输入用户消息，点击“运行测试”。模型指纹场景不需要输入用户消息，使用「开始检测」或「评分」。
5. **查看结果：**
   - 左侧查看“轮次与消息”，右侧查看“请求与响应”。每个代码块都支持复制。

> 小贴士：该页面为纯前端网页，所有信息仅存储在您的浏览器本地。

## 模型指纹检测

「模型指纹」入口会把同一组无语义整数任务发送给目标 API 三次，并在浏览器本地与内置参考库比对，给出最相似的候选模型与闭集置信度。

- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini；在对应厂商下选择「模型指纹」即可，也可以切换到「手动粘贴」评分。
- 每条回答至少需要 80 个 1–355 的有效整数；三条齐全才显示置信度，1–2 条只显示 partial ranking。
- **结果只是参考库内的闭集排序，不是模型身份证明。** 库外模型也会得到“最像”的候选。
- 当前参考库的模型数、构建时间和完整上游 commit 见 [VERSION.json](assets/data/lmfpd/VERSION.json)；页面也会显示实际加载的模型数和构建时间。
- 算法与参考数据只在进入「模型指纹」时懒加载，下载大小随参考库增长。页面先获取版本清单，再按摘要加载核心与数据，用 SRI 校验核心、Web Crypto SHA-256 校验数据；请通过 HTTPS 或 localhost 访问。
- 检测器按构建时间和摘要缓存到 IndexedDB，命中缓存后仍校验字节；存储不可用时使用内存。单页固定已取得的快照，部署新版本后刷新页面即可获取，评分过程中不会切换版本。
- 评分完全在浏览器本地完成；采样请求会直接发送到你配置的 API，不会上传到本项目以外的评分服务。

### 参考库自动更新（维护者）

将相关改动提交并推送到默认分支 `main` 后，Actions 中的 **Sync LMFPD snapshot** 每天按 `17 3 * * *`（UTC 03:17，北京时间 11:17）检查上游，也可在该工作流选择 **Run workflow** 手动运行。启用全自动更新需确认：

- 仓库已启用 GitHub Actions，允许同步 job 使用 `contents: write`（仓库 Settings → Actions → General 的 Workflow permissions，以及组织策略需允许）。
- `main` 分支规则允许 `github-actions[bot]` 正常快进推送；脚本使用普通 push，不会绕过分支保护。
- Settings → Pages → Source 选择 **GitHub Actions**；若希望部署也全自动，`github-pages` 环境需允许来自 `main` 的部署，且不要求人工审批。

流程只使用仓库自带的 `GITHUB_TOKEN` 和 Pages OIDC，无需个人 PAT 或额外个人密钥。候选算法、数据、MIT 许可和完整 conformance 验收样例必须来自同一完整上游 SHA；全部校验通过后，机器人仅提交五个指纹产物，并显式调用 **Deploy static content to Pages** 部署精确提交。这样也能处理 `GITHUB_TOKEN` 提交不会再次触发 push 工作流的情况。

网络、上游样例与数据不配套或其他校验失败时，同步流程不会提交或部署候选，当前站点保留原快照。到 Actions 查看失败步骤日志和运行摘要；其他正常 `main` 提交的部署仍照常执行。五个产物字节均无变化时不创建空提交，但仍会部署已验证的当前快照，以恢复前次部署失败；若校验期间 `main` 已前进，本轮跳过，等待下次定时运行或手动重跑。

GitHub 定时任务可能延迟，不能保证准点；公开仓库连续 60 天无活动时，定时工作流会被停用，需重新启用。参见官方说明：[定时事件限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[GITHUB_TOKEN 的触发限制](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow)、[Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

### 本地同步与回滚

维护脚本使用 Node.js 24、Git 和 npx（打包器固定为 `esbuild@0.28.2`），暂存父目录 `/tmp/opencode` 需已存在。以下前两条命令校验通过后会更新本地五个产物；将 `FULL_UPSTREAM_SHA` 替换为 40 位完整上游 SHA。省略 `--latest` / `--ref` 时，默认重建当前 VERSION 中的上游版本。

```bash
node scripts/sync-lmfpd.mjs --latest
node scripts/sync-lmfpd.mjs --ref FULL_UPSTREAM_SHA
node scripts/sync-lmfpd.mjs --verify-only
```

如需先检查隔离候选，使用下列命令。输出目录必须是新目录或空目录，结果文件必须尚不存在且位于输出目录之外；`changed` 比较全部五个产物的字节。

```bash
node scripts/sync-lmfpd.mjs --latest --artifact-root /tmp/opencode/lmfpd-candidate --result-file /tmp/opencode/lmfpd-result.json
node scripts/sync-lmfpd.mjs --verify-only --artifact-root /tmp/opencode/lmfpd-candidate
```

`--verify-only` 只验证，不发布；默认获取清单 SHA 对应的上游验收样例。`--ref FULL_UPSTREAM_SHA --upstream LOCAL_CHECKOUT` 可从本地上游仓库读取该 SHA 的不可变 Git 对象，工作区改动不会混入；`--conformance FILE` 仅供受控离线样例验证，自动工作流不使用此覆盖项。不得修改 expected 或跳过配套校验来放行候选。

需要回滚时，先在 Actions 暂停 **Sync LMFPD snapshot**，再通过普通 `git revert` 或正常恢复提交，将核心、检测器、模型元数据、VERSION 和 LICENSE 五个文件作为配套整体恢复到已验证版本。通过正常 `main` 推送，或手动运行 **Deploy static content to Pages** 重新部署；确认稳定后再启用同步。五个文件的精确路径与校验契约见 [自动同步规范](.trellis/spec/backend/lmfpd-auto-sync.md)。

检测算法与参考数据来自 [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector)（MIT），版权归原作者所有。

## 修改默认系统配置

如需预置默认的 API URL、API Key、模型，可编辑 `assets/js/config.js` 中的 `window.APP_CONFIG`（部署到静态服务器时也可以按需修改）：

```js
window.APP_CONFIG = {
  apiUrl: 'https://api.openai.com',
  apiKey: '',
  model: 'gemini-3-flash-preview'
};
```

- 该文件在页面加载时先于主脚本注入，主脚本会读取 `window.APP_CONFIG` 作为系统默认。
- 不建议在公共仓库提交真实的 API Key，可保持为空，使用时手动填写或通过“管理配置”保存到本地。

## 部署

- 本项目为静态页面，可直接托管至任意静态托管平台（GitHub Pages、Netlify、Vercel、Nginx 等）。
- 如需覆盖默认配置，直接修改 `assets/js/config.js` 并重新部署即可。

## 来源与致谢

本项目是基于 [CookSleep/newapi-special-test](https://github.com/CookSleep/newapi-special-test)（GPL-3.0）的二次开发（fork），感谢原作者的开源贡献。本项目继续采用原项目的 [GPL v3.0](LICENSE) 许可证。

模型指纹检测的算法与参考数据来自 [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector)，采用 MIT 许可，版权归原作者所有；本项目仅做浏览器端集成与数据快照，相关许可文本见 `assets/vendor/lmfpd/LICENSE`。

相对原项目，主要新增/修改如下：

- 新增 **Images** 厂商测试（文生图、图生图）及生成图片预览
- 各厂商（OpenAI/Anthropic/Google）新增**图片识别**测试场景
- 新增**模型智商测试**与 **Juice 值测试**（OpenAI）场景
- 新增**模型列表自动获取**（带缓存）与**最近连接**历史
- 新增 **HTTPS 代理**配置（便于在 HTTPS 页面访问 HTTP 端点）
- 新增**思考等级**与**流式/非流式**响应开关
- 新增 **HTML 预览**（整页缩放、原像素新窗口）与连接等待实时耗时显示
- 请求展示支持**敏感头信息脱敏**
- 新增**模型指纹检测**（三次采样、本地评分、手动粘贴、参考库版本提示）

## 贡献

欢迎对项目进行改进！如果你有新的想法或想要完善交互，请提交 Issue 或 Pull Request。

## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html) 许可证，详情请见 [LICENSE](LICENSE) 文件。
