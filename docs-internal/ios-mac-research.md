# iOS / macOS 支持可行性调研（backlog #166 / #167）

- 调研日期：2026-09-04
- 方法：代码盘点（expo-app/、relay/src/、web-console/、mobile/）+ 2026 年现状联网查证（来源见文末，正文以 `[n]` 标注）
- 目的：回答两个问题——**iOS 端值不值得做、怎么做最省**；**Mac relay 适配的最小改造清单 + 客户端形态**
- 阅读指引：只想要结论看 §0 和 §三；决策依据细节在 §1.1（iOS 分发硬约束）、§1.3（PWA 现状）、§2.1（relay 跨平台盘点）、§2.3（最小改造清单）。

---

## 0. 结论速览

| 问题 | 结论 | 一句话理由 |
|---|---|---|
| iOS 原生 App（#166） | **不做，PWA 优先** | 硬成本 $99/年 + 3 个原生模块重写/重设计 + "后台保活 WS"在 iOS 架构性不成立；网页端已具备 iOS 可用的全部关键机制 |
| iOS PWA | **做，是零新增架构的最省路径** | web-console 云桥模式在 iOS Safari 今天已可用；补 manifest + iOS 主屏 meta +（可选）Web Push 即成一等公民体验 |
| macOS relay（#167） | **做，最小改造约 3 处代码 + 文档** | WS 桥/hooks 桥/transcript 读取全部天然跨平台；仅终端注入、pid 探测两处有 Windows 假设，且已有降级行为 |
| macOS 客户端 | **浏览器 + Safari「Add to Dock」PWA** | 零开发成本获得独立窗口/图标/通知；壳应用（Tauri/Electron）当前无必要 |

---

## 一、iOS 部分

### 1.1 Expo/EAS 构建 iOS 的硬约束

#### 1.1.1 费用与账号体系（2026 年现状，与往年一致）

- **Apple Developer Program：$99/会员年**（个人/组织同价，可本地货币结算），是 App Store 分发、TestFlight、推送等服务的统一门槛 [1][2]。
- **免费账号**（Apple ID 即可）只能真机自签：
  - provisioning profile **7 天过期**，过期需重编译重装 [1]；
  - 社区经验值另有 10 个 App ID/周、3 台设备、每设备 3 个 app 安装上限 [3]（Apple 未在文档完整列出，以实测为准）；
  - 工具链上可用 AltStore/Sideloadly 等自动续签绕日常痛点，但本质仍是 7 天循环 [3]，对"发给别人用"完全不现实。
- **Apple Developer Enterprise Program**（$299/年）：面向大型组织内部分发；2025-2026 年社区普遍报告 **Apple 已停批新企业账号**，官方推荐路径转向 Apple Business Manager / Custom Apps [4][5]。个人开发者可视为不存在这条路。
- **个人不上架 App Store 的合法分发路径**对比：

| 路径 | 前置成本 | 设备/人数上限 | 维护摩擦 | 适合 |
|---|---|---|---|---|
| 免费自签 | $0 | 3 台（自己） | 每 7 天重签 | 仅开发自测 |
| Ad Hoc（付费账号） | $99/年 | 100 台/产品线/会员年，UDID 需逐台注册重打包 [6] | 高（每加一台设备重签） | 自用 + 少数亲友 |
| TestFlight | $99/年 | 内部 100 / 外部 10,000，build 90 天有效 [7] | 中（外部测试每版本首个 build 需 Beta Review [7]） | 开源项目给陌生用户分发的唯一"官方顺路"通道 |
| EU 替代分发/网页分发 | 2026-08 起资格放宽（100 万年安装量之外新增 $1M 备用信用证路径，CTF 取消改 5% 抽成）[8][9][10] | 仅限欧盟 | 中 | 不适用本项目（国内用户为主，EU-only） |

#### 1.1.2 构建工具链（Expo/EAS 视角）

- **EAS 云构建可全程无 Mac**：
  - iOS **模拟器** build 不需要任何 Apple 账号，云上跑 [11]；
  - **真机/生产** build 需要至少免费 Apple 账号签名（受限如上）；发布到 TestFlight/App Store **必须付费账号** [12][13]；
  - EAS 免费额度约 15 次 build/月（社区口径，以 Expo 官网当前定价为准）[12]。
