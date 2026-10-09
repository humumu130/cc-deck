B1 新壳及 SNAPSHOT 会话列表已交付，结构、样式和隔离模拟测试通过；真实 relay 起服及无头浏览器验证受当前环境阻断，结论为 B1-BLOCKED，不能视为完整运行验收通过。

## 改动文件清单

仅新增两个交付文件：

1. `web-console/index-005.html`：逐字搬运 005 原型的样式与 DOM，保留壳交互，增加同源 LAN WebSocket / SNAPSHOT 会话列表。
2. `specs/005-port-B1-report.md`：本报告。

`specs/005-port-B1-task.md` 在开工时已存在且未跟踪，本 worker 未修改。未修改旧 `web-console/index.html`、原型或 relay 源码；未执行 git add / commit、构建插件；未访问 `/Applications`，未连接或操作 8787 / 8788。未读取真实 token / 密钥文件。临时验证脚本、数据、日志均放在 `/tmp`，不计入仓库交付文件。

## 三件自测结果

### 1. 结构锚点与样式：通过

- grep/rg 逐域断言 `rail-btn[data-domain]` 的 session / team / project / notify / settings 五钮与 `#d-session` / `#d-team` / `#d-project` / `#d-notify` / `#d-settings` 齐全。
- 六个 mobile screen：`#m-inbox`、`#m-detail`、`#m-team`、`#m-project`、`#m-notify`、`#m-settings` 均保留。
- 静态 DOM 中 18 个 SVG symbol 的 ID、顺序和原始内容一致；原型 `ensureThemeSymbols` 中另外 12 条 symbol 声明也原样保留，合并去重共 25 个 ID。没有新增图标系统。
- 整个 `<style>` 块逐字节一致，无样式偏差。SHA-256：`31444536d56e566e1bcc582b61c1e9c32275d92ad2166db15403738aceb6094d`。
- 提取样式至 `/tmp/005-b1/prototype-style.txt` 和 `/tmp/005-b1/index-style.txt`，`diff -u` 无输出、退出码 0。
- 从脚本前的 HTML 移除下表备案的 `data-stub` / `data-relay-state` 属性后，与原型脚本前的全部 HTML 逐字节一致；不是只检查五个 ID。
- 内联脚本通过 Node `vm.Script` 语法检查。11 个原型壳函数与 5 条会话渲染声明的原样拷贝断言通过（仅剔除原型的独立注释行）。

补充隔离模拟测试：`node /tmp/005-b1-verify.cjs` 全部通过，结果保存在 `/tmp/005-b1/verification.txt`。覆盖空 SNAPSHOT、四态会话分组与计数、引擎徽标、文本转义、工作计时、行选中、权威快照替换、断线退避、新连接不带 last_seq、页面离开清理、HTTP/HTTPS 同源 URL、测试凭据保存与 URL 清理、缺凭据和 file:// 不探测任何端口、浅/深主题存储、segment ARIA 状态与方向键切换。

上述协议与交互测试使用 VM / DOM / WebSocket 替身；测试数据只在 `/tmp` 脚本内，未写入交付页面，也没有创建真实沙盒会话。它们不替代下面的真实 relay 与浏览器测试。

### 2. 沙盒起服：阻断

按任务书在 relay 目录执行 `npm run dev`，端口 8795、data 为 `/tmp/005-b1/data`、org 为 `/tmp/005-b1/org`、使用任务书给定的开发测试令牌。同时加以下隔离环境，防止影响用户配置、真实 Leader 或局域网设备：

| 附加环境 | 原因 |
| --- | --- |
| `CLAUDE_CONFIG_DIR=/tmp/005-b1/claude` | relay 的任务工具配置兜底只写沙盒目录，不写用户 Claude 配置 |
| `CCR_NO_LEADER=1` | 不首建或拉起真实 Leader CLI |
| `CCR_NO_MDNS=1` | 不发布沙盒实例给局域网设备 |
| `CCR_NO_BRIDGE_MIRROR=1` | 不覆盖生产 hooks 桥接配置 |
| `CCR_NO_TITLE_GEN=1` | 禁用标题生成的外部调用 |
| `CCR_CLOUD_URL=''` | 不连接默认云桥 |

