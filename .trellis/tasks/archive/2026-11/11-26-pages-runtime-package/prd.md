# 隔离 Pages 网站发布范围

## Goal

将 Pages 发布范围限制为网站运行文件，以一次只改变打包范围的云端对照，进一步区分持续 HTTP 500 是发布内容处理问题还是仓库对应的 Pages 后台问题。用户已批准修改、验证并提交本地 Git，由用户推送；不主动部署。

## Evidence

- 最新失败：run 45650279288，提交 49bb70a8627181783ce2ff9d9416d356c0eec153，正确使用新 artifact 15039633180；创建 Pages 部署返回 HTTP 500。
- 最后成功与失败运行的五个 Action 完整 SHA、权限和 Node 警告相同；github-pages 环境未重建，允许 main。
- 失败发布包结构、权限、路径、摘要未见异常，不能把整仓上传认定为根因。
- 本地纯站点对照包 16 文件、tar 5201920 字节，原包 tar 13076480 字节；6/6 原生浏览器冒烟通过，资源/指纹 SRI/手动评分/手机布局可用。证据见 research/diagnostic-evidence.md。

## Requirements

- 仅调整 `.github/workflows/static.yml` 的打包范围及相应测试：复制 index.html、assets/、CNAME、.nojekyll、LICENSE 到独立暂存目录，再上传此目录。
- 保持 Action 版本、权限、部署环境、pages 锁、精确 SHA 和 main 过期检查、所有网站功能及自动同步接口不变。
- 暂存结果不得包含 tests、scripts、proxy、.trellis、.opencode 等非网页运行内容；所有保留文件逐字节一致，资源相对路径不变。
- 同步发布范围规范；提交功能改动，按 Trellis 归档并记录会话。不推送、重跑部署或修改远端设置。
- 如云端仍返回 500，继续保留未确定根因的结论，不以本地通过宣称部署修复。

## Acceptance Criteria

- [x] 工作流只增加站点暂存步骤并调整上传目录，其余部署条件不变
- [x] 测试执行真实 YAML 暂存命令，验证白名单、源文件字节、资源路径及开发/测试目录排除
- [x] 必需文件缺失时打包失败，不上传不完整内容；现有权限及过期提交测试通过
- [x] 已验证的纯站点包与最终暂存结果一致；本地网页/指纹验收证据可审阅
- [x] 范围规范及任务记录完整，本地功能提交完成，未推送或部署

## Execution / Verification

1. fixer 独占 static.yml 与 tests/lmfpd-publish-workflows.test.mjs；先补实际执行暂存步骤的回归，再改工作流。
2. 运行 `node --test tests/lmfpd-publish-workflows.test.mjs`、YAML 解析及所有 run 步骤 bash -n、git diff --check。
3. 核对暂存清单/摘要与本地6项浏览器报告；不重复未受影响的107项同步/加载测试或77项应用测试。
4. 更新现有 Pages 规范，审查最小差异并提交；随后独立归档/会话记录提交。

回滚：恢复此工作流的暂存与上传目录改动即可回到原打包范围。该任务范围有限，采用 PRD-only 规划；subagent 同时最多2个。

## Local verification

- fix-8 (ses_ded01796cffejSQmqUVE5WgNlv)：完成两文件实现，8/8 工作流及实际 shell 测试通过，无跳过；两个 YAML 解析及全部12个 run 块 bash -n、语法和 git diff --check 通过。暂存16文件、5180423字节，与已审阅的纯站点包逐字节一致。
- tre-2 (ses_dedc115bfffeqp1T58fMGG2ewN)：只读终审未发现实质阻塞，核对运行文件、摘要和不变的部署守卫；未重复无关测试。
- 原生 Chrome 冒烟6/6、0运行时异常，报告 /tmp/opencode/pages-runtime-package-3AaPP1/smoke-report.json。最终打包不改应用文件，所有站点字节与该已验收目录一致。
- 已同步 .trellis/spec/backend/lmfpd-auto-sync.md 发布白名单和回归约束。未推送、触发部署或修改远端设置；HTTP 500 内部根因与云端接受结果仍待验证。
- 功能提交 `98bbd47`（`fix: 限制 Pages 发布包为网站运行文件`）已创建，包含工作流、针对性测试与发布规范。归档和会话记录分别提交，收尾后核对 Git 工作区；由用户推送进行云端对照。
