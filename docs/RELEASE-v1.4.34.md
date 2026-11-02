# v1.4.34

修复新版 Your dot 输入框已显示、队列却停在“检查会话”的问题，清除完整依赖审计告警，并修复重试到期时可能遗漏队列调度的竞争。

- 支持 Dot 新的两段会话地址，完整保留会话身份与账号隔离；修复切换会话后定时发送设置被清空的问题。
- 队列使用同一时间快照判断到期任务与下一次唤醒，避免到期重试既未执行、也没有再次调度。
- 兼容对话加载失败卡片中的“再试一次”，保留普通页面的手动操作和原消息发送凭据。
- 更新 Electron 运行时和构建依赖，完整 npm audit 为 0 项告警；保留账号、标签页、队列、草稿和主动暂停状态。
- 发布检查精确比较页面与操作系统实际接受的窗口内容尺寸；macOS x64 和 ARM64 分别使用对应架构运行机，继续执行六目标完整回归和安装包检查。

v1.4.32 / v1.4.33 为未发布候选，完整回归拦截问题后继续修正，以 v1.4.34 重新检查。Windows NSIS 和 Linux AppImage 支持软件内更新；macOS 和 Linux tar.gz 使用对应安装包更新。

测试使用独立资料与离线网页，未向真实业务会话发送测试消息。具体记录：[Dot 新地址](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.34/docs/validation/dot-compound-route-2026-11-02.md)、[依赖审计](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.34/docs/validation/dependency-audit-2026-11-02.md)、[重试调度](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.34/docs/validation/retry-dispatch-boundary-2026-11-02.md)、[发布平台验证](https://github.com/chenziyang110/ChatGPT-Web-Client/blob/v1.4.34/docs/validation/release-platforms-2026-11-02.md)。跨架构打包不代表所有目标硬件均已完成原生验收。