尝试及结果：

1. 规定的 `npm run dev`：tsx 在创建临时 IPC pipe 时失败，`listen EPERM: operation not permitted .../tsx-501/12027.pipe`。日志 `/tmp/005-b1/relay.log`。
2. 以 `node --import tsx src/index.ts` 绕过 tsx CLI 的 IPC：该目录所选 Node 24 ABI 137 与已安装 better-sqlite3 的 ABI 127 不匹配。未重装依赖或更改源码。日志 `/tmp/005-b1/relay-direct.log`。
3. 指定已有兼容 Node 22：`/Users/xdd/node/bin/node --import tsx src/index.ts`。绕过 ABI 问题，但实际监听失败：`listen EPERM: operation not permitted 0.0.0.0:8795`。启动横幅并不能证明 HTTP 已开始监听。日志 `/tmp/005-b1/relay-node22.log`。
4. 兼容 Node 启动尝试后超过 60 秒再 curl，根路径返回 HTTP `000` / connection refused，未取得 200；`/index-005.html` 同样不可连接。没有访问生产端口兜底。

伺服路径备案：现有 `relay/src/ws-server.ts` 根据 webRoot 读取 `web-console/index.html` 并仅把它映射到 `/`；没有任意 `index-*.html` 的静态 HTML 路由。B1 铁律禁止修改 relay，因此不能把 `/index-005.html` 的可达性或生产入口切换声称为已完成。浏览器改为尝试 `file:///Users/xdd/dev/cc-deck-m1/web-console/index-005.html` 加载本地新壳；同旧入口口径，file:// 不推导 relay host，也不探测 8787 / 8788，只显示未配置空态。真实绑定最终仍需要同源 HTTP(S) 伺服，并把 `/ws` 指向对应 relay。

清理：定位到持有沙盒日志的 relay PID **14701**，定点 `kill -TERM 14701` 被环境拒绝（EPERM），随后仅中断对应执行会话 **80722**，工具确认进程退出；另一个启动尝试的执行会话 **47453** 也确认已退出。最终 `lsof` 检查两个 relay 日志均无持有进程，8795 无监听。未使用按名称/范围的 kill，未留下沙盒 relay。

### 3. 无头浏览器：阻断

- 使用规定路径 `/usr/local/bin/playwright`，以 Chromium、1600×1100、等待 1500ms，尝试打开上述 file:// 新页面并截图至 `/tmp/005-b1-shot-desktop-dark.png`。
- 首次 CLI 失败：当前 Playwright 期待缓存 revision 1208，但该可执行引擎不存在；系统已有缓存 revision 1243。日志 `/tmp/005-b1/playwright-cli.log`。
- 未下载浏览器或改动系统缓存；只在 `/tmp/005-b1/browsers` 建立指向已有缓存的临时链接，以 `PLAYWRIGHT_BROWSERS_PATH` 再运行同一个 CLI。浏览器 PID 16168 在加载页面前以 SIGTRAP 退出，CLI 报 `Target page, context or browser has been closed`，并记录 thermal notification 注册失败 Result 9。日志 `/tmp/005-b1/playwright-cached.log`。现有信息不足以认定 SIGTRAP 的确切原因，不能把它算成页面自身的 console error。
- 同一 Python Playwright SDK 直接指定已有引擎的启动也失败，未得到可用浏览器上下文。
- 因浏览器未能打开页面，**无 console error、五钮可见、列表正常渲染的真实浏览器断言均未完成**；**截图未生成**。没有用模拟测试或空白图冒充浏览器验收。
- Playwright 日志确认其浏览器进程已退出并清理临时目录。

## 偏差备案表

以下位置均指 `web-console/index-005.html`；原型位置用于追溯。除此之外，style 和脚本前 DOM 没有改动。

