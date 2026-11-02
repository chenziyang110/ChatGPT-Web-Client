# 发布平台验证：2026-11-02

## Linux 窗口尺寸

v1.4.33 的两个 Linux 发布目标和主分支 CI 均在 `tests/desktop.mjs` 的大窗口尺寸等待处失败。错误截图为 1919×1079，先前 900×640、1000×680、1440×940 截图尺寸正常。

隔离诊断 [PR #37](https://github.com/chenziyang110/ChatGPT-Web-Client/pull/37) 仅运行同一桌面测试，保留原断言和超时并增加尺寸日志。真实 Linux 结果确认：请求 1920×1080，原生 bounds / contentBounds / size / contentSize 均为 1919×1079；页面 inner / outer / visualViewport 同为 1919×1079，DPR=1，readyState=complete，无加载中。30 秒后值不变；浏览器 slot 宽度精确匹配实际 viewport。页面没有尺寸不同步，测试把请求值误当成了操作系统接受值。

修正后，测试继续调用相同 setSize，再读取原生 getContentSize，严格等待页面等于实际内容尺寸。现有原生 WebContentsView / slot 精确对齐与焦点布局断言全部保留，没有引入泛化像素容差或扩大超时。

真实 Linux [回归 41442991198](https://github.com/chenziyang110/ChatGPT-Web-Client/actions/runs/41442991198) 四项 CI 全通过：窗口仍为 1919×1079，完整 desktop.mjs 及后续协作、通知、重启、UI、隔离和退出断言通过。本地 Windows 完整 desktop.mjs 也通过，实际大窗口内容尺寸为 1920×1032，与请求值一致。

## Windows 重载

v1.4.33 Windows x64 曾发生一次工作区 shell reload 的严格 load 等待超时。原完整测试在本机通过；增加事件诊断后连续三次仍全部通过，重载 did-finish-load 分别为 17 / 18 / 19ms。Windows ARM64 发布目标也完整通过同一套桌面回归和实际 NSIS 打包。

现有证据不能确认这次云端间歇超时的精确原因，因此未修改工作区恢复逻辑、原测试 load 断言或超时。v1.4.34 仅增加有界加载事件及失败时的页面状态诊断，便于再次发生时区分等待事件与页面未就绪；本地详细诊断保存在被忽略的 release 目录，未包含真实用户资料。

## macOS 运行机

v1.4.33 ARM64 任务在取得运行机前被 GitHub 取消，annotation 明确为 hosted runner 多次未取得，且提示 macOS ARM64 capacity constraints；runner_id=0、steps 为空。它没有执行，不能计为通过。

GitHub [官方运行机表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 当前将 macos-15 映射至 ARM64，macos-15-intel 映射至 Intel。v1.4.34 的 x64 macOS 目标使用 macos-15-intel，ARM64 继续使用 macos-15；两个目标、全部审计/测试/打包/安装验证与发布门禁均保留。分开架构池不能保证托管平台容量，但让 x64 验证在原生 Intel 上执行。
