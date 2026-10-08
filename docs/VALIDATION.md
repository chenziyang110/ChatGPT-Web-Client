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

## v1.1.0 跨平台构建

- 六种 Go Agent（Windows / macOS / Linux × x64 / ARM64）已在 Windows 交叉编译，逐一核对 GOOS / GOARCH；Linux x64 可执行文件在 WSL 启动成功。
- 54 项 TypeScript 测试、发布清单测试、Go 测试和 5 组 Windows Electron 桌面验证通过。
- Windows x64 / ARM64 NSIS 打包成功；x64 打包应用启动与更新设置持久化验证通过。ARM64 尚未在本地原生硬件运行。
- macOS / Linux 的完整安装包及桌面验证由 Release Desktop 工作流执行，以该次工作流结果为准，不把交叉编译等同于目标硬件运行验证。

### 六目标云端发布验收

[Release Desktop 构建记录](https://github.com/chenziyang110/ChatGPT-Web-Client/actions/runs/35097458158) 的六个矩阵任务均成功，包含各构建主机上的核心、Go、桌面测试，以及指定目标架构打包。

生成 Windows x64 / ARM64 的 NSIS，macOS x64 / ARM64 的 DMG 与 ZIP，Linux x64 / ARM64 的 AppImage 与 tar.gz。macOS 两种归档中的 Agent 已检查 Mach-O CPU 类型和 Unix 可执行权限；Linux 归档已检查目标架构。后续提交仅调整测试、发布清单与文档，应用源文件和打包配置与这些产物一致。

构建机为 Windows x64、Linux x64、macOS ARM64；Windows ARM64、Linux ARM64、Intel Mac 安装包通过交叉构建，不宣称已在这些原生硬件上完成实机验收。

## v1.4.23 页面恢复 · 2026-10-08

- Windows 本地类型检查、生产构建、118 项 TypeScript 测试和 1 项发布清单测试通过。
- 原有 27 组 Electron 桌面回归通过；新增卡死实例回归通过，已加入桌面测试入口。
- 新回归在真实 Electron、独立离线账号中模拟原网页实例永久无法加载，核对同一标签页 / 原会话恢复、暂停队列保留和恢复后发送一次、同账号正在回复的兄弟页保留、另一账号 cookie / localStorage 不变、三次自动重建上限和手动重试。
- 主文档已就绪但 iframe 永久 pending 时，原生 isLoading 仍为 true；验证页面可见、可诊断、可发送队列。恢复期间重新响应并输入草稿不会被旧 timer 销毁；后续主导航重新失效旧 usable 标记。
- Windows x64 NSIS 构建通过。独立打包应用验证自动重建、单页会话连接池重置、cookie / localStorage 保留和不含账号标识 / URL 的本地诊断记录；打包主进程文件哈希与最新构建一致。
- 本机标准安装目录已升级至 v1.4.23。升级前备份数据库，升级后核对 3 个账号、6 个原有标签页及选中项、85 项任务与发送记录一致，数据库完整性检查通过；随后在真实账号页面核对三个账号的输入框均可用。未向账号发送测试消息。
- 生产依赖审计为 0 漏洞；完整审计仍报告既有构建依赖的 10 项问题（8 moderate、2 high），未在此修复中更换打包工具链。
- 用户原始故障在检查前已通过重启消失。上述注入回归证明恢复路径，不能证明已复现原先连续运行八天后的具体故障；新增本地记录用于再次出现时区分加载、网页进程和恢复阶段。

## v1.4.24 自定义链接与授权交互 · 2026-10-08

- Windows 类型检查与生产构建通过；122 项 TypeScript 核心、API、CLI 测试和 1 项发布清单测试通过。
- 原有 28 组桌面回归通过；预览测试改为在 10 秒内等待实际新帧，仍要求网页隐藏、会话锁定且输入框不接收预览键盘输入。
- 新增 OAuth 与自定义链接两组桌面测试，并纳入桌面测试入口。使用真实 Electron 原生鼠标输入和离线 HTTPS 页面，覆盖地址栏 Enter、新账号标签页、同账号正在执行的队列、不同账号 cookie / localStorage 隔离、授权页未完成 iframe、登录弹窗和 POST 回调。
- 验证初始链接限制、精确 loopback 回调的地址 / 端口 / 路径、空白弹窗的沙箱、返回稳定 ChatGPT 后撤回临时导航模式、重启恢复账号和标签页。授权 query、fragment 和标题中的测试凭据均不写入应用数据库（含 WAL）或本地诊断日志；Chromium 的账号登录资料不清除。
- 旧 v1.4.23 打包入口在登录页永久 pending iframe 场景失败，新实现通过。新增 fragment 场景也在修复前失败，修复后通过。普通 ChatGPT 待恢复目标仍需为受支持的会话地址，避免非会话加载目标造成重复恢复。
- Windows x64 NSIS 构建通过，新两组测试使用最终打包 asar 主入口复验通过。
- 实际 Windows x64 打包 exe 冒烟通过：版本 / isPackaged、新地址栏 Enter、保留原标签页、原生鼠标授权跳转、账号 cookie / localStorage 隔离及远程页面无工作区接口。
- 标准安装目录已升级到本机 v1.4.24，安装前一致性备份位于本机 Documents。核对 3 个账号、6 个标签页、85 条任务和发送记录完整；依据备份恢复选中项后再次核对通过。三个真实账号页面的输入框均已就绪。一次性安装任务和临时诊断接口已移除，未切换或合并数据目录。
- 安装包 SHA-256 为 `98BDF9E1ED6BCBC7C8A4486246357747F8E143368209303BD7C9BE046E0B3249`；打包主进程与最终构建文件一致。GitHub Release 尚未发布。
- 用户确认 v1.4.23 已可正常登录；本次没有让真实账号退出登录或代为提交真实授权。离线授权测试不能代替所有第三方提供方的实网验收。
- 生产依赖审计为 0 漏洞；完整审计仍为已有构建依赖的 10 项问题（8 moderate、2 high），依赖版本未变。