- **本地 iOS 构建**（`eas build --local` 或裸 Xcode）必须 macOS + Xcode [11][13]。
- 本项目 Android 侧现状是 `expo run:android` + **debug.keystore 自签 APK 直发**（`expo-app/android/app/build.gradle` 中 release 仍用 debug 签名，versionCode 46 / 0.2.33），APK 直接挂在 relay `/m` 下扫码下载。**这条"自签直发"路径在 iOS 上不存在等价物**——这是两个平台最本质的分发差异，也是 #166 成本的根源。

#### 1.1.3 硬约束小结

iOS 原生分发的最低持续成本 = **$99/年 + TestFlight 每版本 Beta Review**（或 Ad Hoc 手工管 UDID）；免 Mac 可靠 EAS 解决，但解决不了签名与审核。对比 Android 侧"打 APK 放 /m 扫码即装"的零摩擦，成本结构完全不同量级。若上架 App Store 则另有周期性审核（CC Deck 形态的远程控制工具并非 App Store 禁区，但账号注册、审核沟通对个人开发者是不小的隐性成本，且不在本调研验证范围内）。

### 1.2 React Native 代码复用度评估

#### 1.2.1 JS 依赖层：全部跨平台，无障碍

`expo-app/package.json` 依赖清单：expo ~57.0.15 / react-native 0.86.2 / react 19.2.3，业务侧 async-storage、expo-crypto、expo-file-system、expo-image-manipulator、expo-image-picker、expo-linear-gradient、expo-status-bar、react-native-safe-area-context、tweetnacl——**全部官方支持 iOS**。Expo SDK 57 为当前正式版本（RN 0.86 / React 19.2），iOS/Android 双平台维护 [14]。E2E 加密（tweetnacl）、云桥协议、AsyncStorage 状态管理、UI 主题层可直接复用。

#### 1.2.2 本地原生模块层：3 个模块全部 Android-only，需重写或排除

`expo-app/modules/` 下三个自研 Expo 模块，`expo-module.config.json` 均声明 `"platforms": ["android"]`（只有 android/ 目录、无 ios/ 目录；autolinking 在 iOS 构建时自动跳过它们）：

| 模块 | Android 实现（代码盘点） | iOS 处置 | 工作量 |
|---|---|---|---|
| `relay-notify` | 前台服务（RelayForegroundService，START_STICKY）+ 通知渠道，保活 WS 连接 | **架构性不成立**：iOS 无常驻后台，需重设计为 UNUserNotificationCenter + 前台活跃期维持 WS。而"后台不掉线"恰是该模块的存在理由 | 重设计，1 周+ |
| `voice` | SpeechRecognizer 服务链（含无 GMS 国产 ROM 兜底、服务切换重试） | 需用 Speech 框架（SFSpeechRecognizer）**整体重写**；好处是 iOS 不存在"无默认识别服务"的坑 | 重写，3-5 天 |
| `wear` | Wear Data Layer（com.google.android.gms.wearable）手机网关，收发手表快照/命令 | **直接排除**：watchOS 与 Wear OS 互不相通，手表侧等于另一个完整项目（不在本调研范围） | 排除，0 |

**JS 调用层已做平台隔离**（代码盘点确认）：`src/notify.ts`、`src/voice.ts` 均为 `Platform.OS === "android" ? requireOptionalNativeModule(...) : null` 的空安全模式，iOS 构建不会因缺模块崩溃；通知权限申请同样有 `Platform.OS !== "android"` 短路。UI 层零散使用 `BackHandler`（iOS 需换交互）与 `android_ripple`（iOS 自动 no-op，无害）。

#### 1.2.3 复用度估算

- JS/TS 业务与协议层：**80-90% 可复用**（连接管理、E2E、会话 UI、设置页）；
- 原生模块层：**0%**（1 重设计 + 1 重写 + 1 排除）；
- 平台工程：Apple 推送证书、Info.plist 权限文案（本地网络/语音/通知）、TestFlight 流程、iOS 导向交互改造（返回手势等）。
- **首次落地估算 > 2 周 + 每年 $99 + 持续审核摩擦，产出的还是一个"后台保活被阉割"的版本**——iOS 上原生 App 同样做不到 Android 式前台服务常驻（后台网络约 30s 即被挂起 [25]，见 1.3.4）。

### 1.3 PWA 路线（重点）

#### 1.3.1 现状盘点：web-console 已具备的能力

