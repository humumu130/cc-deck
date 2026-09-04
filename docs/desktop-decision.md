# CC Deck Windows 桌面客户端技术选型决策文档

- **对应需求**：backlog #171 —— Windows 桌面 exe 客户端：本地运行、自带 UI、不依赖浏览器、默认连本机 relay（`ws://localhost:8787/ws`，可手填远程地址），解决"不信任托管网页"的顾虑，数据不出局域网。
- **调研日期**：2026-09-04（所有版本号 / 体积 / 支持状况均以当日搜索结果为准，来源见文末汇总；无法确证的一律标注 **待验证**）
- **形态预期**：exe 内嵌现有 `web-console/index.html`（1992 行 / 96KB 单文件）+ `nacl.js`（32KB，内联版 tweetnacl），指向本机或用户手填的 relay 地址。
- **结论速览**：推荐 **Electron**，次选 Tauri 2.x，.NET WebView2 壳作为"未来 PC 端一体化"备选。详见第 8 节。

---

## 1. 背景与约束

### 1.1 web-console 现状（决定迁移成本的关键事实）

| 事实 | 值 | 对选型的影响 |
|---|---|---|
| 主体文件 | `web-console/index.html`，1992 行 / 约 96KB | 单文件，任何"加载本地 HTML"的壳都能直接吃 |
| 依赖文件 | `nacl.js`（32KB 压缩版 tweetnacl），通过 `<script src="/nacl.js">` 引用（**绝对路径**） | 在 `file://` 协议下绝对路径会解析到盘符根而 404，加载本地文件的三种壳都可能需要把它改成相对路径 `"nacl.js"`（1 字符改动），或内联进 HTML |
| 连接方式 | 原生 `new WebSocket(url)`，地址由用户输入框填写 | 无 CORS 问题（WebSocket 不受同源策略限制）；受 CSP `connect-src` 和混合内容规则约束 |
| 状态持久化 | `localStorage`（`ccr_url` / `ccr_token` / 主题 / 缩放等十余个键） | 三种壳（Electron / WebView2 / Tauri）均支持 localStorage，落盘在各自 user data 目录，无需改代码 |
| 默认地址逻辑 | `index.html` 第 1908 行附近：按 `location.protocol` 推导默认 URL；`file://` 下推导为空 | 桌面版需要预填 `ws://localhost:8787/ws`，属必须的小改动（三方案均需） |
| 云桥 token | 存在 `BAKED_BRIDGE_TOKEN` 烘焙值常量 | 代码注释明确：这是**设计内公开**的公共桥准入令牌（开源用户零配置），桥只转发密文、真正安全边界在配对码；桌面壳化不改变其暴露面，见 9.3 |
| 服务器配置模型 | `localStorage.ccd_servers`：多服务器列表，每项 `{kind:"lan"\|"cloud", wsUrl, token}`，**已内置"本机直连"条目**（空 wsUrl） | 桌面版"默认连本机 relay"的诉求与现有数据模型天然对齐：给"本机直连"条目预填 `ws://localhost:8787/ws` 即可，不新增配置结构 |
| 认证与补拉 | token 经 URL query 传（`?token=...&last_seq=...`），断线自动重连（1s 起退避），`last_seq` 增量补拉 | 与壳无关，三方案等价继承，不构成区分项 |

### 1.2 非功能约束

- **单人维护、开源项目**：构建链越短越好，CI 最好一条命令出 exe。
- **PC 工具型应用**：不是 7x24 常驻服务，内存 / 体积不是硬指标，"能用、好更新、不出安全幺蛾子"优先级更高。
- **目标用户是开发者本人 + 少量同事**：系统形态不可控（公司 Win10 / Win11 / 可能存在 LTSC 或精简系统）。
- **分发形态**：首期倾向 zip 免安装或 NSIS 安装包二选一（影响 SmartScreen 表现与更新器实现，见 9.1/9.2）；不进微软商店。
- **信任模型**：核心诉求是"数据不出局域网"，即壳本身必须是本地加载 UI、只连用户指定的 relay，而不是"壳越小越好"。

### 1.3 桌面 exe 在客户端矩阵中的位置

CC Deck 当前已有多端客户端，共用同一 relay 协议：

| 端 | 形态 | 信任模型 |
|---|---|---|
| 托管页 | web-console 部署到 Cloudflare（wrangler.jsonc） | 页面在公网，靠 E2E 加密 + 配对码，但"不信任托管网页"的顾虑正是 #171 的由来 |
| 手机 | expo-app（React Native） | 本地 App，走云桥 |
| 手表 | wear-app | 本地 App，走云桥/蓝牙网络 |
| **桌面（本需求）** | exe 内嵌 web-console | **UI 本地加载 + 默认连本机 relay，全程不出局域网（云桥仍可选）** |

即桌面 exe 是"第 4 个客户端、第 1 个纯本地 UI 客户端"。这决定了选型核心是**复用 web-console 这份 UI 资产**，而不是新建 UI——四种候选全部按此约束评估。

---

## 2. 候选方案总览

| 方案 | 一句话概括 |
|---|---|
| A. Electron | 自带完整 Chromium + Node，`loadFile('index.html')` 即用，体积最大、链路最短 |
| B. Tauri 2.x | Rust 壳 + 系统 WebView2，体积最小，引入 Rust 工具链与 WebView2 覆盖率问题 |
| C. .NET WebView2 壳 | C# WinForms/WPF 宿主 WebView2 控件，与仓库现有 C# 注入器同语言 |
| D. Flutter desktop / NativeScript | 无官方 Windows WebView/HTML 嵌入路径，等于全部重写 UI，排除（第 6 节） |