| 编号 | 位置 | 原因 | 内容 |
| --- | --- | --- | --- |
| D01 | `#d-session .queue-head`、`.session-list-tools`、`.workspace`、`.inspector` | 本批只绑定列表，其余会话业务待迁 | 仅添加 `data-stub="B2"`；原型文本、节点、class 和内联样式保持不变 |
| D02 | `#d-team` 及 rail 团队 badge | 团队与角标尚未绑定 | 仅添加 `data-stub="B3"`，保留原型占位 |
| D03 | `#d-project` | 项目聚合尚未绑定 | 仅添加 `data-stub="B4"`，保留原型占位 |
| D04 | `#d-notify` 及 rail 通知 badge | 通知与角标尚未绑定 | 仅添加 `data-stub="B5"`，保留原型占位 |
| D05 | `#d-settings` | 设置尚未绑定 | 仅添加 `data-stub="B6"`，保留原型占位 |
| D06 | `#stage-mobile`、全部 `.source-switcher` | 手机数据与多源管理不在本批 | 仅添加 `data-stub="B7"`，保留整个 mobile DOM 和来源占位；源切换器的样例名称/计数不是真数据 |
| D07 | `#d-session [data-session-list]` | 标记真实数据组件就绪状态 | 在既有空列表容器仅添加 `data-relay-state="loading"`；运行时补充连接态、快照态与会话数属性 |
| D08 | 原型脚本 L1206–3359 | 演示注入会覆盖真实会话列表，其他业务超出 B1 | 不搬运该脚本中除 D09 明确保留的函数/声明以外的内容；移除演示 session/source/notification/team/artifact 数据、demo 空/加载/错误注入、伪重连/审批/收单/下载/发送/设置执行、搜索/来源过滤、右键菜单及各类演示 hydrate/normalize 链。其余区域的原始静态 DOM 保留并按 D01–D06 标记 |
| D09 | 新脚本的原型壳与行渲染部分 | 保留要求的交互和视觉模板 | 从原型原样拷贝 `ensureThemeSymbols`、`applyTheme`、`wireSegmentTabSemantics`、`wireSegmentTabs`、`setInspectorCollapsed`、`applyInspectorBreakpoint`、`initInspectors`、`showToast`、`setMode`、`setDesktopDomain`、`openMobileRoot`，以及 `engineIconFor`、`engineBadgeMarkup`、`sessionSourceColor`、`sessionCtaMarkup`、`renderSessionCard`；仅剔除原独立注释行。保留原主题存储键 `cc-deck-theme`。没有自创行样式 |
| D10 | `setupStubTabs` | 原型专用 tab setup 会动态注入大量演示业务数据 | 用原 `.workspace-pane` 包装当前静态内容并保留原 active 索引；其他 tab 使用原 `.readonly-banner` 展示“标签名 · 原型占位，待 Bx 迁移”，添加对应 stub 属性；仍调用原 `wireSegmentTabs`，保留 ARIA/方向键交互 |
| D11 | `connectLan` | 复用现有 LAN 协议而不引入完整 v1 前端 | 从旧 `web-console/index.html` L3593–3639 拷贝 LAN 连接、8 秒握手看门狗、onopen/onclose/onerror、JSON 帧解析与 seq 记录；剔除独立注释。三个功能调整：缺配置分支调用新 `setConn` 而非 v1 服务器列表函数；URL **不带 last_seq**，每次重连请求全量快照，因为 B1 不消费增量事件；COMMAND_ACK 只忽略，不调用 v1 `onAck` |
| D12 | `const params`、`wsUrl`、`relayToken` 初始化 | 对齐旧入口的 token/端口及地址栏清理口径 | 使用旧入口 L12228–12230 的 URLSearchParams 与 HTTP→ws / HTTPS→wss 同源 host + `/ws` 推导；端口取页面 host，无硬编码/本机探测。保存测试/用户输入凭据到本页面同源的独立键 `cc-deck-005-token`，支持刷新；只删除地址栏 token 参数，保留其他 query/hash，不接入 v1 多源库或云桥 |
| D13 | `ctx`、`setConn`、`scheduleReconnect`、`onEvent` | 最小连接状态和快照投影 | 新增单源内存 Map、1000ms 起步/30000ms 上限重连退避、既有连接 chip/source-dot 状态 class 更新；仅 SNAPSHOT.payload.sessions 替换列表，忽略其他业务帧；pagehide 清理本页面 socket 和定时器。不发送任何 COMMAND |
| D14 | `escapeHtml`、`sessionItem`、`renderSessionList`、计时器 | 用真实字段填充原型行模板 | 按 WAITING/ERROR 与其他会话分组；使用真实标题/摘要/cwd、引擎、relay 名、更新时间、置顶和 turn_started_at。文本/属性先转义，再传给原型 renderer；工作计时由真实回合起点计算；空/等待/缺配置态使用已有 readonly-banner，不增加 CSS |
| D15 | 会话行选中与 `.srow-cta`、全局事件路由 | 不把原型按钮伪装成真实审批、发送或管理 | 点击真实行只切换选中 class，不更新仍为 B2 占位的详情；“处理”按钮增加 B2 stub/aria-label 并提示待迁；其他 stub 按钮仅提示待迁。保留 rail、视口模式、主题、mobile root、检查器、Escape 关闭叠层事件；不执行原型的伪业务动作 |
| D16 | 自测启动命令、伺服方式和 Playwright 引擎选择 | 原规定路径受到 IPC/ABI/监听/浏览器启动限制 | 追加前述隔离环境，尝试直载 tsx 与兼容 Node；只尝试 file:// 页面及 `/tmp` 缓存映射，不改 relay 路由、不安装依赖、不切换生产入口。所有失败和未完成断言如实列出 |