- **云桥模式今天就能在 iOS Safari 用**：web-console（`web-console/index.html` 单文件）的 wss + tweetnacl E2E + localStorage 持久化（配对密钥/云桥 token/last_seq/主题）全部是标准 Web API；relay（`ws-server.ts`）对手机 UA 直接服务响应式控制台（`/m` 已改为跳回 `/` 的兼容中转页）、loopback local-info 探测（注释已考虑 Safari 混合内容行为）。
- **断线自愈机制已按"移动端前台应用"场景设计完备**（代码盘点）：
  - 20s 应用层心跳 ping（探测 NAT 半开），relay 侧 ping-resume 按 last_seq 补发漏掉的事件；
  - **visibilitychange 回前台立即补一次 ping-resume，并 8s 探活失败即强制重连**——代码注释明确写了这是针对"后台标签页定时器被浏览器节流甚至冻结"的场景；
  - 指数退避重连（1s 起、上限 10s）；重连后按 last_seq 增量补发或退化为 SNAPSHOT 全量重建，状态必然收敛。
- mobile/ 目录已有 PWA 壳（manifest + sw.js + 图标），但那是 **App 下载页**性质；web-console 本身**尚无 manifest / iOS 主屏 meta / SW**——即 backlog 中"已计划的 PWA 化"还没做。这份工作正是 iOS 路线的主体。

#### 1.3.2 iOS 添加到主屏幕的现状（2026）

- 添加主屏后以 **standalone 独立窗口**运行（无 Safari 工具栏）、自有图标与启动屏 [15][17]；
- **iOS 26 起行为进一步放宽**：任意网站经分享菜单加主屏**默认按 web app 打开**（不再是书签跳转 Safari），相当于"安装"步骤对用户更自然 [15][16]；
- 历史包袱与已知回归：
  - iOS 17.4 曾在 EU 短暂把主屏 web app 降级为标签页，后经 DMA 交涉恢复 [17]；
  - iOS 26.1 beta 出现过全屏渲染回归（刘海屏相关）[18]；
  - **iOS 26 Safari 存在 WebSocket 不稳定回归（QUIC/HTTP3 协商问题，禁用 HTTP/3 可绕过）**[19]——建议云桥侧（cc.humumu.online）保留关闭 QUIC 的开关，云桥已是 wss 不受影响，但值得知晓。

#### 1.3.3 Web Push（iOS 16.4+）

- 已安装到主屏的 web app 支持 **Web Push 与 Badging API**。前提链条 = 加入主屏 + 从主屏打开 + 注册 Service Worker + 用户授权；在 Safari 标签页里请求权限拿不到 PushManager（Apple 官方 WebKit 公告口径）[20][21]。
- 对 CC Deck 的含义：
  - 锁屏/后台期间错过的事件可由"Web Push 唤醒（通知）→ 点开 PWA → visibilitychange resume 按 last_seq 补发"闭环；
  - **前提是页面在 https 域**：云桥模式（cc.humumu.online）满足；LAN 直连 `http://<ip>:8787` 模式无推送，只能开屏补拉（这对 LAN 场景可接受——同网时人通常主动开页面）。
- 实施成本（若做）：web-console 注册 SW（目前只有 mobile/ 壳有）、VAPID 密钥对与订阅管理、云桥加一条"事件 → Web Push"旁路。属于 P2 可选项，不做也不影响核心闭环（打开即 SNAPSHOT 兜底）。

#### 1.3.4 前台 WS 长连与后台冻结：现有机制够不够用

- **iOS 上 PWA 退后台/锁屏后 WS 必然被系统挂起**，且 WebKit 经常**不触发 onclose**——连接静默假死，标准重连逻辑不会启动（WebKit bug 247943）[22]。
- 社区/框架共识方案三件套：① visibilitychange 主动重连（不信任 close 事件）②应用层心跳探测死链 ③重连后按序号补拉 [22][23][24]（Phoenix 框架 1.8.3+ 专门为此内置了 visibilitychange 重连 [24]）。**这三条 web-console 已全部实现**（见 1.3.1），属于"天然契合"，无需新增机制。
- 即使原生 App 也无法在后台长期保活 socket（OS 级限制，后台宽限约 30s [25]）——**"Android 式后台常驻收推送"在 iOS 上无论 PWA 还是原生都做不到**。原生相对 PWA 的真实增益只剩：推送触达链路更成熟、语音/手表等原生能力、无浏览器存储驱逐焦虑。
- **够不够用的判断**：对 CC Deck 核心场景（抬手看一眼会话状态、回复/批准一把），**现有 visibilitychange resume + ping-resume 补发已经够用**；唯一缺口是"不打开 App 就收到 WAITING 提醒"，需要 Web Push 补（1.3.3），或先接受"打开才知道"。

#### 1.3.5 存储驱逐风险

