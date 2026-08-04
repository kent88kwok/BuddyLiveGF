# BuddyLiveGF — Windows 移植骨架（性能优化版）

为 Windows 版 WorkBuddy 实现「动态角色皮肤」的第三方注入工具。
原理与官方 BuddyLiveGF 一致：**通过 Electron 的本地回环调试端口（CDP）注入脚本，不修改 WorkBuddy 安装包，仅连接 `127.0.0.1`**。

> ⚠️ 第三方外观工具，与 WorkBuddy 官方无隶属关系。首次运行会结束并重启 WorkBuddy（仅一次，开好调试端口后即可「热切换」无需再重启）。

## 工作原理（已对照 WorkBuddy 前端源码核实）

1. **探测即幂等**：若 `127.0.0.1:9222` 已开则「热附连」（不杀进程）；否则以 `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` 重启一次。
2. 经 CDP 进入 WorkBuddy 渲染进程，注入 `inject/bootstrap.js`：
   - 内置 light / dark 两套皮肤与一个固定定位的角色挂件。
   - **主题检测用 O(1) 属性读取**：WorkBuddy 在 `document.documentElement` 上暴露 `data-vscode-theme-kind`（值 `dark`/`light`）和 `theme-dark`/`theme-light` class（已从 `app.asar` 实测确认）。不调用 `getComputedStyle`，不做亮度计算。
   - 暴露 `window.__buddylive.setLayout('corner'|'immersive')` 供外部调用。
3. 宿主经 CDP `Runtime.evaluate` 调用上面的函数做「页面内即时切换布局」——此路径不受页面 CSP 限制。

## 性能优化点（相对朴素实现）

| 朴素做法 | 本版优化 | 收益 |
|---|---|---|
| 主题变化就 `style.textContent = 全套CSS` | 静态 CSS 只注入一次；切主题只翻 widget 的一个 class | 消除 CSS 整段重解析 |
| `getComputedStyle` + 解析 RGB 算亮度 | 读 `dataset.vscodeThemeKind` / class 判断 | O(1)，零样式读取 |
| MutationObserver 每次突变都 `apply()` | rAF 合并 + `lastTheme` 去重，没变就不动 DOM | 避免无意义的重排/重绘 |
| 回调里改被观察的 `documentElement` | 回调只改 widget 自身 | 杜绝自触发死循环 |
| 每次都 `taskkill` 重启 | 端口已开则热附连 | 不中断用户会话 |
| 端口可能绑 `0.0.0.0` | 显式 `--remote-debugging-address=127.0.0.1` | 更安全、少占用 |
| 呼吸动画用 `width/height/top` | 仅 `transform`/`opacity`（合成线程） | 不触发 layout/paint |

## 为什么 Mac 版不能直接在 Windows 跑

Mac 版只是把「启动器 + 菜单栏 UI + 打包」做成 macOS 原生（`.app` / `NSStatusItem` / AppleScript）。
注入内核、皮肤 CSS、主题检测全是 Electron/前端逻辑，Windows 原样可用。本骨架重写的是那层 Windows 外壳。

| Mac 组件 | Windows 等价 |
|---|---|
| 菜单栏 `NSStatusItem` | 系统托盘 `Tray` / `NotifyIcon` |
| `open -a WorkBuddy.app --args` | `Start-Process WorkBuddy.exe --remote-debugging-port=9222` |
| AppleScript 进程控制 | `taskkill /IM WorkBuddy.exe` + Win32 API |
| `.app` + ad-hoc 签名 | `.exe`/NSIS +（可选）Win 代码签名 |

## 运行

```bash
cd BuddyLiveGF-Windows
npm install        # 仅需 ws 依赖
node launcher.js   # 首次会重启 WorkBuddy 并注入
```

启动后在终端输入命令（正式版应换成托盘菜单）：

- `corner` / `immersive` —— 切换布局
- `theme` —— 打印当前检测到的主题（true=深色）
- `exit` —— 退出

> 用 `WORKBUDDY_EXE` 环境变量可指定非标准安装路径的 `WorkBuddy.exe`。

## 换成你自己的「女友」美术

编辑 `inject/bootstrap.js` 里的 `CSS`（已合并为单段静态样式）：

- 把 `.avatar::before` 的 `content` emoji 换成真实图片：建议 `background-image: url('data:image/svg+xml;base64,...')`（内联 SVG 体积小、可 GPU 合成），避免走网络，保持「仅本地回环」特性。
- 角落布局 = 右下角小挂件；沉浸布局 = 全屏背景 + 大角色。

## 已知注意点（真实移植时要验证）

- **调试端口绑定**：已显式 `--remote-debugging-address=127.0.0.1` 收紧到回环；若你的构建不支持该 flag，用防火墙规则限制 9222 仅本地。
- **目标选择**：`/json` 可能返回多个 `page` 目标（主工作区、扩展宿主等）。`launcher.js` 的 `isWorkbench()` 已排除 devtools/extension/about:blank；生产版应精确匹配工作区窗口 URL。
- **注入时机**：`Page.addScriptToEvaluateOnNewDocument` 只对后续导航生效，故同时用 `Runtime.evaluate` 立即执行一次当前文档。
- **持久化**：重启 WorkBuddy 后需重新注入；正式版可在启动时自动挂载，或做成「开机自启 + 监听 WorkBuddy 进程」的服务。
- **源码现状**：官方仓库的 GitHub「Source code」包仅含 README + 预览图，真实逻辑在编译好的 `.app`/`.exe` 中（未开源）。本骨架为原理一致的独立重实现。
