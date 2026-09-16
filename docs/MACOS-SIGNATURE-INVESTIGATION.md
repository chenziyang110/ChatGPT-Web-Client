# v1.1.0 macOS 安装包调查

在 macOS 15 Apple Silicon 构建机下载公开发布的 ARM64 ZIP，与 Release SHA256SUMS.txt 校验一致后，用 ditto 解包。

- codesign 显示 Identifier=Electron、Info.plist=not bound、Sealed Resources=none。
- codesign --verify --deep --strict 与 spctl --assess 均报：`code has no resources but signature indicates they must be present`。
- 在没有浏览器下载隔离标记的测试目录中，应用仍能启动并通过更新设置与重启检查。因此开发态启动测试不能发现该安装问题。
- 原发布日志明确记录 `skipped macOS application code signing`，原因是 `CSC_IDENTITY_AUTO_DISCOVERY=false` 且未配置签名身份。

调查运行：[35124726155](https://github.com/chenziyang110/ChatGPT-Web-Client/actions/runs/35124726155)。该诊断任务有意保留校验错误继续执行启动检查，其绿色结果不代表签名通过。

修复：显式设置 mac.identity 为 `-`，对整个应用和额外 Go Agent 执行 ad-hoc 签名；不启用需要开发者身份配合的 hardened runtime。发布检查从最终两种归档提取应用，严格校验签名并启动，任何错误直接阻止发布。

限制：ad-hoc 不提供开发者身份或公证。安装包完整性、无隔离标记时的可运行性、Gatekeeper 对联网下载软件的信任是不同检查；前两项通过不代表最后一项通过。需要 Apple Developer ID 和公证才能完成正式的 Apple 信任链。