B2–B7 为本文件的待迁定位标签，任务书未给出后续正式派单映射；Leader 可在后续批次确认，不表示本 worker 已实现这些区域。

## 遗留问题

1. 必须在允许本地监听与启动 Chromium、Node/原生模块和浏览器缓存版本一致的环境，重新完成真实 relay 根路径 200、同源新壳可达、实际 SNAPSHOT 和浏览器三项断言，并输出 `/tmp/005-b1-shot-*.png`；当前报告不能替代该运行验收。
2. 现有 relay 不伺服 `/index-005.html`。后续需由 Leader 明确同源并行入口/反向代理方案；B1 未越权修改 relay 或旧根入口。
3. 本批只消费全量 SNAPSHOT；在线增量会话变化待后续迁移，断线重连以全量 SNAPSHOT 收敛。断线期间保留最近快照，但列表的 `data-connection` 明确标记 offline。
4. 详情/任务/产物/用量、搜索与新建、团队/项目/通知/设置、mobile 数据、多源管理及角标均是明确标记的原型占位，不是实际可执行功能；B1 不强造真实会话或真实业务动作。
5. 页面同源凭据沿用旧端明文 localStorage 的持久化口径，但使用独立 B1 键；file:// 或无同源凭据的首次 HTTP 加载只展示配置提示，不自行连接其他端口。

## B1FIX（#143-B1FIX）

结论：窄视口的框架减宽 class 已修复，缺失的原型密度初始化和检查器启动顺序已恢复，静态/隔离 DOM-class 回归断言通过；本轮不启动 relay、不截图，390px / 1440px 的最终像素复验由 Leader 完成。

### Leader 验证反馈与历史记录更正

- 据本轮派单，Leader 已通过 `CCR_WEB_ROOT=/tmp/005-b1/webroot` 将新壳副本作为 8795 的根页面同源伺服，并使用系统 Chrome headless 对比：1440px 高度一致无 P1，390px 出现框架硬裁切及标题栏截断。此为 Leader 提供的结果，不是本 worker 自行完成的浏览器验证。
- 因而此前“当前 relay 不能直接提供 `/index-005.html`”的路由说明仍成立，但**不应理解为不能通过 CCR_WEB_ROOT 覆盖目录、以副本作为 `/` 验证**；这一可用伺服方案补录于此。前面的 B1-BLOCKED 及自测失败描述保留为首轮历史记录。

### 初始化链回读与根因定位

逐项检查原型 L3299–3357 的完整启动序列，并回溯 L1206–3359 中模式切换、检查器 class、resize 和 hydrate 的相关定义/调用，发现需要纠正派单中的一部分根因假设：

