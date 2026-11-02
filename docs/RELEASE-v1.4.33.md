# v1.4.33

修复新版 Your dot 输入框已经显示、队列却停在“检查会话”的问题，清除依赖审计告警，并修复重试到期瞬间可能遗漏队列调度的竞争。

- 支持 Dot 新的两段会话地址，完整保留会话身份与账号隔离；修复切换会话后定时发送设置被清空的问题。
- 队列使用同一时间快照判断已到期任务与下一次唤醒，避免任务刚好到期时既未执行、也未安排重试。
- 兼容对话加载失败卡片中的“再试一次”按钮，保留普通页面的手动操作和队列原消息的发送记录。
- 更新 Electron 运行时和构建依赖，完整 npm audit 为 0 项告警；账号、标签页、队列、草稿和主动暂停状态保留。

v1.4.32 候选被完整桌面回归拦截，没有发布。此次同时修正登录跳转和断线恢复测试中的异步观察，仍检查原任务身份、发送凭据和不重复发送。

Windows、macOS、Linux 的 x64 / ARM64 六目标全部通过发布检查后才发布。Windows NSIS 和 Linux AppImage 支持软件内更新；macOS 和 Linux tar.gz 使用对应安装包更新。

测试使用独立资料与离线网页，未向真实业务会话发送测试消息。验证记录：[Dot 新地址](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.33/docs/validation/dot-compound-route-2026-11-02.md)、[依赖审计](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.33/docs/validation/dependency-audit-2026-11-02.md)。跨架构打包不代表所有目标硬件都已完成原生验收。
