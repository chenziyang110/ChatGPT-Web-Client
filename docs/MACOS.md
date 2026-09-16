# macOS 安装与签名

Apple Silicon（M 系列）选择 arm64；Intel Mac 选择 x64。下载 DMG 后，将 ChatGPT Web Client 拖入“应用程序”，再启动。

## 首次打开

v1.1.1 起使用完整 ad-hoc 签名。它校验应用完整性，但不证明发布者身份，也不等于 Apple 公证。首次打开可能仍被 Gatekeeper 拦截；请在尝试打开后进入“系统设置 → 隐私与安全性”，选择“仍要打开”。参考 [Apple 官方说明](https://support.apple.com/102445)。

不要关闭 Gatekeeper 或对整个磁盘移除隔离属性。如果系统明确提示恶意软件，不要绕过。

v1.1.0 的 Mac 包签名缺少资源封装，可能显示“已损坏”；请换用 v1.1.1 或更新版本，而不是自行修改旧包的签名。更换应用不会删除独立存储的账号数据。

## 发布验证

发布任务从最终 ZIP 解压和 DMG 复制应用，分别执行 codesign 严格验证、主程序和 Go Agent 架构检查、Agent --help、应用启动与重启测试。测试使用临时数据目录。此测试证明成品可运行，不代表浏览器下载后通过 Gatekeeper；后者需要 Developer ID 签名和 Apple 公证。

后续配置 Developer ID 时，需通过 GitHub Secrets 提供 CSC_LINK、CSC_KEY_PASSWORD 和 Apple 公证凭据，将 mac.identity 改为证书身份并开启 hardenedRuntime，再验证 stapler 和 spctl。证书、密码、个人 Apple ID 不可写入仓库。