1. 原型 `setMode` 仅有定义 L3047，以及点击视口按钮时的调用 L3177；**没有原型启动时的 setMode 调用点**。初始 desktop mode 来自原型 DOM 的 active class（L1090、L1094），不是按 390px 自动切换 mobile。原 B1 已保留 L3177 对应点击调用，因此不能把本轮新增的显式模式初始化虚称为恢复了一个不存在的原型启动调用。
2. 原型 `initInspectors()` 位于 L3356，内部 L2636 调 `applyInspectorBreakpoint()`，L2637 注册 resize。首轮 B1 这三个执行点已经存在，并非只复制函数定义；但把 initInspectors 提前到了 applyTheme 之前。本轮恢复其位于主题/密度初始化之后的相对顺序，并保留内部两个原样调用点。
3. 可静态坐实的减宽路径为：`initInspectors → applyInspectorBreakpoint`（L2614 判断 ≤1279px）→ `setInspectorCollapsed`（L2607 给 active screen 的 frame 加 class）→ CSS L302 `.desktop-frame.inspector-collapsed { width: calc(100% - 278px); }`。原型 ≤980px 的滚动规则位于 L1062–1065，只有 overflow-x / 子层 min-width，没有覆盖这一 frame 减宽规则。因此**单纯补一个 setMode 调用或移动 initInspectors 时序，不能排除硬裁切**。
4. 本轮不改任何样式，而是在两个 frame class 写入点（折叠/resize 与 rail 域切换）使用原 CSS 的 980px 边界：≤980px 保留 screen/inspector 的折叠状态，但不向外层 frame 添加 inspector-collapsed。由既有 `width: 100%`、`overflow-x: auto` 和 windowbar/desktop-shell 的 `min-width: 1120px` 接管窄屏窗口与横向滚动。此为必要的响应式逻辑偏差，明确备案 D18；不能冒充原型原样代码。

### 本轮偏差备案（追加 D17–D20）

以下记录更新/补充历史 D08–D09；旧表的“原样拷贝”结论在本轮修改的两个 frame class 写入函数上，以 D18 为准。

| 编号 | 位置 | 原因及内容 | 原型追溯 |
| --- | --- | --- | --- |
| D17 | 壳启动序列、`applyCardDensity`、`wireCardDensityControls`、检查器点击分支 | 原样恢复 `savedCardDensity` 的读取、两个密度 helper，以及 `wireCardDensityControls();`、`applyCardDensity(savedCardDensity);` 调用；保留 `applyTheme(savedTheme);`，把已存在的 `initInspectors();` 移回其后，内部 breakpoint 调用和 resize 注册保持原样。额外从 DOM 当前 active mode button 调用既有 `setMode(modeButton.dataset.mode)`，不按宽度强制 mobile；这一步是新增初始化，不是假称原型已有启动调用。原样恢复窄窗口中禁止展开已折叠检查器的点击 guard | 密度读取 L3303–3304；helper L1409–1424；调用 L3338、L3343–3344、L3356；内部调用 L2636–2637；mode 函数 L3047–3057、点击调用 L3177；检查器点击 L3283–3291 |
| D18 | `setInspectorCollapsed`、`setDesktopDomain` 两处外层 frame class 同步 | 两处均追加 `&& !window.matchMedia("(max-width: 980px)").matches`。只禁止 ≤980px 的 frame 减宽 class，保留原 ≤1279px 检查器折叠、>980px 的窗口折叠、手动状态及 rail/resize 联动。不添加 inline width、overflow 或新 CSS，不改任何字体、间距、颜色、圆角 | class 写入 L2607、L3066；原减宽 CSS L302；窄屏滚动 CSS L1062–1065 |
| D19 | `#d-session .queue-card` 底色/selected 来源核对；本轮未改 | 原型普通行底色由 CSS L872 的 `background: none` 设置（透明），hover/selected 分别由 L876–877 的 `--q-row-hov` / `--q-row-sel` 设置，不是 hydrate。原型 renderSessionCard 根据 item.selected 插入 selected（L1250），演示数据 release 在 L1233 初始 selected=true；真列表按 ctx.selectedSessionId，首次快照未主动选择时无 selected，点击后再选中，沿用 D15 的“不伪装详情绑定”。另有 L879–880 对演示 id `mobile` 的特殊 danger 底色；真实 relay ID 不应映射成该演示 ID，所以 ERROR 行不保证具有此演示专属底色。hydrateAvatars/hydrateSourceBadges 只操作头像/来源徽标，不设置会话行底色或初始 selected | renderer L1250；演示 selected 数据 L1233；普通/hover/selected/danger CSS L872、L876–880；hydrate 定义 L1678–1713、L1893–1899 |
| D20 | 1440px 检查器头部「‹」初始显隐核对；本轮未删除按钮 | 原型 initInspectors 为每个存在 inspector 的 workspace prepend 一个按钮（L2627–2634），applyInspectorBreakpoint 在 1440px 默认未手动折叠时设置 expanded，按钮文字为「‹」（L2608）。CSS L455 明确 display:grid；不存在 demo hydrate 把该按钮隐藏的路径。实现使用同一个原型函数，启动只调用一次，mode/rail/resize 不重复创建按钮；不是实现额外多渲染一个，因此不人为删除/隐藏原有控件。若原型截图在 1440px 没有该按钮，源码本身不足以证明原因，需 Leader 核对该页面是否执行到 L3356、手动状态及 active workspace，不能虚报为 hydrate 所致 | 按钮创建 L2626–2637；文字 L2608；显隐 CSS L455、L457–459；初始化 L3356；本轮仅调整启动顺序 |

