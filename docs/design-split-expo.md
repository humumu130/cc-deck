# 手机端 expo-app 拆分方案（design-split-expo）

> W-SPLIT-EXPO · 2026-10-20 · 域路之二 · 零代码设计稿（基线 698bbb2 = test.45）
> 透镜：现状实查 → 拆分粒度 → 风险递增路线图（断言套件护航）→ 域交界 → 风险清单。
> 原则先行：**渲染树零变化**——拆文件不拆树（不改组件嵌套/挂载序），Fabric re-parent 类崩溃面（Yoga owner 断言先例）从根上规避；**接口面不动**——expo 只吃 relay 帧，protocol.ts 帧定义与 store 对外行为是冻结边界。

## ① 现状实查（基线 698bbb2 实测）

### 行数盘点（任务书口径勘误：TeamDetailPage 845 / OrgTabs 584 均**非**千行件）

| 文件 | 行数 | 构成（实测函数区分布） |
|---|---|---|
| screens/DetailScreen.tsx | **4525** | 纯函数区 :76-428（isWaitStale/artifactRowsOf/dedupeWaitingBars/closingBarOf/dockModelOf/decisionStillPending 等 12 导出）· 通用小组件 :429-728（TranscriptRow/DiffBlock/TaskRefText/ContentMenu）· 产物缓存域 :729-893（artCache 四件+磁盘驱逐）· 大组件 :894-1905（ArtView/ArtSheet/ArtFolSheet/PermPanel/ModelSheet/TaskPop/StatusStrip/AskBanner/CtxSegMeter）· **主组件 :1906-3916（单组件 ~2000 行）**· **makeStyles :3958-4525（567 行）** |
| store.ts | **3608** | RelayStore 单类巨店（:3389 单例 export）；混装：WS 连接域/快照 merge 域/云桥域（cloudDevFor 等）/acceptance 拉取域/#79 输出物远程域（:2850+）/设备密钥域（:731+） |
| screens/ListScreen.tsx | **2075** | 纯函数区 :47-522（foldMeta/queueFlagsOf/splitPending/sourcePalette/activityMetricsOf/sessionSearchTest/buildListProjection 全导出）· Glyph/Badge 小组件 · SessionCard · 主组件 · makeStyles |
| screens/SettingsPage.tsx | 1809 | 面板装配+6 模块（通用/引擎/连接/身份/扩展/关于）+makesStyles |
| App.tsx | **1381** | 22 个 useState 编排 + 四 Tab 宿主 + Detail 挂载 + 通知/更新/审批横幅层 + 全局弹层栈 |
| screens/SetupScreen.tsx | 981 | 配对/添加服务器流 |
| screens/TeamDetailPage.tsx | 845 | 名册卡+看板+活动 |
| screens/OrgTabs.tsx | 584 | 团队/项目/通知三 tab 宿主 |

### 共享现状

- **跨屏纯函数已导出但住在屏件里**：ListScreen 导出 7 个纯函数（splitPending/buildListProjection 等，TeamDetailPage/App 消费）、DetailScreen 导出 8 个（artifactRowsOf/ArtView 等，App 消费）——**依赖方向已倒挂**（屏件成为公共库）。
- 主题/常量：theme.ts 232 行单源 ✓ 健康；样式仍各屏 makeStyles 内嵌。
- 共享 hook：无 useRelay 抽象层——各屏直连 `store` 单例 + useRelay 快照订阅（store.ts 内）。

### 断言套件锚定关系（26 套件实测，拆分护航面）

| 屏件 | 锚定套件（expo-app/scripts/） |
|---|---|
| DetailScreen | detail2 / mv8a / portb / pushperf / expolish-tabs / e3a-detail / e3b-wiring / e-permission-summary / swipeask |
| ListScreen | expodomain(171 断言) / mv8a / mobile3-settings / portb / e2a-list / expolish-tabs |
| store.ts | 401c-clouddev / e-engine-catalog / e3b / e4b-notify / englogin-expo / lanfix-wsurl |
| SettingsPage | mobile3-settings(45 断言) / e-permission-summary |
| OrgTabs | mv8a / mobile3-settings |
| 其他 | updates-cmp→updates.ts；delta-merge→org-delta.ts；expo1-nav-scan→bottom-tabs/ScanScreen；expo2-devices→ScanScreen |

