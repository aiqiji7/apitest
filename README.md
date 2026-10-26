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
  - **模型指纹:** OpenAI Chat Completions / Responses、Anthropic，支持 API 自动采样与手动粘贴评分
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
   - 如需模型指纹检测，选择「模型指纹」，再选择请求格式后开始检测；也可以切换到「手动粘贴」直接粘贴三条回答评分。
4. **输入用户消息并发送：**
   - 在文本框输入用户消息，点击“发送测试请求”。模型指纹模式不需要输入用户消息。
5. **查看结果：**
   - 左侧查看“轮次与消息”，右侧查看“请求与响应”。每个代码块都支持复制。

> 小贴士：该页面为纯前端网页，所有信息仅存储在您的浏览器本地。

## 模型指纹检测

「模型指纹」入口会把同一组无语义整数任务发送给目标 API 三次，并在浏览器本地与内置参考库比对，给出最相似的候选模型与闭集置信度。

- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；也可以切换到「手动粘贴」，把三条回答直接粘贴进来评分。
- 每条回答至少需要 80 个 1–355 的有效整数；三条齐全才显示置信度，1–2 条只显示 partial ranking。
- **结果只是参考库内的闭集排序，不是模型身份证明。** 库外模型也会得到“最像”的候选。
- 参考数据快照：63 个模型，构建时间 `2026-10-25T10:04:10.682171+00:00`，来自上游 commit `1e58ed8`。
- 检测器数据只在进入「模型指纹」时懒加载（`assets/data/lmfpd/shared_detector.bin`，约 4.6 MB），随后写入浏览器 IndexedDB 缓存。
- 评分完全在浏览器本地完成；采样请求会直接发送到你配置的 API，不会上传到本项目以外的评分服务。

更新参考数据（维护者）：

```bash
node scripts/sync-lmfpd.mjs --ref <upstream-commit>
node scripts/sync-lmfpd.mjs --verify-only
```

同步脚本会重新打包核心算法、裁剪模型元数据，并跑上游 conformance 用例；校验失败不会覆盖现有数据。

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