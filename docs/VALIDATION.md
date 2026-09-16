# 验证记录

## v1.0.0 · 2026-09-16

- Windows 本地：TypeScript 类型检查、主进程 / preload / CLI / React 生产构建通过。
- 53 项 TypeScript 核心、API、CLI、任务队列、回复读取、通知、更新测试通过。
- Go Agent 集成测试通过。
- 5 组 Electron 桌面验证通过：主流程、并行、Agent 目标、回复路由与 Go 流式输出、更新设置。
- Windows 打包应用启动检查通过：版本显示正确，更新开关跨重启保留，测试使用独立临时目录。
- 完整 `npm audit`：未发现漏洞。
- Windows x64 NSIS 安装包构建成功，包含独立 Go Agent 工具。

## 验证范围

桌面测试使用真实 Electron 和离线 HTTPS fixture，覆盖账号 Cookie / LocalStorage 隔离、受限 IPC、窗口与快捷键、草稿与明确发送、任务并行、接管、恢复、回复路由和 Go 工具。测试截图保留在被忽略的 `test-results/` 中，不作为公开展示素材。

README 图片通过 `scripts/readme-images.mjs` 在独立临时数据目录生成。仅使用虚构账号和离线示例内容，网页演示与实际服务界面可能不同；不读取用户已有浏览器资料。

更新测试覆盖版本比较、预发布过滤、请求去重、失败重试与无凭据请求。更新通知需要公开 GitHub Release，可由设置中手动触发检查。

## 实际边界

离线 fixture 无法证明实时 ChatGPT 的所有登录方式、模型、工具和 DOM 变体均可用。没有向真实账号发送发布测试消息。macOS / Linux 安装和签名未纳入本次 Windows 正式版验证。代码签名尚未配置。