> 关键事实：套件全是**源码串锚**（读文件断言实现片段在位）——文件拆分=锚必跟改，否则假红（片段去了新文件）或假绿（断言串还在旧文件残壳）。**每阶段同批跟锚是铁律**，跟锚本身即「拆分未丢实现」的机器证明。

## ② 拆分粒度设计

四层粒度，从松到紧；**边界判据 = 锚定关系与依赖方向**：

**L1 纯函数层（无状态零风险）**：各屏导出纯函数迁 `src/lib/`（既有 fmt.ts 同层的域库位）：
- `lib/list-projection.ts` ← ListScreen :47-522（buildListProjection 族 7 函数——本就是 W-PORT-B 从桌面直移的纯函数群）
- `lib/detail-fns.ts` ← DetailScreen :76-428（isWaitStale/closingBarOf/dockModelOf/dedupeWaitingBars 族）
- 屏件 re-export 一个版本窗（`export { splitPending } from "../lib/list-projection"`）防消费方断——全部消费方切完后撤 re-export。

**L2 样式层**：makeStyles 整体迁 `*.styles.ts`（同 `(c: ThemeColors) => StyleSheet.create` 签名，屏件 `import makeStyles from "./X.styles"`）——DetailScreen 567 行样式独立后主文件即刻 -12%。**不拆样式键、不并类**——机械搬移零语义差。

**L3 自治组件域（高内聚低耦合块）**：按「自带状态+不碰主组件内部 state」判据：
- `screens/art-view/`（index+ArtView+ArtSheet+ArtFolSheet+artCache 域，~700 行——与 src/artpool.ts 天然同族）
- `screens/detail-parts/`（AskBanner+WaitCard+StatusStrip+PermPanel+ModelSheet+TaskPop+CtxSegMeter 弹层/横幅族，~800 行——props 驱动、无主组件 state 反向依赖）
- `screens/detail-parts/transcript.tsx`（TranscriptRow/DiffBlock/TaskRefText/ContentMenu 时间线渲染族）
- ListScreen 小组件族（Glyph/Badge/LiveStat）体量小（~150 行）——**不拆**（收益低于文件数成本，判据：<300 行不立文件）。

**L4 主组件与巨店（风险区，见路线图后段）**：
- DetailScreen 主组件 2000 行 → 按「更多 tab 面」（StatsModal :3115+/水位计区）与「对话流面」分两文件子组件，**props/回调显式化**；
- store.ts 3608 → 按域拆模块文件但**保留单类聚合**（mixin/组合而非拆类——连接域 `store/conn.ts`、云桥域 `store/cloud.ts`、acceptance 域 `store/acceptance.ts`；对外 `store` 单例与全部公有方法签名冻结）；
- App.tsx 22 useState → `hooks/use-app-shell.ts`（tab/横幅/弹层栈三组 state 各一 hook）。

## ③ 路线图（风险低→高，每阶段=独立分支独立可合并批次）

| 阶段 | 内容 | 护航（每阶段必过闸） |
|---|---|---|
| **S0 护栏加固**（先立后拆） | ①26 套件全绿基线固化（基线 commit 上跑通存证）②「export 面快照」脚本：`grep '^export' 各屏 > exports.snapshot`——拆后 diff 零丢失（拆丢出口即刻红）③ tsc 清零存证 | 基线绿本身 |
| **S1 L1 纯函数迁 lib** | 两屏纯函数迁 lib+屏件 re-export 版本窗 | 锚跟改（e2a/expodomain/portb→lib 路径）+tsc+export 快照零差 |
| **S2 L2 样式分离** | Detail/List/Settings 三屏 makeStyles 迁 *.styles.ts | 同上（mv8a/mobile3-settings 样式串锚跟改） |
| **S3 L3 自治域迁出** | art-view 域/detail-parts 族 | 锚跟改（detail2/pushperf/e-permission-summary 触 ArtView/PermPanel/ModelSheet 串）+ **模拟器装机抽查一屏**（首个涉及渲染文件移动的阶段，验 Fabric 零感） |
| **S4 主组件分区** | DetailScreen 主组件分面（更多 tab 面/对话流面）；App.tsx hook 抽取 | 全套件+**真机抽查**（对话流/更多 tab/审批横幅三条链各点一遍）+pushperf 重渲断言 |
| **S5 store 域拆** | RelayStore 按域分模块（单类聚合不变、公有面冻结） | 401c/e-engine-catalog/e3b/e4b/englogin/lanfix 全锚 + 真机全链（配对/云桥/更新/验收四链） |
| 间歇纪律 | 每阶段间至少一个 test 包窗口验证；**拆分期避开功能批高峰**（同文件冲突面：DetailScreen 现为 swipeask/cardfix 等多单汇集线——拆分批与其错峰，或先收编再拆） | 出包装机真验 |

