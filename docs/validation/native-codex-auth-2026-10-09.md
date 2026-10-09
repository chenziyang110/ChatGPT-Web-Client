# Codex 本地授权回跳验证

日期：2026-10-09。此功能从 v1.4.27 起提供，v1.4.26 不包含这项改动。

## 已确认的真实流程

本机安装包 `OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0` 的 Windows manifest 注册了 `codex:` 协议。已安装的 Codex 可执行文件内嵌成功页使用 `codex://threads/new`，与 OpenAI 的源代码一致。

- [OpenAI 回调服务](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)：本机 `/auth/callback` 处理授权，默认端口 1455，备用端口 1457。
- [OpenAI 成功页](https://github.com/openai/codex/blob/main/codex-rs/login/src/assets/success.html)：清除地址中的敏感参数后，通过页面跳转或按钮打开 `codex://threads/new`。
- [成功页路由](https://github.com/openai/codex/blob/main/codex-rs/login/src/success_page.rs)：回调后进入同一本机服务的 `/success`，或 `https://chatgpt.com/codex/open-app`。

没有采用假设的 `codex://auth/callback` 登录路径。显式声明的 native 回调使用已安装客户端中的 `codex://connector/oauth_callback` 作为测试用例。

## 实现边界

授权页仍使用当前账号的独立会话。HTTPS 授权链接可以在初始地址或后续可信 OpenAI 导航中声明本机回调；只允许对应主机、端口、路径。`/auth/callback` 可继续进入同一 origin 的 `/success`。

页面跳转、HTTP 重定向以及授权弹窗均可请求打开 Codex。客户端显示“取消 / 打开 Codex”，确认后交给操作系统处理协议，不直接启动网页指定的文件或命令。支持标准成功页入口，或链接明确声明的 Codex native 回调。

请求按授权标签页去重，主页面和其弹窗共享去重状态。确认后重新核对账号、标签页、源文档和页面存活状态。来自后台、已切换的账号/标签、队列锁定页面或不可信子框架的请求不打开程序。没有 referrer 的原生协议弹窗仅在整个框架树具有相同、非 opaque 安全 origin 时允许；包含跨域 iframe 的此类弹窗会被拒绝，标准成功页的直接跳转仍支持。

取消应用跳转不会被误判为网页加载失败，不自动重放一次性 OAuth 回调。程序启动失败只显示通用提示，可重试；授权参数、native 回调地址和启动异常原文不写入诊断日志、工作空间数据库、保存的标签页标题或确认框。临时授权标签仍在重启后回到 ChatGPT 首页。

## 本地验证结果

| 验证 | 结果 |
| --- | --- |
| 完整单元测试 | 127 项通过，发布清单测试另 1 项通过 |
| 新增授权策略测试 | 5 项通过，包含精确匹配、长度、编码控制字符和非法协议 |
| 构建 / 类型检查 | 通过 |
| native-app-auth-desktop | 通过 |
| custom-link-desktop | 通过 |
| oauth-interaction-desktop | 通过 |
| npm audit | 0 项漏洞 |

新增桌面测试启动真实 Electron，使用隔离的虚构账号和实际本机 HTTP 服务验证 callback → HTTP 302 → success → native 协议。操作系统打开程序的调用使用测试替身，避免改变用户现有 Codex 登录状态。

覆盖正常导航、HTTP 重定向、计时器唤起、按钮、`window.open`、授权弹窗自身的跳转、主页面与弹窗同时请求、取消及再次操作、程序打开失败后重试、账号/标签切换后的旧确认、隐藏页面、队列锁、错误本机端口/路径、不可信来源、跨域 iframe 弹窗/顶层跳转、opaque sandbox iframe，以及授权标题和存储的敏感数据检查。子框架负例验证实际 Chromium 事件已发生，避免浏览器自身阻止弹窗使测试误通过。

本地功能验证没有重新授权用户的真实账号，也没有更改用户浏览器资料或重启当前生产客户端。安装的 Windows 协议注册已核对；真实服务网络异常、所有第三方应用协议以及其他平台上的注册处理不属于此次运行验证。正式发布使用 GitHub 的六目标构建与完整桌面测试门槛。
