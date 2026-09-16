# ChatGPT Web Client v1.1.0

新增跨平台、双架构构建和原生 Agent 协作。

| 系统 | CPU | 文件 |
| --- | --- | --- |
| Windows | x64 / ARM64 | .exe |
| macOS | Intel x64 / Apple Silicon ARM64 | .dmg、.zip |
| Linux | x64 / ARM64 | .AppImage、.tar.gz |

- 打包前按目标 CPU 交叉编译 Go Agent，避免将构建机的二进制误装入其他架构。
- 三个平台均内置无需 Node.js 的 Agent，支持阻塞等待、流式输出和断线续读。
- Agent 固定放在应用资源目录，带空格的路径通过参数数组传递。
- 保留 v1.0.0 的更新通知和本地账号数据目录。
- 所有六个构建目标完成后才发布为 Latest，并提供完整 SHA256SUMS.txt。

Windows 未配置发布者签名，macOS 未配置 Developer ID 签名及公证。Linux AppImage 如缺少 FUSE，可选 tar.gz 解压运行。请按照设备系统和 CPU 选择安装包；交叉编译不替代各目标硬件的运行验证。