## ④ 与其他域的交界（接口面不动原则）

- **对 relay（唯一上游）**：expo 消费面=WS 帧+HTTP API，全部经 protocol.ts（1103 行帧定义）与 store.ts 连接域。**冻结物**：protocol.ts 帧结构、store 公有方法签名、`store` 单例 export、events 消费语义。拆分全部是 src 内部结构调整，relay 侧零感知。
- **对桌面域（web-console）**：无直接依赖（纯函数移植是单向拷贝，如 sessionSearchTest 先例）——拆出的 lib 若被桌面复用=另立提案，不在本方案内。
- **对壳（Tauri/Nova）**：App Resources 只吃构建产物，源结构无感。
- **对其他拆分域路（之一/之三）**：本方案只覆盖 expo-app/src；relay 拆分（若域路之一覆盖）与本方案交界恰在「冻结面」——两路并行时 S5 store 域拆与 relay 侧改动无文件交集。

## ⑤ 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **锚漂移**：26 套件源码串锚，拆分必致锚指向旧文件 → 假红/假绿 | 高 | 铁律「同批跟锚」；S0 export 快照兜底；每阶段 PR 清单含「锚跟改文件列表」核对项 |
| R2 | **Fabric re-parent 崩**：组件树结构变化触发 Yoga owner 断言（stickyHeaderIndices/元素形态两先例） | 中 | 本方案渲染树零变化（拆文件不拆树）；S3 起每阶段装机抽查——首个崩点即回退该阶段 |
| R3 | **memo 边界变化→重渲回归**：文件迁移若顺手动 memo/依赖数组=行为差 | 中 | 判据「机械搬移零语义差」写进每阶段自查；pushperf 套件（DetailScreen 重渲锚）S4 必跑 |
| R4 | **多会话并行冲突**：DetailScreen 已是多单汇集线（swipeask 代提教训），拆分批与功能批同改必撞 | 高 | 错峰纪律（路线图间歇行）；拆分批占文件期间 Leader 冻结该文件的功能派单 |
| R5 | **RN/依赖兼容**：新文件 import 链（Animated/PanResponder/AsyncStorage）跨文件后 metro 解析变化 | 低 | 纯 tsc 可拦类型面；S3 装机验打包链（hermesc-arm64.sh 顺手过） |
| R6 | **无线 adb 验证面波动**：连接端口漂移（环境备忘） | 低 | 每阶段装机前 `adb mdns services` 发现再连（既有口径） |
| R7 | **store 域拆（S5）动面最大**：单类内闭包互访（私有方法跨域互调） | 高 | 放最后；mixin 聚合保留单类=内部互访零变；公有面冻结+六套件全锚+真机四链 |
| R8 | **回退成本**：阶段合并后发现问题 | 低 | 每阶段独立分支独立 squash 笔——单阶段回退=revert 一笔不牵连 |

## 结论（拍板要点）

1. 方案按「先立护栏（S0）→ 纯函数/样式（S1/S2 零行为差）→ 自治域（S3）→ 主组件/巨店（S4/S5）」四波推进，**S1/S2 可立即开工**（无任何行为面）；S3 起需装机抽查节奏配合。
2. 两处依赖倒挂（屏件当公共库）是现状最大结构债——S1 直接偿还。
3. 最大风险不在技术面在**编排面**：锚跟改纪律（R1）与错峰纪律（R4）执行到位，则全程可控；执行不到位，S3 后任意阶段都可能产出「绿套件但漂实现」的假安全。
