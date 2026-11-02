# 全量依赖审计修复：2026-11-02

## 变更

Electron 从 44.4.1 升至 44.10.1；构建依赖更新为 Vite 8.3.5、electron-builder 26.18.1、ASAR 4.3.1、universal 3.0.6、glob 14.0.3、minimatch 11.0.4、fast-uri 3.1.9、undici 6.29.1 / 7.30.1。`@electron/get` 5.1.0 的现有约束保留。

只对实际使用相容 API 的 ASAR、app-builder-lib 和 filelist 限定匹配库版本，没有全局强制替换所有旧 API，也没有执行 `npm audit fix --force`、降级打包器或省略开发依赖审计。

Squirrel 可选构建链中的 `temp` 仍使用回调式清理接口。其旧 rimraf / glob 链已移除，改由仓库内自有 private 包 `@chatgpt-web-client/temp-cleanup` 调用 Node 24 的 `fs.rm` / `fs.rmSync`。它只服务 `temp` 的字面路径删除，不实现通用 glob。保留同步和异步接口、缺失路径幂等、错误传播，并将 `maxBusyTries` 映射为原生 `maxRetries`。

根开发依赖键名 `rimraf` 指向相对仓库目录，只有 `temp` 通过 `$rimraf` override 使用它。包自身仍声明真实名称与 private 属性；锁文件没有绝对路径或旧嵌套包。曾试验的单独 file override 会被 npm 相对 temp 目录解析，已弃用；最终方案通过干净安装验证。

## 已完成验证

- Node 24 / npm 11 下执行完整 `npm ci` 成功；安装后 `temp` 确实解析到自有适配器，不是残留旧包。
- 全量 `npm audit` 为 **0**，包含开发与可选依赖；`npm ls --all` 没有依赖树问题。Electron 升级后尚存的 18 项告警已清除。
- 清理适配器 5 项测试通过：实际 temp 文件与非空目录的同步/异步清理、字面特殊字符、相似文件名保留、外部 junction/symlink 目标保护、缺失路径、回调次数、6 次重试配置、EBUSY / EACCES 传播。
- 旧 rimraf 2.2.8 替代实验在注入 EBUSY 后丢失自定义重试次数，因此未采用。
- 真实 app-builder FileMatcher 的 37 个路径在 6 种模式下与升级前结果一致；ASAR 普通与流式归档、解包以及 macOS 构建模块加载检查通过。
- 独立只读复核再次执行全量审计与清理测试，结果一致。
- 最终应用构建与类型检查通过；`npm test` 188 项和发布清单 1 项全部通过；Go Agent 测试通过。
- 升级后的打包器成功生成 Windows x64 NSIS 安装包；随包主进程、预加载和 HTML 与验证构建一致，版本为 1.4.32，构建专用清理适配器未打入应用。无 GUI 读取实际打包二进制，确认 Electron 44.10.1 / Node 24.22.1 / Chromium 152.0.7977.169。

Windows、macOS、Linux 六目标的完整桌面回归与实际安装包检查由正式发布流水线执行，任一目标失败均阻止发布。测试使用独立资料和离线网页，不访问或上传用户账号资料。

v1.4.32 候选流水线六目标的干净安装、全量审计、188 项单测、Agent 测试和构建均通过；独立 PR CI 的三个系统打包也通过。完整桌面回归随后发现重试调度边界竞争，因此候选未发布，继续修复后以 v1.4.33 重新运行检查。

v1.4.33 的 Windows ARM64 完整桌面回归和 NSIS 打包通过，macOS x64 也完成完整桌面回归及打包；Linux 大窗口请求值与实际原生尺寸的测试假设导致发布继续被拦截。真实 Linux 诊断与修正后的完整单独桌面回归均已完成，见[平台记录](release-platforms-2026-11-02.md)；最终以 v1.4.34 重新执行发布检查。
