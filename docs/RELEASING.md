# 正式发布

当前正式支持 Windows x64 安装包。macOS / Linux 打包配置用于开发验证；发布前需分别验证安装、签名和平台行为。

## 每次更新

1. 同步修改 `package.json` 和 `package-lock.json` 的版本号，使用稳定版本号 `major.minor.patch`，补充发布说明。
2. 执行 `npm ci`、`npm audit`、`npm test`、`npm run test:agent`、`npm run build`、`npm run test:desktop`。
3. 检查暂存区、图片、Git 历史和打包清单，不得包含真实账号资料、个人聊天、浏览器配置、环境文件或凭据。演示截图可通过 `node scripts/readme-images.mjs` 在全新临时目录中重建。
4. 提交并推送代码，创建与版本匹配的 `vX.Y.Z` 标签并推送。
5. 在 GitHub Actions 手动运行 **Release Windows**，输入该标签。工作流测试、构建 NSIS 安装包、生成 SHA-256，先上传草稿，成功后发布为 Latest。已存在的 Release 不会被覆盖。
6. 检查公开 Release 的安装包、哈希、版本号，并用旧版的“检查更新”验证提示。预发布和草稿不会作为更新推荐。

也可在 Windows 本机构建：`npx electron-builder --win nsis --x64 --publish never`。仅上传 `.exe` 和 `SHA256SUMS.txt`；不要上传整个 `release/`、调试日志、测试截图或用户数据目录。

## 更新机制

从 v1.0.0 起，安装版启动 10 秒后及每 6 小时访问本仓库 GitHub Latest Release API。设置中可关闭自动检查、手动重试或打开固定的官方 Release 地址。仅较高的稳定版本号触发提醒；检查有 15 秒超时，同一时刻只发起一个请求。

检查在主进程使用独立的 Node 请求，不复用账号的 Chromium session，不发送 Cookie、鉴权令牌、账户标识或聊天数据。GitHub 仍会收到普通请求的 IP 地址和固定 User-Agent。开发模式不自动请求网络。IPC 仅允许本地可信界面操作更新，不暴露给网页或本地 Agent API。

本版是更新通知与手动安装机制，不包含自动替换程序或强制重启。安装前退出应用并保留数据目录。代码签名尚未配置，Windows 可能显示未知发布者。

依据：[GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)。
