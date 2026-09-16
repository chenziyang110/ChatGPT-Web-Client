# 跨平台正式发布

## 构建矩阵

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x64、ARM64 | NSIS exe |
| macOS | x64、ARM64 | DMG、ZIP |
| Linux | x64、ARM64 | AppImage、tar.gz |

`npm run dist:win`、`npm run dist:mac`、`npm run dist:linux` 分别生成对应系统的两个架构。macOS 安装包请在 Mac 上构建；Linux 安装包建议在 Linux 上构建。发布工作流使用对应操作系统的构建机，目标 CPU 可不同于构建机 CPU。

每次打包的 beforePack 钩子从 electron-builder 读取目标系统和架构，使用 GOOS / GOARCH / CGO_ENABLED=0 编译 Agent。输出隔离到 `dist-agent/<platform>-<arch>/`，只复制匹配目标的二进制。开发构建始终使用本机架构。`npm run build:agent:all` 可独立交叉编译全部六种 Agent。

Agent 位于 Windows / Linux 的 `resources/agent/` 或 macOS 的 `Contents/Resources/agent/`，通过 `process.resourcesPath` 定位。Unix 可执行文件保留 0755 权限。没有扩展名的 Agent 直接执行，不经过 Node.js。

## 发布

1. 同步修改 package.json 和 package-lock.json 的稳定版本号，增加该版本发布说明。
2. 执行 npm audit、npm test、npm run test:agent、npm run build、npm run test:desktop。核对隐私、截图和 Git diff。
3. 提交推送并创建匹配的 vX.Y.Z 标签。
4. 在 Actions 运行 **Release Desktop**，输入标签。六个矩阵任务分别执行测试和打包；桌面测试运行在构建机架构，不代表另一 CPU 的原生验收。
5. 全部任务成功后，发布任务验证 10 个指定安装包/归档，无缺失、无额外文件、无空文件，生成 SHA256SUMS.txt，上传草稿，再发布为 Latest。已有 Release 不覆盖；失败保持未发布。
6. 验证下载和旧客户端“检查更新”。若云端构建因账户限制无法启动，不能将未生成的安装包宣称为已发布。

不要上传整个 release 目录中的调试文件、测试截图或用户数据。工作流只提取指定安装包扩展名，再由发布清单进行严格检查。

## 更新与限制

v1.0.0 起，安装版启动 10 秒后及每 6 小时请求本仓库 GitHub Latest Release；设置中可关闭或手动检查。只通知更高稳定版本，跳过预发布/草稿；下载后手动安装。检查不携带账户 Cookie、令牌或对话，GitHub 会收到普通请求的 IP 和固定 User-Agent。

安装前退出应用并保留数据目录。签名、公证尚未配置。x64 / ARM64 是不同安装包，暂不生成 macOS Universal 包；不支持 32 位 x86 / ARMv7。

参考：[electron-builder 跨平台构建](https://www.electron.build/v26/docs/features/multi-platform-build/)。