- Safari ITP 对脚本可写存储（localStorage/IndexedDB/SW 注册）有 **7 天不交互即清除**机制 [26]；**加入主屏的 web app 豁免**此驱逐 [26][27]。
- web-console 的全部本地状态（配对密钥对、relay 公钥、云桥 token、last_seq、主题）都在 localStorage：
  - "未加主屏、偶尔从 Safari 标签访问"的用法下，7 天不动就可能**丢配对**；
  - 安全上无恙：丢了重新配对即可（配对码 30 秒一次性，泄露面反而更小）；last_seq 丢了退化为 SNAPSHOT 全量，正确性不受影响；
  - 因此"引导用户加主屏"既是体验项也是数据持久项，是 iOS PWA 清单里的高性价比动作。

#### 1.3.6 iOS PWA 待办清单（按性价比排序）

1. web-console 加 manifest + `apple-mobile-web-app-capable` / `apple-mobile-web-app-status-bar-style` / `apple-mobile-web-app-title` 等主屏 meta + 图标（**P0**，纯静态，可复用 mobile/ 已有 icon-192/512）；
2. 连接设置页加"添加到主屏幕"图文引导（**P0**，纯文案）；
3. （可选 P2）web-console 注册 SW + 云桥旁路 Web Push（VAPID），覆盖"锁屏期间 WAITING 提醒"；
4. （可选 P3）iOS 安全区/手势微调（现有 `viewport-fit=cover` 已打下基础）。

### 1.4 iOS 结论

**推荐路径：PWA 优先，原生 iOS 除非用户强需求否则不做（关闭 #166 或标记 wontfix）。**

- PWA 路线总成本 ≈ 1 个 manifest + 几行 meta + 1 篇引导文案（半天级），即可覆盖 iOS 用户"查看状态 + 发消息 + 批准/拒绝"的全部核心诉求；锁屏断连由现有 resume 机制兜住；存储驱逐由主屏安装豁免。
- 原生路线成本 = $99/年 + EAS/TestFlight 流程 + voice 重写 + notify 重设计 + 交互改造，产出还砍掉了后台保活——**收益/成本比显著劣于 PWA**。
- 触发重评估的信号（满足其一再启）：
  - 出现强需求的语音输入（iOS Safari 的 `SpeechRecognition` Web API 支持有限）；
  - 需要 Apple Watch 联动；
  - 多数用户明确要求原生推送/后台体验且不接受 PWA。
- 届时路线：EAS 云构建（无 Mac）+ $99 账号 + TestFlight 外部测试分发；JS 层直接复用，模块按 1.2.2 表逐个补 ios/ 目录。

---

## 二、macOS 部分

### 2.1 relay 跨平台现状盘点（逐文件）

**总判断：relay 的核心链路（WS 服务 / hooks 事件桥 / transcript 读取 / 云桥客户端）全部建在 Node 跨平台 API 与 `~/.claude` 约定路径上，macOS 可直接运行；Windows 假设集中在"终端按键注入"和"pid 探测"两处，且均已有降级行为，不会崩。**

#### 2.1.1 逐文件盘点表