### 本轮静态与回归自测

- `<style>` 与原型逐字节一致，SHA-256 仍为 `31444536d56e566e1bcc582b61c1e9c32275d92ad2166db15403738aceb6094d`。去除首轮备案属性后，脚本前的完整 DOM 仍逐字节一致；五域 rail/workspace、六个 mobile screen 和 SVG symbol 断言通过。
- 内联 JS 语法检查通过；恢复的两个 density helper 与原型逐字一致。原保留的 11 个壳函数经比对通过，其中 D18 涉及的两个函数仅在移除备案的 980px 条件后按原样比对；5 条行 renderer 声明仍逐字一致。
- 启动顺序断言通过：ensureThemeSymbols → setupStubTabs → wireCardDensityControls → applyTheme → applyCardDensity → 当前 DOM mode 的 setMode → initInspectors → 真列表/连接；启动块只有一个 initInspectors 调用。原型点击 guard、desktop 初始 active、既有 overflow-x / min-width 及行 selected/danger CSS 的 grep/匹配断言通过。
- 隔离 DOM/class 测试覆盖 **390 / 980 / 981 / 1279 / 1280 / 1440px**：≤980px frame 不含减宽 class，≤1279px inspector 仍折叠；981–1279px 保留原减宽行为；1440px 默认 expanded、「‹」且每个 inspector 只有一个按钮。各尺寸下均测试 rail 切换、390→1440 resize、mobile/desktop mode 往返，不重复插入检查器按钮；密度合法值与非法值回退测试通过。
- 首轮空/非空 SNAPSHOT、四态分组、文本转义、选中切换、权威快照替换、重连及主题/segment 测试继续通过。复用首轮 `/tmp` 测试脚本时，只在内存中适配 D18 的函数比较与新增 harness 导出，未改该脚本文件；本轮验证不连接任何真实端口。
- `web-console/index.html` 与原型的 git blob 分别仍为 `42e65394e811203303931cce33fe1e85697a7f3f`、`4f45df7a18177b620982396d7c2bba9ae85b2fb9`；仅改动本 HTML 和本报告，未 add/commit。

### Leader 待复验

请继续用已验证的 CCR_WEB_ROOT 同源根页面方案，在 390px 核对窗口框架不再命中减宽 class、标题栏不硬截断且可横向滚动，并复查 1440px 的初始宽度/检查器与真实列表。像素位置、真实滚动和截图结果不能由上述替身断言保证，本轮不声称已自行截图通过。