阅读路径：只看结论 → 第 7、8 节；关心某方案细节 → 第 3/4/5 节；准备实施 → 第 9 节。

### 2.1 评估方法论

- 七个维度来自 #171 的实际约束反推：装得上（兼容/体积）、跑得动（内存）、做得快（复用/CI）、活得久（更新/维护），各对应 1–2 个可查证指标。
- 每个事实尽量给一手来源（官方文档 / 官方仓库 issue / 厂商博客），社区基准数据一律标"待实测"。
- 版本与覆盖率均为 2026-09-04 检索结果；本仓库相关代码事实（web-console 结构、inject.cs 工具链）直接读自源码，属最可靠一层。

---

## 3. 方案 A：Electron

### 3.1 2026-09 现状（版本）

- 当前稳定线：**Electron 43**（2026-06-30 起，Chromium 150 / Node 24）；**44.2.0**（Chromium 152 / Node 24.20）于 2026-09-03 前后发布（检索当日 releases 页显示为"Tomorrow"，**待验证** 以 [releases.electronjs.org](https://releases.electronjs.org/) 实时为准）；45 处于 alpha。
- 大版本节奏：约每 8 周一个 stable，同时维护最近 3 个大版本（安全回移）。来源：[Electron Releases](https://releases.electronjs.org/)、[GitHub Releases](https://github.com/electron/electron/releases)、[endoflife.date/electron](https://endoflife.date/electron)。
- 治理：OpenJS 基金会项目，微软 / Slack 等出资维护，维护风险在本对比中最低。

### 3.2 体积与内存（空壳 + 加载本地 HTML）

- 安装包（NSIS 压缩后）：**约 35–60MB**；安装后磁盘占用 **约 100–150MB**。来源：[Stack Overflow #47866495](https://stackoverflow.com/questions/47866495/electron-builder-app-size-is-too-large)、[electron-react-boilerplate#795](https://github.com/electron-react-boilerplate/electron-react-boilerplate/issues/795)。
- Hello World 未压缩约 85–115MB 的社区口径（[Medium/Gowombat](https://medium.com/gowombat/how-to-reduce-the-size-of-an-electron-app-installer-a2bc88a37732)）。
- 空闲内存：**约 100–200MB 起步**（Chromium 多进程 + JS 堆之外的开销，[官方性能指南](https://electronjs.org/docs/latest/tutorial/performance)、[Seena Burns 实测](https://seenaburns.com/debugging-electron-memory-usage/)）。CC Deck 这种带长列表渲染的 UI 会更高，**具体数字待验证**（建议 PoC 后用任务管理器实测）。
- 体积构成拆解：NSIS 压缩包 ≈ Chromium（~60MB 解压后大头）+ Node 运行时 + 应用代码（~128KB，可忽略）。即无论 UI 多简单，都有 ~100MB 的"底盘"，这是自带内核的代价，也是 Win10 长尾兼容 100% 的来源。
- 对本项目：PC 工具场景可接受；对比项是"省 100MB 磁盘换一条 Rust 工具链"是否划算（见第 8 节判断）。

### 3.3 复用 web-console 的改动量：≈ 0

- 把 `index.html` + `nacl.js` 拷进 app 目录，主进程 `BrowserWindow.loadFile('index.html')`（`file://` origin）。
- `file://` 页面连 `ws://localhost:8787` 是 Electron 社区多年常见路径，不受混合内容限制（mixed content 只约束 https 页面）；**仍建议 PoC 实测一次**（列入待验证清单）。
- 必改项只有两处：默认地址预填 `ws://localhost:8787/ws`；`/nacl.js` 绝对路径改相对（`file://` 下需要）。
- localStorage 直接可用（Electron user data 分区），主题 / token / 地址记忆全部免费获得。
- 云桥模式（`wss://`）在 Electron 下同样可用，功能零损失。

### 3.4 自动更新：三方案中最成熟

- 主流组合 `electron-builder` + `electron-updater`（NSIS 目标）：支持 GitHub Releases / 任意 HTTP 静态 `latest.json`（generic provider）、全量 + blockmap 差量。官方已把 Squirrel.Windows 划入弃用方向并推荐 NSIS（[electron-builder 文档](https://www.electron.build/docs/squirrel-windows/)、[forge#3069](https://github.com/electron/forge/issues/3069)、[forge#3598](https://github.com/electron/forge/issues/3598)）。
- 对本项目的现实意义：`latest.json` + 安装包可以直接放在已有阿里云 ECS（8.133.211.170）上，绕开国内拉 GitHub 不稳的问题（见 9.1）。

### 3.5 CI 构建

- GitHub Actions `windows-latest` + Node：`npm ci && electron-builder --win nsis`，无需任何额外工具链，5–10 分钟级。是三者中构建链最短的。

### 3.6 维护成本与风险

- 语言/工具链与仓库主链路（relay 全 TypeScript / Node）完全同构，零新增技能。
- 风险点：8 周一次的大版本升级节奏（不跟也不致命，跟随最新 stable 拿安全补丁即可）；Chromium 体积缓慢上涨；"Electron = 吃内存"的口碑问题（对本工具型场景无实质影响）。

### 3.7 判定小结

| 优势项 | 劣势项 |
|---|---|
| 兼容确定性 100%（自带 Chromium，含 LTSC） | 磁盘 100–150MB / 内存最高 |
| 复用改动量 ≈ 0 | 口碑背锅（开源项目 README 里常被问"为什么不用 Tauri"） |
| CI 与更新链路三者最短最成熟 | — |

适合判定：当"分发对象系统不可控 + 单人维护 + UI 已存在"三条同时成立时，Electron 的确定性溢价大于其体积税。本项目三条全中。

---

## 4. 方案 B：Tauri 2.x

### 4.1 2026-09 现状

- 2.x 为当前稳定大版本（桌面 + iOS/Android），社区活跃、迭代快。注意 Tauri 的各 crate / CLI / API **版本号独立演进**：近期可见 `@tauri-apps/cli` 2.9.x、`@tauri-apps/api` 2.8.x 等，单一"最新版本号"不存在，以 [官方 release 汇总页](https://v2.tauri.app/release/) 与 [GitHub Releases](https://github.com/tauri-apps/tauri/releases) 为准（精确 patch 号 **待验证**）。
- 开发与打包**必须安装 Rust 工具链**（rustup + MSVC Build Tools）；纯前端项目"迁移"门槛在此：本仓库目前无任何 Rust 代码。

### 4.2 WebView2 依赖与 Win10 覆盖率

- Tauri 在 Windows 上用系统 WebView2（官方声明支持到 Win7，需捆绑运行时时安装包 +约 1.8MB；[Webview Versions](https://v2.tauri.app/reference/webview-versions/)、[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)）。
- 覆盖率官方口径：Win11 全量预装；Win10 自 2022 年起通过 Windows Update 自动推送——微软 2022-06 称超 4 亿台 Win10 已装（[Edge 博客](https://blogs.windows.com/msedgedev/2022/06/27/delivering-the-microsoft-edge-webview2-runtime-to-windows-10-consumers/)），2022-12 扩展到企业托管设备（[Edge 博客](https://blogs.windows.com/msedgedev/2022/12/14/delivering-webview2-runtime-to-managed-windows-10-devices/)、[ZDNet](https://www.zdnet.com/article/microsoft-were-bringing-edge-webview2-to-more-windows-10-devices-and-heres-why/)），当前 [MS Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) 表述为"绝大多数 Windows 10 设备已安装"。
- **但微软从未公布精确百分比**。残留风险场景：剥离 Edge 的 Win10 LTSC / 精简系统 / 长期离线机器可能没有 WebView2 → 需走安装器捆绑 bootstrapper（要求联网或离线包，分发复杂度上升）。
- 兜底策略（若选 B 时）：NSIS/MSI 里配 `webviewInstallMode: downloadBootstrapper`（在线拉取，约 2MB 引导器）或 `offlineInstaller`（+~100MB，体积优势基本归零）或 `embedBootstrapper`（+1.8MB 但仍需联网下载运行时）。即**缺失场景要么牺牲体积要么牺牲离线安装**，没有免费解。公司环境是否存在此类机器 **待验证**。
- 结论：覆盖率对普通用户足够好，但"目标是开发者同事的怪机器"时不如 Electron 的 100%（自带 Chromium）。

### 4.3 体积与内存

- 产物体积：Hello World 约 3.2MB（对比 Electron 同款约 85MB，小约 96%），典型简单应用 3–15MB，复杂应用 ~30MB。来源：[Tauri 官网](https://v2.tauri.app/)、[2026 对比文](https://tech-insider.org/tauri-vs-electron-2026/)、[Digital Applied 2026](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)。
- 内存：复用系统 WebView2，简单应用约 30MB 级的社区口径（[rustify 2026 教程](https://rustify.rs/articles/rust-tauri-v2-desktop-app-tutorial-2026)），实际以 WebView2 进程为主，**数字待验证**。
- 这是 Tauri 的核心优势项，且 UI 渲染引擎（Chromium 系）与 Electron 同源，web-console 兼容性无差别。

### 4.4 复用 web-console 的改动量与已知坑

改动量小，但坑比 Electron 多一层：

1. **前端可以直接拷贝**：`frontendDist` 指向含 `index.html` + `nacl.js` 的目录即可（`/nacl.js` 在 Tauri 的根路径服务下可正常解析，不需要改相对路径）。
2. **CSP**：`tauri.conf.json` 中配置的 CSP 若含 `default-src 'self'` 之类，会拦掉 `ws://localhost:*`，需显式加 `connect-src ... ws://localhost:* ws://<pc-ip>:*`（[官方 CSP 文档](https://v2.tauri.app/security/csp/)）。远程地址是用户手填的任意 IP，CSP 得放开 `ws://*:*`（安全性由"用户自己填地址"模型兜底）。
3. **Scheme 与混合内容（本项目最相关的坑）**：Tauri v2 在 Windows 生产构建默认以 **`http://tauri.localhost`** 服务页面（`useHttpsScheme` 默认 false，[官方配置 schema](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-schema-generator/schemas/config.schema.json)、[配置文档](https://v2.tauri.app/reference/config/)、[#11081](https://github.com/tauri-apps/tauri/issues/11081)）→ http 页面连 `ws://` **不受混合内容限制**，默认配置下本项目场景可行。**但若开启 `useHttpsScheme: true`（或未来默认翻转），https 页面连 `ws://` 会被 WebView2 以 Mixed Content 拦截**（[#7701](https://github.com/tauri-apps/tauri/issues/7701)、[#3007](https://github.com/tauri-apps/tauri/issues/3007)；规范虽把 loopback 视为 potentially trustworthy（[MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content)），Chromium 对 ws 的 loopback 豁免历史不一致，见待验证清单）。兜底方案是官方 [websocket 插件](https://v2.tauri.app/plugin/websocket/)（Rust 侧建连，绕开 WebView 限制，但要改前端连接代码）。
4. **dev server 细节**：`devUrl` 的 `localhost` 与 `127.0.0.1` 不一致会导致加载失败（[#9699](https://github.com/tauri-apps/tauri/issues/9699)）；本项目无前端构建步骤、无 dev server，此坑不适用。
5. localStorage 可用（WebView2 user data 目录），但**多窗口/清缓存行为**以 WebView2 为准，属低风险。

### 4.5 自动更新

- 官方 updater 插件（v2）内置差量、minisign 签名校验、支持 Windows，配合 GitHub Releases 静态 JSON 即可。比 .NET 生态现成，比 electron-updater 略繁琐（要管理签名密钥对、自建/托管 updates manifest；国内下载源同样可自托管）。

### 4.6 CI 构建

- GitHub Actions 官方模板（`tauri-apps/tauri-action`）：可自动化出 NSIS/MSI + updater 产物；但需装 Rust + MSVC 工具链，冷构建 15–25 分钟（缓存后缩短）。链路长度：Electron < Tauri ≈ .NET。

### 4.7 维护成本与风险

- 社区非常活跃、2.x 稳定一年以上，框架本身风险不高；真正的成本是**本仓库引入第一条 Rust 工具链**：出问题（如上面 scheme/CSP/updater 签名）时要能读懂 Rust 侧配置与日志。单人维护下这是持续的隐性税。

### 4.8 判定小结

| 优势项 | 劣势项 |
|---|---|
| 体积 3–15MB / 内存低，三方案最优 | 引入 Rust 工具链与技能税 |
| 渲染引擎同为 Chromium 系，UI 兼容无虞 | WebView2 覆盖率无官方数字，LTSC 长尾需捆绑运行时 |
| 官方 updater 插件齐备 | scheme/CSP/ws 细节坑多一层；CLI/crate 版本独立演进认知负担 |

适合判定：体积/内存是硬指标、或团队已有 Rust 背景时选它。本项目两者皆无，故列次选。

---

## 5. 方案 C：.NET WebView2 壳（C# WinForms/WPF + WebView2 控件）

### 5.1 两条子路线

| 子路线 | 产物 | 说明 |
|---|---|---|
| C1. **net48（.NET Framework 4.8）** | 单 exe + 依赖 dll，**约 2–5MB** | .NET Framework 4.8 是 Win10 1809+/Win11 **内置**运行时，用户零安装；仓库的 relay 注入器（`relay/src/injector.ts`）本就用系统内置 `csc.exe`（`C:/Windows/Microsoft.NET/Framework64/v4.0.30319`）在运行时编译 `bin/inject.cs`，证明该路线与本机环境已验证可用、作者有现成 C# 经验 |
| C2. **.NET 10（LTS）** | framework-dependent 约 1MB（但要求用户装 .NET Desktop Runtime）；self-contained 单文件 **约 80–100MB** | .NET 10 为 LTS（2025-11-11 → 2028-11-14，[支持策略](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)）。WinForms/WPF **官方不支持裁剪**，self-contained 下不去（[WebView2Feedback#3866](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/3866)、[发布概述](https://learn.microsoft.com/en-us/dotnet/core/deploying/)）；framework-dependent 则把运行时安装成本转嫁给用户 |

- 结论：选 C 必选 **C1（net48）**——否则体积优势全无（80–100MB 反超 Electron），还多一个"用户没装 Desktop Runtime"的分发坑。
- WebView2 运行时本身（浏览器内核部分）两条子路线都依赖，覆盖情况同 4.2（Win11 预装、Win10 绝大多数）。
- WebView2 SDK（NuGet `Microsoft.Web.WebView2`）对 .NET Framework 4.6.2+ 的支持口径 **待验证**（以 NuGet 包 targets 为准）。

### 5.2 体积与内存

- C1 体积：exe 级（个位数 MB），三方案最小梯队（与 Tauri 同级）；内存：WebView2 进程 + 轻量 .NET 宿主，与 Tauri 同量级（**待实测**）。

### 5.3 与仓库 Windows 生态的契合度

- relay 的按键注入器已是 C#（`bin/inject.cs`，SendInput/控制台切换那一套），`injector.ts` 里有完整的"缺 csc 就报错"兜底；说明 Windows 侧疑难杂症（ConPTY、焦点、权限）作者的舒适区就在 C#。
- 若未来想演进为"PC 端一体化原生组件"（托盘 + relay 守护 + 注入 + UI 壳合并成一个 C# 程序），C 是唯一顺势路线。这是 C 的战略价值，不是本期需求。

### 5.4 复用 web-console 的改动量与坑

- UI 拷贝即可，但加载方式有讲究：
  - `Navigate("file:///.../index.html")`：最简单；`<script src="/nacl.js">` **绝对路径在 file:// 下失效，必须改为相对路径**（同 Electron）。
  - `SetVirtualHostNameToFolderMapping("app.local", ...)`：路径体验最好，但映射走 **https://app.local** → `ws://` 有被混合内容拦截的风险（同 4.4 第 3 条，**待验证**），不推荐本项目使用。
  - `NavigateToString(html)`：单字符串注入，`nacl.js` 外部引用会断，不适用。
- 默认地址预填同前（必须的小改动）。
- 托盘、窗口关闭到托盘、开机自启等桌面化功能在 WinForms 里都是现成控件/几行代码，比 Electron/Tauri 不吃亏。

### 5.5 自动更新

- .NET 桌面无官方方案。2026 年社区主流是 **[Velopack](https://velopack.io/)**（Squirrel 官方后继，差量更新、约 10 行代码接入，支持 WinForms/WPF，NuGet 持续更新中，版本仍在 0.x 阶段）；旧 Squirrel.Windows 已停滞（Electron 侧同样弃用，见 3.4）。成熟度低于 electron-updater、与 Tauri updater 大致同级，但 **0.x 版本号 + 第三方个人主导项目**是维护风险点（[GitHub](https://github.com/velopack/velopack)）。

### 5.6 CI 构建

- GitHub Actions `windows-latest`：`dotnet build -f net48` 即可（runner 自带 targeting pack），构建快、链路短。签名后可用 Velopack 出安装包 + 差量。

### 5.7 判定小结

| 优势项 | 劣势项 |
|---|---|
| 与 inject.cs 同语言，作者 Windows 侧舒适区 | UI 壳 + 托盘 + 更新配套开发量高于"loadFile 一次" |
| net48 路线体积最小梯队、零运行时安装 | 同样吃 WebView2 覆盖率（不如 Electron 确定） |
| 未来"PC 端一体化"唯一顺势路线 | 更新器 Velopack 为第三方 0.x；file:// 下 `/nacl.js` 必改 |

适合判定：把桌面壳当作"relay 原生化演进的第一步"时选它；只为 #171 的最小需求则开发量偏大。

---

## 6. 顺带排除：Flutter desktop / NativeScript / 其他

| 候选 | 排除原因 | 来源 |
|---|---|---|
| Flutter desktop（Windows stable） | 官方 `webview_flutter` **至今没有 Windows 实现**，根因是 Windows 上 PlatformView 未实现；第三方 `webview_windows` 等有悬浮层限制（Flutter 控件无法盖在 WebView 上）。且等于把 1992 行 HTML/JS UI 用 Dart 重写，与"复用 web-console"目标背道而驰；2026 年评估也指出 Windows 桌面生产级包偏少 | [flutter#182137](https://github.com/flutter/flutter/issues/182137)、[flutter#31713](https://github.com/flutter/flutter/issues/31713)、[softaims 2026](https://softaims.com/blog/flutter-web-desktop-production-ready-2026) |
| NativeScript | 官方定位仅 iOS/Android，无 Windows 桌面目标（社区讨论里推荐的替代恰恰是 Tauri） | [nativescript.org](https://nativescript.org/)、[SO](https://stackoverflow.com/questions/62487545/nativescript-roadmap-desktop-support-no-longer-on-the-cards)、[rfc#11](https://github.com/NativeScript/rfcs/discussions/11) |
| Neutralino / wails 等 | 体量与社区远小于前三者，单人维护的开源项目没必要选长尾框架 | [Digital Applied 2026](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) |

一句话：这三个候选要么嵌不了现有 HTML、要么没有 Windows 桌面目标、要么社区太小，在"复用单文件 web-console"约束下无一是正解。

---

## 7. 七维对比表

| 维度 | A. Electron | B. Tauri 2.x | C. .NET WebView2（net48） |
|---|---|---|---|
| 安装包体积 | 35–60MB（NSIS 压缩） | 3–15MB（+1.8MB 若捆绑 WebView2） | 约 2–5MB |
| 安装后磁盘 | 100–150MB | 10–40MB | <10MB |
| 运行内存（空闲） | 约 100–200MB+（待实测） | 约 30–80MB 级（待实测） | 约 30–80MB 级（待实测） |
| Win10 兼容 | **100%**（Chromium 自带，含 LTSC/无 Edge 精简系统） | 依赖 WebView2：Win11 预装；Win10"绝大多数"已装，**无官方百分比**；LTSC/精简系统有缺失可能（待验证） | 同 Tauri（依赖 WebView2）+ net48 需 Win10 1809+（基本无虞） |
| 构建链复杂度 / CI | **最低**：纯 Node，一条命令 | Rust + MSVC 工具链，官方 Action 模板，冷构建 15–25min | 低：`dotnet build -f net48`，runner 现成 |
| 复用 web-console 改动量 | **≈0**（预填默认地址 + `/nacl.js` 改相对路径） | 小（同左 + CSP 放开 `ws://`；勿开 `useHttpsScheme`） | 小（同 Electron 两条必改项；避开 https 虚拟主机映射） |
| 自动更新 | **electron-updater**，最成熟，支持自托管 latest.json + 差量 | 官方 updater 插件，需管理 minisign 密钥 | Velopack（0.x，Squirrel 后继）或自研 |
| 社区 / 维护风险 | OpenJS 基金会，最低 | 活跃，但仓库新增 Rust 技能税 | 微软第一方控件 + 作者已有 C# 资产；更新器属第三方 0.x |

### 7.1 加权评分矩阵（1–5 分，权重按本项目约束设定）

| 维度 | 权重 | A. Electron | B. Tauri | C. .NET net48 | 权重依据 |
|---|---|---|---|---|---|
| Win10 长尾兼容（确定性） | 25% | **5** | 3 | 3 | 同事机器形态不可控，装不上=需求失败 |
| 复用 web-console 改动量 | 20% | **5** | 4 | 4 | 单人维护，迁移成本直接吃交付速度 |
| CI 构建链 | 15% | **5** | 3 | 4 | 开源项目无专职运维 |
| 自动更新 | 10% | **5** | 4 | 3 | 二期刚需，一期可缓 |
| 维护风险/技能同构 | 10% | **5** | 2 | 3 | 仓库 TS/Node 主链路 |
| 安装包体积 | 10% | 2 | **5** | 5 | PC 工具场景非硬指标 |
| 运行内存 | 10% | 2 | **4** | 4 | 同上 |
| **加权总分** | 100% | **4.40** | 3.50 | 3.65 | — |

（体积/内存合计仅 20% 权重是本结论的关键设定：若把这两项权重提到 40%，B/C 反超。权重表即决策依据，可复盘。）

---

## 8. 推荐结论与理由

### 推荐：**A. Electron**（首期实施）

1. **需求本质是信任与确定性，不是资源占用**。#171 要解决的是"不依赖浏览器 + 数据不出局域网"。Electron 自带 Chromium：不依赖用户机器上有没有 WebView2、有没有 Edge（LTSC/精简系统的长尾风险直接归零）、Chromium 行为 100% 可预期——对"给同事装的内部工具"这是最省心的属性。为省 100MB 磁盘引入两个新的不确定性（WebView2 覆盖 + Rust 工具链），对单人维护的开源项目不划算。
2. **复用成本最低，功能零损失**。`loadFile` + 两处一行级改动即可上线；localStorage、云桥 `wss://`、明暗主题全部免费。Tauri 还要处理 CSP 与 scheme 细节，.NET 要避开 https 虚拟主机映射陷阱。
3. **工具链与仓库同构**。relay 全 TS/Node，Electron 主进程也是 TS/Node，CI 一条命令出 NSIS。作者虽有 C# 经验（inject.cs），但那是"运行时 csc 编译小工具"形态，不足以摊平 WinForms 壳 + Velopack 的配套开发量。
4. **分发与更新生态最成熟**。electron-updater + 自托管 latest.json（可直接放阿里云 ECS）当天可用；SmartScreen 问题三种方案同样存在（见 9.2），不构成区分项。

### 次选与备选的适用条件

- **B. Tauri 2.x**：若后续对体积/内存真正敏感（例如要随 U 盘分发、或与 relay 打包成统一下发物），或项目决定上 macOS 桌面端。届时注意 4.4 的 CSP/scheme 清单。
- **C. .NET WebView2（net48）**：若二期/三期想做"PC 端一体化"（托盘 + relay 守护 + 注入器 + UI 壳合并为单一 C# 原生程序），C1 是唯一顺势路线，且体积最小。作为战略备选保留，不用于首期。

### 8.1 反方观点（选 Tauri 的人会怎么反驳，及回应）

- **"100MB 太重"** —— 回应：目标机器是开发用 PC，不是树莓派；磁盘税一次性，Rust 技能税持续。
- **"Electron 每年 6+ 个大版本，追不动"** —— 回应：壳里只有静态 HTML，无 native 模块、无 Node API 依赖，升级 = 改一行版本号重打包，回归测试成本接近零（这正是"壳越笨越稳"）。
- **"Tauri 体积小，开源项目观感好"** —— 回应：成立。若项目后续看重 star/传播观感，可在二期用同一份 UI 平行出 Tauri 包（前端零改动），两壳共存试水，这正是 UI 与壳解耦的收益。

### 8.2 一期 / 二期范围划分

| 阶段 | 范围 | 明确不做 |
|---|---|---|
| 一期（PoC → 可用） | Electron 壳 + 两处 UI 小改 + NSIS/zip 产物 + 10.2 用例 1–7 | 自动更新、代码签名、开机自启、多语言 |
| 二期 | electron-updater 自托管更新源（ECS）+ 灰度通道 + 签名评估（Artifact Signing）+ 体积/内存实测调优 | 微软商店、macOS 版 |
| 三期（可选） | Tauri 平行包试水，或转 .NET net48 做 PC 端一体化 | — |

分批理由：更新与签名都不阻塞"本地可用"，而两者各有一堆外部依赖（ECS 带宽、订阅、身份验证周期），拆出去能让一期以天为单位交付。

---

## 9. 二期注意事项

### 9.1 自动更新落地

- 方案：electron-builder NSIS + electron-updater，generic provider 指向自托管 `latest.yml` + 安装包（GitHub Releases 国内不稳；阿里云 ECS 8.133.211.170 已有云桥链路可复用，注意带宽与目录隔离）。
- 发布流程（CI 一条流水线）：打 tag → GH Actions 出 NSIS + blockmap + latest.yml → 同步脚本推到 ECS 目录 → 客户端启动时 GET latest.yml 比对版本。
- 记得开启差量（blockmap 默认随 NSIS 产物生成）；更新源 URL 允许用户在设置里覆盖。
- Squirrel.Windows 路线不要再投入（Electron 官方与 electron-builder 均已转向 NSIS，见 3.4 来源）。

### 9.2 SmartScreen 与代码签名现状（2026）

- **未签名 exe 首次运行必现"Windows 已保护你的电脑"**：SmartScreen 按文件哈希累积信誉，**每次重新构建信誉清零**；用户需"更多信息 → 仍要运行"；企业策略可彻底禁掉"仍要运行"（[MS Learn: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)、[Rick Strahl 2026-06 实战文](https://markdownmonster.west-wind.com/blog/posts/2026/Jun/01/Windows-Protected-your-PC-Dealing-with-Windows-SmartScreen-on-Installation)、[BCS 分析](https://www.bcs.org/articles-opinion-and-research/what-happens-when-microsoft-defender-flags-your-software/)）。
- zip 打包分发是社区常用缓解，但 Win11 下从带 MOTW 的 zip 解压会继承标记，**只能减不能除**（效果待验证）。
- 正式解法：
  - **Azure Artifact Signing**（原 Trusted Signing）：$9.99/月 Basic（5000 次/月），微软推荐的商店外分发签名服务，SmartScreen 信誉效果好（非绝对，仍有签了名先弹窗的个案，[MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5861538/azure-trusted-signing-still-seeing-smartscreen-war)）；**个人开发者需 3 年以上可验证身份历史**（[定价](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)、[公告](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)）。
  - 传统 OV/EV 证书 $200–500+/年，且 **EV 也不再保证即时信誉**（[DigiCert 公告](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings)）。
  - 微软商店分发免 SmartScreen，但开源内部工具走商店性价比低。
- 建议：首期接受弹窗 + README 引导截图；若分发面扩大，订阅 Artifact Signing。

### 9.3 安全清单（壳化后新增面）

- **token 暴露面**：`BAKED_BRIDGE_TOKEN` 为设计内公开的公共桥准入令牌（代码注释明确：桥只转发密文、垃圾密文帧 relay 全丢弃，真正边界是配对码），exe 分发不放大风险；LAN relay 令牌在 localStorage 明文——壳的 user data 目录与浏览器同机同盘、同账号可读，风险与现状持平，不额外加码。
- Electron 主进程安全基线：保持 `contextIsolation: true`（默认）、**关闭 `nodeIntegration`**（纯渲染 UI 不需要 Node）、`sandbox: true` 可开；不加载任何远程内容（UI 全部本地文件，云桥只走 WS 数据通道），CSP 可锁 `default-src 'self'` + `connect-src ws: wss:`。
- 远程地址手填框保留"数据将发往该地址"的明示（现有 UI 已是明文 URL，风险自担模型，不额外加码）。

### 9.4 更新分发节奏与回滚

- 更新检查频率：启动时 + 每 6–12 小时一次即可（工具型应用无需更激进）；提供"跳过此版本"按钮。
- 灰度：`latest.yml` 放两个通道（stable / beta，不同文件名），同事群先吃 beta。
- 回滚：自托管目录保留历史版本安装包 + 对应 yml，downgrade 让用户手动装旧包（electron-updater 不支持自动降级，属已知限制）。
- 断更兜底：更新源不可达时静默跳过，绝不阻塞使用（离线场景本来就是本项目卖点之一）。

### 9.5 备选迁移路径（Electron → Tauri，若三期试水）

- 前端资产完全复用：`index.html` + `nacl.js` 拷入 `frontendDist` 目录即完成迁移（相对路径改动两壳通用）。
- 需要新做的：Rust 工程脚手架（`tauri.conf.json` 的 CSP 放开 `ws://*:*`、保持 `useHttpsScheme` 为默认 false）、图标、CI 模板（tauri-action）、updater 密钥对。
- 预估工作量：熟悉工具链 0.5–1 天 + 打通 CI/更新 1 天，UI 零改动。即"两壳共存"成本可控，本决策不锁死 Tauri 路线。

### 9.6 待验证清单（PoC 时逐项打勾）

| # | 项 | 风险 |
|---|---|---|
| 1 | Electron `file://` 页面连 `ws://localhost:8787` 实测（含自动重连、query token 传参） | 低，社区常见路径 |
| 2 | Electron 44.2.0 发布状态与当前 stable 精确版本（releases 页当日核对） | 低 |
| 3 | Tauri 各 crate 最新 patch 号（版本独立演进，无单一"最新版"） | 低 |
| 4 | https origin（Tauri `useHttpsScheme:true` / WebView2 虚拟主机映射）下 `ws://localhost` 是否被当前 WebView2/Chromium 拦截（规范视 loopback 可信，实现历史不一致，[chromium#40091652](https://issues.chromium.org/40091652)） | 中，影响 Tauri/C 的加载方式选择 |
| 5 | 公司环境 Win10 LTSC / 精简系统是否存在 WebView2 缺失（影响 B/C 可行性下限） | 中 |
| 6 | 三方案空闲内存实测（本文数字均来自社区基准） | 低 |
| 7 | zip 分发对 SmartScreen 首弹的实际缓解率（Win11 MOTW 继承） | 中 |
| 8 | WebView2 SDK 对 net48 的最低支持口径（NuGet targets 核对） | 低（仅影响 C 路线） |

---

## 10. 首期 PoC 验收清单（描述性，不含实现代码）

### 10.1 应用骨架（Electron，约 4 个文件）

- `desktop/main.js`：建窗口（初始 1200×800，min 960×640）、`loadFile('web-console/index.html')`、注册托盘（关闭到托盘，退出走托盘菜单）；无其他逻辑。
- `desktop/package.json`：electron + electron-builder 依赖，`build.win.target = nsis`，appId/产物名 CC Deck 规避商标（沿用现有定名）。
- UI 侧仅两处改动（改在 web-console，壳与浏览器托管页共用同一份）：
  1. "本机直连"服务器条目 wsUrl 为空时，运行环境是桌面壳（可用 UA 或注入的全局标记判断）则预填 `ws://localhost:8787/ws`；
  2. `<script src="/nacl.js">` 改为相对路径 `"nacl.js"`（对 http 托管页无影响，根路径解析结果相同）。
- 构建产物：NSIS 安装包 + portable zip 各一。

### 10.2 功能验收（逐项打勾）

| # | 用例 | 通过标准 |
|---|---|---|
| 1 | 首启连接 | 未填地址时预填 `ws://localhost:8787/ws`，relay 在跑则 3s 内转"已连接" |
| 2 | 断线重连 | 杀掉 relay，UI 转"等待"，重启 relay 后自动恢复且 `last_seq` 补拉无丢事件 |
| 3 | 多服务器 | LAN 与云桥条目切换、token 持久化、重启后记忆完整 |
| 4 | localStorage 迁移 | 主题/缩放/服务器列表在 exe 重启后保留 |
| 5 | file:// + WS | 无混合内容/CSP 报错（关闭 9.6#1） |
| 6 | 托盘行为 | 关窗到托盘、托盘退出、双击恢复 |
| 7 | 远程地址 | 手填局域网 IP 的 ws 地址可连（数据不出局域网验证） |
| 8 | 更新链路（可延后到二期） | latest.yml 放 ECS，旧版能发现新版并完成安装 |

### 10.3 决策复盘触发条件（出现任一即重开本议题）

- 目标用户出现 WebView2 缺失且拒绝安装运行时的机器（B/C 加分）；
- 分发诉求变为 U 盘/网盘零安装小体积包（B/C 加分）；
- 项目决定 PC 端与 relay 注入器合并为单一原生程序（C 加分，直接转 5.7 路线）；
- Electron 某版本出现影响 file:// + WS 的破坏性变更且短期无解（B 加分）。

## 11. 参考来源汇总

**Electron**：[releases.electronjs.org](https://releases.electronjs.org/) · [GitHub Releases](https://github.com/electron/electron/releases) · [endoflife.date](https://endoflife.date/electron) · [性能指南](https://electronjs.org/docs/latest/tutorial/performance) · [体积 SO#47866495](https://stackoverflow.com/questions/47866495/electron-builder-app-size-is-too-large) · [boilerplate#795](https://github.com/electron-react-boilerplate/electron-react-boilerplate/issues/795) · [Gowombat 优化文](https://medium.com/gowombat/how-to-reduce-the-size-of-an-electron-app-installer-a2bc88a37732) · [Squirrel→NSIS: forge#3069](https://github.com/electron/forge/issues/3069) / [forge#3598](https://github.com/electron/forge/issues/3598) / [electron-builder](https://www.electron.build/docs/squirrel-windows/)

**Tauri**：[v2.tauri.app](https://v2.tauri.app/) · [Ecosystem Releases](https://v2.tauri.app/release/) · [Webview Versions](https://v2.tauri.app/reference/webview-versions/) · [Windows Installer](https://v2.tauri.app/distribute/windows-installer/) · [CSP](https://v2.tauri.app/security/csp/) · [配置参考](https://v2.tauri.app/reference/config/) / [config.schema.json](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-schema-generator/schemas/config.schema.json) · [websocket 插件](https://v2.tauri.app/plugin/websocket/) · [#7701](https://github.com/tauri-apps/tauri/issues/7701) · [#3007](https://github.com/tauri-apps/tauri/issues/3007) · [#11081](https://github.com/tauri-apps/tauri/issues/11081) · [#9699](https://github.com/tauri-apps/tauri/issues/9699) · [2026 体积对比](https://tech-insider.org/tauri-vs-electron-2026/) · [Digital Applied 2026](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026) · [rustify 2026](https://rustify.rs/articles/rust-tauri-v2-desktop-app-tutorial-2026)

**WebView2 覆盖**：[MS Learn: Distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) · [Edge 博客 2022-06](https://blogs.windows.com/msedgedev/2022/06/27/delivering-the-microsoft-edge-webview2-runtime-to-windows-10-consumers/) · [Edge 博客 2022-12](https://blogs.windows.com/msedgedev/2022/12/14/delivering-webview2-runtime-to-managed-windows-10-devices/) · [ZDNet](https://www.zdnet.com/article/microsoft-were-bringing-edge-webview2-to-more-windows-10-devices-and-heres-why/)

**.NET / Velopack**：[.NET 支持策略](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) · [发布概述](https://learn.microsoft.com/en-us/dotnet/core/deploying/) · [WebView2Feedback#3866](https://github.com/MicrosoftEdge/WebView2Feedback/discussions/3866) · [velopack.io](https://velopack.io/) · [velopack/velopack](https://github.com/velopack/velopack) · [Velopack.Build NuGet](https://www.nuget.org/packages/Velopack.Build/)

**SmartScreen / 签名**：[MS Learn: SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) · [Rick Strahl 2026-06](https://markdownmonster.west-wind.com/blog/posts/2026/Jun/01/Windows-Protected-your-PC-Dealing-with-Windows-SmartScreen-on-Installation) · [BCS](https://www.bcs.org/articles-opinion-and-research/what-happens-when-microsoft-defender-flags-your-software/) · [Artifact Signing 定价](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/) · [Trusted Signing 个人开放公告](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554) · [签名后仍弹窗个案](https://learn.microsoft.com/en-us/answers/questions/5861538/azure-trusted-signing-still-seeing-smartscreen-war) · [DigiCert EV 公告](https://knowledge.digicert.com/alerts/ev-signed-application-showing-microsoft-defender-smartscreen-warnings)

**混合内容 / WS**：[MDN Mixed Content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content) · [chromium#40091652](https://issues.chromium.org/40091652) · [WebKit#171934](https://bugs.webkit.org/show_bug.cgi?id=171934) · [Damir's Corner](https://www.damirscorner.com/blog/posts/20210528-AllowingInsecureWebsocketConnections.html)

**Flutter / NativeScript**：[flutter#182137](https://github.com/flutter/flutter/issues/182137) · [flutter#31713](https://github.com/flutter/flutter/issues/31713) · [softaims 2026](https://softaims.com/blog/flutter-web-desktop-production-ready-2026) · [nativescript.org](https://nativescript.org/) · [rfc#11](https://github.com/NativeScript/rfcs/discussions/11)

---

*本文档仅做选型决策记录，不含实现代码。首期实施按第 8 节推荐执行，PoC 时同步关闭 9.6 待验证清单。*
*维护约定：版本号 / 覆盖率 / 价格等时效性数据以本文调研日期（2026-09-04）为准，重开议题或实施前应复核第 11 节来源。*