| 文件 | Windows 假设（代码盘点） | macOS 现状 | 处置 |
|---|---|---|---|
| `src/injector.ts` | `CSC = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"` 硬路径；产物 `inject.exe`；`CCR_INJECT_CMD` 假注入器仅测试用 | `ensureInjector()` 编译失败 → 返回 false → 注入类命令回 `{ok:false, error:"注入器不可用（编译失败…）"}`，**已优雅降级**；但 `ready` 永远 false，**每次注入调用都重试一次 csc**（ENOENT 快速失败，浪费 spawn 且日志噪音） | 加 `process.platform` 守卫直接返回不可用（2.3-1） |
| `src/config.ts` | 无：dataDir 全走 `homedir()/.cc-deck/data` 或 `CCR_DATA_DIR`/cwd 环境变量 | 直接可用 | 无需改 |
| `src/ws-server.ts` | 无：loopback 判定含 `::ffff:127.0.0.1`（macOS Node 同样适用）；`/m` 仅作旧图标跳转页（iPhone UA 现在直接吃根路径控制台）；`.apk` MIME 在 mac 无害 | 直接可用 | 无需改 |
| `src/index.ts` | `pidIsNode()`：win32 走 `tasklist`，**fallback 读 `/proc/<pid>/comm`——macOS 无 /proc，必抛异常被 catch → 恒 false** | `--stop`（插件 `/cc-deck-stop`）在 macOS 会误报"未发现运行中的 relay"；另 `lanIps()` 的网卡名过滤表（vEthernet/WSL 等）偏 Windows，对 mac 无害只是过滤不全 | 加 darwin 分支（2.3-3） |
| `hooks/bridge-hook.mjs` | `resolveCliPid()` 用 **powershell Get-CimInstance Win32_Process** 走父进程链定位 claude.exe | mac 上 execFileSync("powershell") 直接失败 → `cli_pid=0` → **六事件照常上报、远程审批照常，只是注入定位缺失**（diag 记一条 walk fail） | 可选加 `ps -o ppid=` 祖先链分支（2.3-4） |
| `scripts/install-hooks.mjs` | 无：写 `~/.claude/settings.json`，hook 路径已归一化正斜杠，`node <path>` 命令 mac 通用 | 直接可用 | 无需改 |
| `src/bridge.ts` / `session-manager.ts` / `agent-adapter.ts` / `history.ts` 等 | 无：transcript/sessions/tasks 全部 `homedir()/.claude/...`（macOS 上 Claude Code 目录结构同构）；managed 会话走 `@anthropic-ai/claude-agent-sdk` 的 `query()`（跨平台，要求本机装有 claude CLI——macOS 是其一等平台） | 直接可用 | 无需改 |
| `scripts/`（start-relay.bat/.vbs、office-start.bat、install-autostart.ps1、restart-relay.ps1、relay-status.ps1） | 全 Windows | 不可用 | README 写明 mac 用 `npm run dev` / 插件 `relay.mjs`；launchd 自启列 P3 |
| `cloud-bridge/` / `cloudflare/` | 无（服务端与平台无关） | 不受影响 | 无需改 |

#### 2.1.2 Claude Code hooks 在 macOS 的机制等价性

Claude Code 官方支持 macOS；hooks 即 `settings.json` 里的 **shell 命令**，stdin/stdout JSON 协议、六事件、PreToolUse 的 `hookSpecificOutput.permissionDecision` 决定输出在 mac 上完全一致 [28][29]。bridge-hook 是纯 Node 脚本、任何情况静默 exit 0、HTTP 回连 `127.0.0.1:<port>/bridge/hook`——因此：

- 六事件桥接（Notification/PostToolUse/PreToolUse/SessionEnd/Stop/UserPromptSubmit）：**等价**；
- PreToolUse 远程审批（手机 Allow/Reject 回写 CLI）：**等价**；
- 双注册去重（文件锁 + hash + TTL）、诊断日志截断：**等价**（纯 fs 操作）；
- transcript_path 读取（`~/.claude/projects/...jsonl`）：**等价**（目录结构同构）；
- 唯一不等价：pid 定位（powershell → ps）与后续按键注入——即"把消息打进用户终端"这一件事。

#### 2.1.3 macOS 功能可用性清单

**直接可用**：网页控制台（LAN/云桥双模式）、手机 App 连接（云桥 E2E 配对 + LAN）、managed 会话全功能（创建/消息/停止/权限模式/提问回答，Agent SDK 路线不依赖注入）、外部 CLI 会话接入（hooks 桥全事件 + 远程审批 + transcript 时间线）、TODO 读取、历史持久化与重启恢复、多桥并行。

**不可用（降级）**：外部 CLI 会话的终端注入（injectText/injectEsc/injectEnter）。Mac 上 relay 会明确返回"注入器不可用"；**重要区分：managed 会话（relay 自己 spawn 的 CLI）发消息不走注入，完全不受影响**——Mac 用户用"从 App/网页新建会话"即可获得全部功能，只有"接管自己在终端里开的 claude"时不能打字进去（仍可看状态、审批、读 transcript）。

**macOS 注入器可行性（将来若做）**：`osascript -e 'tell application "System Events" to keystroke ...'`。两个门槛：① 需给**运行脚本的宿主进程**（Terminal/iTerm2/或 relay 守护进程）授予"辅助功能（Accessibility）"权限，且 macOS 升级常重置/移动该设置 [30][31]；② keystroke 是**焦点式**注入——必须先把目标终端窗口带到前台，与 Windows inject.cs 的 AttachConsole"不抢焦点"语义不同，体验降级。**结论：能做但门槛高，首发直接降级不做。**

### 2.2 macOS 客户端形态

（注：仓库暂无 `docs/desktop-decision.md`，以下为独立简评；若日后补写该文档，本文此节结论可直接并入。）

