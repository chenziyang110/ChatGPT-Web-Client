# v1.4.39（Windows）

修复删除账号时被本机队列和待核对任务阻塞的问题。

- 输入完整账号名称确认后，可直接删除账号，不必先接管或手动处理队列任务。
- 删除立即停止该账号的本机任务，并清除该账号的任务、队列、请求记录、会话记录、通知和浏览器资料。
- 已经发送到 ChatGPT 的消息仍保留在 ChatGPT 中。
- 删除其他账号时保留当前活动账号；删除当前活动账号时再切换到剩余账号。

**本版仅提供 Windows x64 / ARM64 安装包和更新清单。** macOS / Linux 用户继续使用 [v1.4.37](https://github.com/chenziyang110/ChatGPT-Web-Client/releases/tag/v1.4.37)。

本机 `npm audit` 未发现依赖漏洞，`npm run build` 通过。该版本在 Windows 本机打包，不代表 macOS / Linux 或云端六目标构建验收。
