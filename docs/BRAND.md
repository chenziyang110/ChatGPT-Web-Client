# Workspace 视觉规范

这次改版面向日常使用多个 ChatGPT 账号的桌面用户。主要操作是切换工作空间、继续对话和准备本地任务。

## 方向

- 深松绿侧栏、暖白内容区、低饱和嫩绿选中态。字体沿用 Windows / macOS 中文系统字体，不需要下载字体。
- 自定义顶部栏，与界面融为一体；拖动区与窗口按钮分开，窗口操作仅限可信的本地界面调用。
- 网页位置跟随实际内容区域测量，随窗口尺寸与侧栏宽度变化；弹窗与任务页打开时隐藏网页。
- 线性图标、清楚的选中态、可见键盘焦点；尊重系统减少动态效果设置。
- Windows 字体优先使用 Segoe UI、Microsoft YaHei UI；正文与导航 14px，辅助文字不小于 13px。文字标签不旋转，不通过缩放整个界面调整字号。
- 默认侧栏宽 216px，标题栏 36px，页面标题 56px；专注模式隐藏侧栏和页面标题，只保留窗口栏和 44px 网页工具栏，网页取消外边距。小窗口的工具栏为 40px。
- 文案直接说明操作、状态和数据存放位置，不使用宣传口号或装饰性英文标语。
- 下拉选择统一使用 [Radix UI Select](https://www.radix-ui.com/primitives/docs/components/select)，包括专注模式账号、任务目标和 Agent 协作范围。沿用暖白菜单、松绿文字、浅绿选中态和勾选标识；长列表可滚动，支持键盘选择与输入定位。
- 专注模式菜单打开时暂时隐藏原生网页视图，避免网页遮挡菜单；关闭后恢复网页。这个显示切换不会导航或重新加载账号页面。

| 用途 | 色值 |
| --- | --- |
| 品牌松绿 | `#173e35` |
| 选中嫩绿 | `#c7dfb9` |
| 暖白工作区 | `#f8f9f5` |
| 主要文字 | `#263e35` |

## LOGO

两个对话窗口连接成抽象的 W，表达独立账号与协作的工作空间。奶白主体搭配薄荷绿一角。此图形是独立客户端的视觉标识。

- `src/renderer/public/brand/workspace.png`：图像生成工具制作的方形原图，供标题栏、侧栏、欢迎页与桌面窗口使用；界面通过 CSS 呈现圆角。
- `src/renderer/public/brand/workspace.ico`：同一原图缩放转换的 Windows 图标，包含 16、24、32、48、64、128、256 像素尺寸。
- 打包设置已配置 Windows、macOS、Linux 的图标输入。本轮实际运行验证平台为 Windows。

生成方式为内置 image_gen，共一次生成及两次定向修整。最初创意提示为：两个彼此连接的对话窗口，通过负形构成 W；奶白与薄荷绿图形，松绿色底，无文字，适合 24px 桌面图标，不使用 OpenAI 结形标志。

最终修整提示词：

> Export this exact logo as a clean FULL BLEED SQUARE app icon. PRESERVE the exact two connected cream and mint chat-window emblem. Replace EVERY pixel of the background with one single uniform solid opaque dark pine green #173e35, reaching all four edges and all four corners of the canvas. No transparent area. No checkerboard. No exterior margin or border. No rounded-square tile boundary. Just the emblem on a completely solid dark green square, emblem centered and occupying approximately 70 percent of canvas. Absolutely flat colors. No texture or shadow. This is the finished app asset, not a mockup. 1024 x 1024.

## 窗口实现参考

使用 Electron 的 [自定义窗口交互](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) 和 [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) API：无边框窗口、CSS 拖动区域以及受校验的窗口控制调用。