- **浏览器直开**（零成本）：Mac 用户打开 `http://<relay-ip>:8787/` 与 Windows 完全一致，今天就能用；配对的 local-info loopback 探测在 mac 浏览器同样工作。
- **Safari「添加到程序坞」（Add to Dock）**：macOS Sonoma 14 起系统原生支持把任意网站变成独立窗口的 Dock 应用 [32]，且这类 web app **支持通知与 Dock 角标**（在 web app 内响应通知请求，会出现在系统通知设置里）[33]。配合 web-console 的 PWA 化（与 1.3.6 是同一份工作，两端受益），Mac 上即获得"像 App 的体验"，**推荐默认形态**。
- **Chrome 安装 PWA**：桌面 Chrome（含 macOS）至今支持"安装页面为应用"；注意 Google 淘汰的是旧 **Chrome Apps**（2028 EOL）而非 PWA，两者常被混淆 [34][35]。
- **Tauri / Electron 壳**：仅在需要菜单栏常驻、全局快捷键、自动更新、原生文件对话框等能力时才有意义。若做，选 Tauri 2（3-10MB 体积、内存约为 Electron 一半、用系统 WebView；代价是各平台渲染差异需回归测试）而非 Electron（85-200MB、捆绑 Chromium）[36][37][38]。**当前阶段结论：不做壳**——web-console 已是单文件 HTML，PWA 覆盖绝大多数需求，壳是纯增量维护成本；relay 本身也无需打包（claude CLI 用户都有 Node 环境）。

### 2.3 macOS 支持最小改造清单

按优先级（P0 = 不做就没法体面地说"支持 macOS"）：

1. **[P0] `injector.ts` 平台守卫**：`ensureInjector()` 开头 `if (process.platform !== "win32") return false;`，错误文案区分"非 Windows 平台不支持终端注入"。省掉每次注入的无效 csc 重试，Mac 日志干净。
2. **[P0] 注入不可用的客户端降级提示**：relay 已回 `error:"注入器不可用"`；确认手机 App / web-console 对 EXT_INPUT/ESC/ENTER 类失败有可见 toast（而非静默失败），文案注明"Mac relay 不支持终端注入，请使用 App 内新建会话"。（若已展示则本项为验证项。）
3. **[P1] `index.ts` `pidIsNode()` 加 darwin 分支**：`execFileSync("ps", ["-p", String(pid), "-o", "comm="])` 判 node，修复 macOS 上 `/cc-deck-stop` 误报。
4. **[P1] `bridge-hook.mjs` `resolveCliPid()` 加 darwin 分支**：`ps -o ppid= -p <pid>` 逐级上溯（跳过 bash/zsh 层取 claude 进程），为将来 mac 注入器预留 pid 定位；不做注入则此条可降 P3。
5. **[P1] 使用文档**：README 增加 macOS 快速开始（`npm install && npm run dev`、`node scripts/install-hooks.mjs`、云桥照常、注入不可用说明、Safari Add to Dock 引导）。
6. **[P2] 云桥/反代保留关闭 HTTP/3 的开关**，规避 iOS 26 Safari WebSocket 回归 [19]。
7. **[P3] 可选**：launchd 开机自启 plist（对齐 install-autostart.ps1）；macOS 注入器（osascript + Accessibility 引导授权）。

**验证清单**（P0+P1 完成后，macOS 实机或 CI macOS runner 冒烟）：

- [ ] `npm run dev` 启动，控制台打印控制台地址与 token；
- [ ] Mac 浏览器开 web-console：SNAPSHOT 正常、`/local-info` loopback 探测生效；
- [ ] 手机经云桥配对 → 创建 managed 会话 → 收发消息 → 权限审批；
- [ ] 终端手动开 claude 会话 → hooks 桥六事件上报 → 远程 Allow/Reject 生效；
- [ ] 外部会话尝试"打入消息"→ 收到"注入器不可用"提示，其余功能不受影响；
- [ ] `/cc-deck-stop` 能正确停掉 daemon（验证 2.3-3）。

**预估**：P0+P1 合计约半天到一天开发 + 一轮 Mac 实机验证。

---

## 三、总结建议

1. **iOS：关闭/搁置原生方案（#166），落地 web-console PWA 化**——补 manifest + iOS 主屏 meta + 添加主屏引导（半天级，P0），可选二期 Web Push（P2）。原生 iOS 仅在出现语音/手表/原生推送强需求时重启，届时 EAS 云构建（无 Mac）+ $99 账号 + TestFlight 外部测试分发，JS 层复用 80-90%。
2. **macOS：#167 按"注入降级 + 其余照跑"落地**——3 处代码小改（injector 平台守卫、pidIsNode darwin 分支、可选 resolveCliPid darwin 分支）+ 客户端失败提示 + README，半天到一天；客户端推荐 Safari Add to Dock PWA（与 iOS PWA 化共享同一份工作），Tauri/Electron 壳不做。

