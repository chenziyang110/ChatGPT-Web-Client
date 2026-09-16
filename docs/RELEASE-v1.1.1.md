# ChatGPT Web Client v1.1.1

修复 macOS 安装包签名不完整导致的“应用已损坏”问题。

- 对 macOS Intel / Apple Silicon 应用及内置 Go Agent 显式执行 ad-hoc 签名，封装应用资源。
- 发布前对 DMG、ZIP 内的应用执行严格签名校验、CPU 架构检查、Agent 启动和应用启动/重启测试；任一失败则停止发布。
- Windows、Linux 同步更新版本号，功能与 v1.1.0 一致。

**macOS 首次打开：** 将应用拖入“应用程序”，尝试打开后，在“系统设置 → 隐私与安全性”选择“仍要打开”。此版本使用 ad-hoc 签名，尚无 Apple Developer ID 签名及公证，因此仍可能被 Gatekeeper 拦截。不要关闭系统安全检查。

仅下载本仓库安装包，并核对 SHA256SUMS.txt。安装前退出旧版应用；保留本地数据目录即可继续使用原有账号。