---

## 附录 A：web-console PWA 化文件级清单（iOS P0 项展开）

供估算工作量用；对应 §1.3.6 的第 1、2 条。

**A.1 web-console/index.html `<head>` 需新增**

- `<link rel="manifest" href="/manifest.webmanifest">`（或 data: URI 内联，规避新增静态路由）；
- `<meta name="mobile-web-app-capable" content="yes">` 与 `<meta name="apple-mobile-web-app-capable" content="yes">`（standalone 必需；iOS 26 起加主屏默认即 web app，但老系统仍需）；
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`、`<meta name="apple-mobile-web-app-title" content="CC Deck">`；
- `<link rel="apple-touch-icon" href="...">`（可复用 `mobile/icon-192.png`）；
- `<meta name="theme-color">` 已存在，无需动。

**A.2 manifest 字段建议**

- `display: "standalone"`、`start_url` 带配对态参数（未配对用户落到现有设置流程）、`scope: "/"`（web-console 在根路径，与 mobile/ 壳的 `/m` scope 不同，两者可共存）；
- 图标 192/512 + maskable，直接复用 `mobile/` 现有 PNG。

**A.3 relay 托管影响（`ws-server.ts` 现状核对）**

- 现有静态路由只认 `/`（index.html）、`/nacl.js`、`/m/*` 三类，MIME 表已含 `.webmanifest`（给 `/m` 用）；
- 根作用域 manifest/icon 若走独立文件，需在 `createServer` 里加 2-3 个只读路由（与 `/nacl.js` 同模式，几行）；若想零新增路由，manifest 可用 data: URI、图标可复用 `/m/icon-192.png` 路径；
- SW（若做 P2 Web Push 才需要）：根作用域注册，注意别拦截 `/m` 壳的 SW（两者 scope 不同，无冲突）。

**A.4 iOS 引导文案要点**

- Safari 分享菜单 →"添加到主屏幕"（iOS 26 也可直接长按地址栏附近，以系统版本截图为准）；
- 强调"加主屏后 7 天不用也不会丢配对"（§1.3.5 驱逐豁免是用户可感知的卖点）；
- Chrome/Edge on iOS 内核同为 WebKit，行为一致，引导无需分浏览器。

## 附录 B：风险与开放问题

1. **iOS 26 Safari WS 回归**（QUIC 协商 bug [19]）：云桥如果前置 CDN/反代，需确认可一键关闭 HTTP/3；属运维项非代码项。
2. **TestFlow 审核口径**：CC Deck 形态（远程控制本机进程）若未来走 TestFlight/App Store，Beta Review 对"控制类"App 是否要求账号体系/审核材料，未在本次调研验证范围内，届时以首审反馈为准。
3. **免费 EAS 额度变动**：15 次/月为社区口径 [12]，若重启原生路线需以 Expo 官网当日定价复核。
4. **macOS 实测缺失**：§2.1 盘点基于代码审读，`/local-info` 的 Host 信任、`::ffff:` loopback 表示等细节建议在 2.3 验证清单里实测确认（预期无问题）。
5. **watchOS**：`wear` 模块在 iOS 侧无对应物；若 iOS 原生重启且需手表，watchOS 是独立立项（不并入 #166 成本估算以免低估）。

---

## 参考来源

**Apple 账号/分发**

1. Apple Developer — Choosing a Membership（$99/年、免费账号 7 天 profile）: https://developer.apple.com/support/compare-memberships/
2. Apple Developer — Enrollment: https://developer.apple.com/programs/enroll/
3. Reddit r/AltStore — 免费 7 天/付费 365 天与设备上限（社区口径）: https://www.reddit.com/r/AltStore/comments/1dtnh43/way_to_circumvent_the_7days/
4. Apple Developer Enterprise Program: https://developer.apple.com/programs/enterprise/
5. Appaloosa — Enterprise 账号停批与 ABM 替代（2026）: https://www.appaloosa.io/blog/news/is-it-soon-over-for-apple-enterprise-developer-accounts
6. Apple Developer Help — Devices overview（100 台/产品线/年）: https://developer.apple.com/help/account/devices/devices-overview/
7. Apple Developer Help — TestFlight overview（90 天/10000 外部/首 build 审核）: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
8. Apple Developer — Changes for apps in the EU: https://developer.apple.com/support/apps-in-the-eu/
9. Apple Newsroom（2026-08）— EU 替代分发资格放宽: https://www.apple.com/newsroom/2026/08/apple-announces-changes-for-apps-in-the-european-union/
10. The Verge — CTF 取消改 5% 抽成: https://www.theverge.com/tech/981504/apple-app-store-eu-rules-core-technology-commission

**Expo/EAS**

11. Egghead — EAS 模拟器构建无需 Apple 账号: https://egghead.io/lessons/react-native-create-a-development-build-for-ios-simulator-with-eas
12. Reddit r/reactnative — EAS 免费额度 15 次/月等: https://www.reddit.com/r/reactnative/comments/1jtwa2m/using_expo_is_there_a_way_to_build_ios_for_free/
13. Expo 讨论 #27489 — 真机内部构建需付费账号: https://github.com/expo/expo/discussions/27489
14. Expo Changelog — SDK 57（RN 0.86 / React 19.2）: https://expo.dev/changelog/sdk-57

**iOS PWA**

15. Heise — iOS 26 主屏默认按 web app 打开: https://www.heise.de/en/news/iOS-26-and-iPadOS-26-Changed-web-app-behaviour-on-the-home-screen-10749652.html
16. MacRumors — iOS 26 添加主屏 web app: https://www.macrumors.com/how-to/save-safari-bookmark-web-app-iphone-home-screen/
17. MagicBell — PWA iOS Limitations and Safari Support (2026): https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
18. Reddit r/Frontend — iOS 26.1 PWA 全屏渲染回归: https://www.reddit.com/r/Frontend/comments/1oj2iz5/wtf_is_going_on_with_pwa_and_ios_26_and_ios_261/
19. WebKit Bug 298616 — iOS 26 WebSocket 不稳定（禁 QUIC 绕过）: https://bugs.webkit.org/show_bug.cgi?id=298616
20. WebKit Blog — Web Push for Home Screen web apps（iOS 16.4+，含 Badging）: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
21. Stack Overflow — Safari 标签页无 PushManager（佐证主屏限制）: https://stackoverflow.com/questions/76222241/safari-on-ios16-4-creates-a-serviceworker-without-pushmanager-why
22. WebKit Bug 247943 — 后台杀 WS 不触发 onclose: https://bugs.webkit.org/show_bug.cgi?id=247943
23. tRPC #4078 — visibilitychange 强制重连 workaround: https://github.com/trpc/trpc/issues/4078
24. mrpopov — Phoenix 针对 iOS Safari 的 visibilitychange 重连修复: https://mrpopov.com/posts/elixir-phoenix-optimisations-iphone-safari/
25. Apple Developer Forums #716118 — 原生 App 后台 socket 同样受限: https://developer.apple.com/forums/thread/716118
26. WebKit Blog — 7 天脚本可写存储上限（主屏 web app 豁免）: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
27. Aral Balkan — 7 天驱逐的影响分析: https://ar.al/2020/03/25/apple-just-killed-offline-web-apps-while-purporting-to-protect-your-privacy-why-thats-a-bad-thing-and-why-you-should-care/

**Claude Code / macOS**

28. Claude Code Docs — Hooks Reference: https://code.claude.com/docs/en/hooks
29. Claude Code Docs — Hooks Guide（shell 命令跨平台）: https://code.claude.com/docs/en/hooks-guide
30. Apple StackExchange — keystroke 需宿主进程 Accessibility 权限: https://apple.stackexchange.com/questions/394980/
31. Doug's AppleScripts — System Events key code/keystroke: https://dougscripts.com/itunes/itinfo/keycodes.php
32. Apple Support — Safari Add to Dock（macOS Sonoma+）: https://support.apple.com/guide/safari/add-to-dock-ibrw9e991864/mac
33. Apple Support — Safari web apps 通知: https://support.apple.com/en-us/104996
34. MDN — Installing and uninstalling web apps: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Installing
35. Google — Chrome Apps EOL（≠ PWA）: https://support.google.com/chrome/a/answer/15950395
36. rustify — Tauri vs Electron 2026（体积/内存）: https://rustify.rs/articles/rust-tauri-vs-electron-2026
37. pkgpulse — Electron vs Tauri 2026: https://www.pkgpulse.com/guides/electron-vs-tauri-2026
38. tech-insider — Tauri vs Electron 2026: https://tech-insider.org/tauri-vs-electron-2026/
