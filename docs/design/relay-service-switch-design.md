# relay 系统服务化产品化开关——设计方案（W-SVCDESIGN，只设计不实现）

> **推荐结论：以形态 A（桌面壳设置开关）为主线——它不是从零设计，#196 已交付基线（后端 Tauri command + 前端设置卡都已实现并进了 0.6.0-test.27 本地批），真正要做的是补齐它对 M2 变体的三个缺口（label 变体化、plist 环境变量对齐内嵌 spawn、指引文案漂移），即达 MVP；完整版再叠 plist 漂移自愈、退出挽留引导、状态增强与独立 CLI 查诊通道。形态 B（插件承载）否决——生命周期与 UI 承载双双错位；形态 C 推荐其 CLI 查诊变体作为完整版补充，不做独立 enable/disable 通道。**

日期：2026-10-09 ｜ 分析 worker：W-SVCDESIGN ｜ 状态：待 Leader 拍板
关联：#76（服务化实现就绪）、#196（设置开关）、#018-T2（deck_root 变体隔离）、W-RELAYCVG（relay 拓扑收敛，产出未交付）

---

## 0. 现状核实（比任务书前提更进一步的实况）

任务书说「没有产品化入口，普通用户不可能配置」——核实后需修正为：**产品化开关已实现 70%，但 M2 变体走不通，Leader 才手工建了服务**。这是本设计的真正起点。

### 0.1 已实现基线（核实于 dev 工作区，提交 8443ee3 / 9261075）

| 部件 | 位置 | 状态 |
|---|---|---|
| Tauri command：`relay_service_status` / `relay_service_toggle` | `desktop-tauri/src-tauri/src/main.rs:1061-1140`（已在 `invoke_handler` 注册，:1168） | ✅ 可用 |
| plist 生成：`write_relay_service_plist`（RunAtLoad+KeepAlive+5s 节流，与 deploy 脚本同模板） | main.rs:995-1057 | ✅ 但有缺口 G1/G2 |
| 数据目录变体：`deck_root()`（M2_BUILD → `~/.cc-deck-m2`）已接入 plist | main.rs:1009-1011（#018-T2 注释在案） | ✅ |
| 让位/回退零新增逻辑：supervisor `need_spawn = 无本方子进程 && 端口无服务`，服务占端口即自然让位；服务停用后 1.5s 内内嵌无缝回退 | main.rs:896-950（#66 监督线程） | ✅ 设计得很好 |
| 外部占用守卫：端口被非本方 relay 占且服务未注册 → 拒绝开启（防 EADDRINUSE 崩溃循环） | main.rs:1097-1102 | ✅ |
| token 连续性：**天然成立**——token 存 `data/bridge-token` + `bridge.json{port,token}`，服务化切换 `CCR_DATA_DIR` 不变（deck_root 同源）→ token/云桥配对零变化 | `~/.cc-deck-m2/data/` 实测有 bridge-token | ✅ 无需额外工作 |
| 前端设置卡：「开机自启（系统服务）」+ 三重门可见性（浏览器/旧壳/不支持平台一律藏卡） | `web-console/index.html:2617-2623`（卡）、`:11046-11085`（JS） | ✅ 可用 |
| 切换期体验：toast 提示 + 页面 ws 断线自动重连兜底（页面本身由 relay 托管） | index.html:11049 注释 | ✅ |
| 手工脚本通道：`deploy/mac-relay-launchd/enable.sh / disable.sh`（#196 后已降级为备用/预埋通道） | 4d88cb9 提交说明 | ✅ 降级到位 |

### 0.2 缺口清单（产品化开关的真实欠账）

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| **G1** | **服务 label 是固定常量** `"online.humumu.ccdeck.relay"`，不随 M2_BUILD 变体化 | main.rs:967 | M2 构建开开关会注册**生产变体的 label**：同机双变体都开服务时 plist 互覆写、bootout 互删、两服务（8787/8788 两端口）绑同一 label 互相顶掉。Leader 手工建的 `online.humumu.ccdeck.m2.relay` 正是绕开此坑 |
| **G2** | **plist 环境变量集与内嵌 spawn 不对齐**：`write_relay_service_plist` 只写 PORT/DATA_DIR/INJECT_CS/NOHOOK_IDLE_MS/PATH，缺 M2 增补的 `CCR_ORG_DIR` / `CCR_ORG_BIN_DIR` / `CCR_NO_BRIDGE_MIRROR` / `CCR_MDNS_NAME`（内嵌侧 `spawn_embedded_relay` 的 extra_env 有，main.rs:765-774） | main.rs:1028-1038 vs :765-774 | **M2 场景最危险缺口**：M2 服务实例会覆写生产 `~/.cc-deck/data/bridge.json`（port/token 镜像不被 NO_BRIDGE_MIRROR 拦截）→ 生产壳/手机读到 M2 的 token → reject: token mismatch——与今晚生产事故同型；org 数据落错目录；mDNS 发现列表分身无名 |
| **G3** | Leader **手工** M2 plist 同样不齐：有 CCR_ORG_DIR 但缺 NO_BRIDGE_MIRROR/ORG_BIN_DIR/MDNS_NAME | `~/Library/LaunchAgents/online.humumu.ccdeck.m2.relay.plist` 实读 | 即便手工服务也带覆写生产 bridge.json 的隐患（G2 的手工版）；另引用 `~/.cc-deck-m2/relay-service/relay.mjs` 数据目录副本而非 app bundle——升级不自动同步 |
| **G4** | 指引文案漂移：①`relay_toggle` 关停遇外部托管时提示「终端跑 disable.sh」，产品化后应指向设置卡开关（main.rs:835）；②`toggle_sync` 端口未就绪错误硬编码 `~/.cc-deck/data/relay-service.log`，M2 变体指错日志（main.rs:1122） | main.rs:835 / :1122 | 用户按指引走终端老路；M2 用户排障看错文件 |
| **G5** | **plist 漂移无检测无自愈**：plist 记录启用当时的绝对路径（node / relay.mjs / inject.cs）。node 升级/卸载（nvm 切版本）、inject.cs 路径变化后服务带病运行（KeepAlive 崩溃循环）；dev 壳开开关会把服务指向 `target/debug` 资源（开发机专属坑） | main.rs:996-1007 | 服务静默劣化，用户无感直到手机连不上 |
| **G6** | 卸载路径无说明：app 被拖废纸篓后 launchd 服务独立生存，引用的 bundle 内 relay.mjs 消失 → 服务死循环拉起（ThrottleInterval 5s 兜底，不灾难但不体面） | launchd 语义 | 少数场景的脏状态 |
| **G7** | 发现性为零：痛点场景（退出壳→手机断线）发生时没有任何引导指向这个开关；设置卡藏在「通用偏好」深处且默认按三重门隐藏 | index.html:2617 | 用户（包括今晚的我们自己人）不知道开关存在 |
| **G8** | Windows 未支持（cfg 门控，toggle 返回「暂不支持」，注释规划任务计划器） | main.rs:966/:1078-1082 | 已知边界，非本轮欠账 |
| **G9** | 状态语义弱：`relay_service_status.active = port_listening(port)` 端口有东西≠relay 健康（外来进程也 true）；前端只渲染 enabled，active 未利用 | main.rs:1062-1073 | 异常态（服务注册了但起不来）在 UI 上不可见 |

**核实附带发现**（供 W-RELAYCVG 收敛参考）：生产手工 plist（8787）与 Leader 手工 M2 plist（8788）引用的 relay.mjs 是**两个不同来源**——生产指 `~/.cc-deck/relay-service/relay.mjs`（数据目录副本），M2 指 `~/.cc-deck-m2/relay-service/relay.mjs`；而产品化开关与 enable.sh 都指 **app bundle 内副本**（`/Applications/….app/Contents/Resources/resources/relay.mjs`）。数据目录副本是手工时代产物：升级不自动同步、与 bundle 版本漂移。**本设计口径：app bundle 引用为唯一正解（升级即同步，单一来源），数据目录副本属待收敛遗产。**

---

## 1. 形态 A：应用设置开关（主线，基线补全设计）

### 1.1 用户操作路径（已成立，无需改动）

设置 → relay 页 →「开机自启（系统服务）」卡 → 拨开：
1. toast「正在注册系统服务…（约数秒）」
2. 壳停内嵌实例 → 写 plist → `launchctl bootstrap + enable + kickstart` → 等端口就绪（最长 8s）
3. 卡回弹至开态，状态行刷新 relay 属主
4. 此后退出壳，relay 照跑，手机会话不掉线；开机即有 relay（RunAtLoad）

拨关对称：bootout + 删 plist → supervisor 1.5s 内自动重拉内嵌实例（无缝回退，用户无感）。

### 1.2 技术落点（MVP 改动，全部在既有结构内）

1. **G1 → label 变体化**：`const RELAY_SERVICE_LABEL` 改 `fn relay_service_label() -> &'static str { if M2_BUILD { "online.humumu.ccdeck.m2.relay" } else { "online.humumu.ccdeck.relay" } }`，`relay_service_registered` / `write_relay_service_plist` / `toggle_sync` 三处消费点改调函数。命名与 Leader 手工 M2 服务一致（该命名已被现场权威化），也让 W-RELAYCVG 的拓扑收敛有稳定 label 规范可引。补一条单测（main.rs 已有 `check!` 自测段，:1396 deck_root 测试同款写法）。
2. **G2 → env 集同源**：把 `spawn_embedded_relay` 的 `extra_env` 构造抽成 `fn relay_variant_env(home: &str) -> Vec<(String, String)>`，内嵌 spawn 与 `write_relay_service_plist` 两处共同调用——**一处构造、两处消费**，杜绝下次再加变体 env 时两处漂移。plist 渲染按 env 列表逐项生成 `<key>/<string>` 对。
3. **G4 → 文案修正**：main.rs:835 指引改「可在设置 → relay →『开机自启』停用系统服务」（终端脚本降为备用的口径已在 4d88cb9 定立）；:1122 错误消息的日志路径走 `deck_root`。
4. **顺手**：`relay_service_status` 返回值加 `label` 字段（排障时用户能对照 `launchctl print` 输出）。

MVP 不动前端（三重门/卡/toast 已就绪），不动 supervisor 协同（已验证设计）。

### 1.3 升级路径

- **App 升级**：Tauri updater / 重装原地替换 `.app`，plist 引用的 bundle 内 relay.mjs **路径不变内容随版本更新**——服务下次拉起自动用新脚本，零动作。这是选 bundle 引用而非数据目录副本的决定性理由（G3 手工 plist 的副本方案无此性质）。
- **node 升级/卸载**：MVP 靠 status 里探 `node_path()` 存在性 + 错误透出；完整版由 G5 自愈兜底。
- **plist 本身**：每次开启都全量重写（幂等），不做增量迁移。

### 1.4 卸载路径

- 关开关 = bootout + 删 plist + 内嵌回退（已实现）。
- 卸 app 未关开关：MVP 接受脏状态（ThrottleInterval 5s 兜底）；完整版在 G6 出一份「卸载前先关开关」的卸载说明 + 可选：服务启动脚本探测 bundle 缺失时自行 `bootout` 自清理（relay.mjs 首行判断脚本自身路径存在性即可——但脚本就是 bundle 内文件，被删即无从执行，**此路不通**；替代：完整版 plist 的 ProgramArguments 换成一个落在数据目录的薄 wrapper.sh，wrapper 探测 bundle 存在再 exec node relay.mjs，bundle 没了 wrapper 主动 bootout 自身。成本一行脚本，收益是零脏状态——列入完整版可选件）。

### 1.5 风险

| 风险 | 评估 | 缓解 |
|---|---|---|
| 切换瞬间 relay 重启 1-2s，ws 断 | 低：前端已 toast + 自动重连；消息/事件落数据目录（events.ndjson / sqlite） | 排队注入消息的持久化行为**待确认**（见 §6 开放问题），若纯内存则切换窗口内丢——W-RELAYCVG 产出可回答 |
| 双变体同机都开服务 | G1 修复后 label/端口/数据目录三重隔离，理论安全 | MVP 单测覆盖 label 函数；验收含双变体并行项 |
| dev 壳开开关指向 target/debug 资源 | 开发机专属，普通用户不可达 | debug 构建下 toggle 返回提示「dev 壳不提供系统服务化」（一行 cfg 门控，可并入 MVP） |
| launchctl 系统级失败（权限/签名） | 罕见 | 现有错误透出链路已够 |

---

## 2. 形态 B：插件形态承载（否决，论证如下）

cc-plugins（`cc-plugins/plugins/cc-deck`，plugin.json v0.2.38）的机制本质：**Claude Code CLI 的会话侧钩子**——hooks 自动把 CLI 会话桥接给手机、`/cc-deck` 命令以守护方式起 relay、`/cc-deck-stop` 停。它服务的是「CLI 用户在会话里顺手起 relay」的场景。

让插件承载「relay 系统服务化」，三重错位：

1. **生命周期错位**：插件的生命周期锚在 CLI 会话/插件安装上；服务化要的是**机器级、登录级、开机级**常驻（RunAtLoad + KeepAlive）。插件被卸载/升级时服务怎么办？插件在 N 台机器装、用户只想在其中 1 台常驻——粒度对不上。
2. **UI 承载错位**：开关需要一个用户可发现的操作面与状态面。桌面壳有设置页、有 toast、有状态行、有三重门可见性机制；CLI 插件没有 UI，只能靠 slash 命令 + 终端输出——把 G7（发现性）从「藏在设置深处」恶化成「根本无处可看」。
3. **变体逻辑重复**：label/端口/数据目录按变体生成（M2_BUILD 编译期常量、deck_root）的全套逻辑在壳侧最全且已被单测覆盖；插件侧要靠运行时探测 app 变体（读 bundle 名？读目录存在性？），重复实现且必然漂移——G2 这类 env 对齐问题会在第二处实现里再犯一遍。

**结论：B 否决。** 但插件体系保留一个远景衔接位：纯 CLI 用户（不装桌面壳）的服务化入口未来仍只能走插件或独立 CLI——即形态 C 的 CLI 变体；届时插件只做「引导文案 + 指向同一 plist 规范」，不own 实现。

---

## 3. 形态 C：第三形态（推荐 CLI 查诊变体，完整版档）

候选了三条路，取舍如下：

| 候选 | 判断 |
|---|---|
| C-a 安装器/首启引导页默认开启服务化 | **过激**：常驻是隐私/资源偏好，默认替用户决定违背产品一贯的「自动启用但可关」口径（#334 自动启 relay 是应用生命周期内的，开机常驻高一级）；且首启用户还没有「退出壳断线」的痛感，引导无的放矢 |
| C-b 退出挽留弹窗（退出壳时若服务未开且 relay 有活跃客户端 → 弹一次「要保持手机可连？」） | **好，但归入形态 A 的完整版**（G7 的落地手法），不算独立形态 |
| **C-c 独立 CLI：`ccdeck-service status / doctor`（只读查诊）** | **推荐为独立第三形态**，完整版档落地 |

### C-c 设计

- **是什么**：`~/.cc-deck/bin/ccdeck-service`（与 org CLI `~/.cc-deck/bin/org` 同落位的薄 zsh 脚本），子命令 `status`（服务注册否/跑否/端口/label/数据目录/node 可达性）、`doctor`（plist 内容与当前期望比对，漂移逐项列出）。
- **为什么是只读**：enable/disable 的权威实现留在壳内（G1/G2 修复后变体逻辑、env 同源、占用守卫都在 Rust 侧）；CLI 再实现一套写路径 = 形态 B 第三条错位的重演。只读查诊无此问题，且直接服务两个真实场景：①Leader/W-RELAYCVG 收敛手工服务时的**检查工具**（今天这活靠肉眼对着三个 plist）；②远程值守排障（手机端看不了 launchctl，SSH 一条 `doctor` 出全貌）。
- **技术落点**：纯 zsh，读 plist + `launchctl print` + `lsof`，零新依赖；期望值来源硬编码与 main.rs 同规范（label 变体规则/端口/deck_root——端口权威值等 W-RELAYCVG 产出后对齐，见 §7）。
- **升级/卸载**：脚本无状态，随 `~/.cc-deck/bin` 分发即升即弃。
- **风险**：与 main.rs 规范双处维护漂移——缓解：doctor 的期望值只含稳定规范（label 命名规则/端口/deck_root），不含易变细节；§7 与 W-RELAYCVG 的拓扑文档定为规范权威。

---

## 4. 推荐方案汇总与两档切分

**推荐：A 主线（基线补全）+ B 否决 + C-c 完整版补充。** 理由：用户诉求（「打开一个开关，退出应用壳 relay 照跑」）恰好就是 #196 已交付的东西，剩余工作是把 M2 变体从「走不通所以手工配」修到「开关即达」，工作量小、风险面窄、全部落在已验证的结构内（supervisor 让位逻辑零改动）。

### MVP（最小改动版——M2 变体正确性闭环，替代今晚的手工服务）

| 项 | 内容 | 落点 |
|---|---|---|
| 1 | G1：`relay_service_label()` 变体化 + 单测 | main.rs:967 及三处消费点 |
| 2 | G2：抽 `relay_variant_env()`，内嵌 spawn 与 plist 生成同源消费 | main.rs:765 / :1028 |
| 3 | G4：两处文案修正（指引指设置卡；日志路径走 deck_root） | main.rs:835 / :1122 |
| 4 | dev 壳 cfg 门控（debug 构建返回「不提供系统服务化」） | toggle_sync 入口 |
| 5 | `relay_service_status` 加 `label` 字段 | main.rs:1062 |

MVP 验收点（装机真验用）：①M2 壳开开关 → `launchctl print gui/501/online.humumu.ccdeck.m2.relay` 命中、端口 8788、数据 `~/.cc-deck-m2`；②记录 `bridge-token` 文件 hash → 开关切换 → hash 不变（token 连续性）；③退 M2 壳 → 手机 M2 服务器在线、挂着的会话可收发；④生产变体（8787）全程不受扰、其 `bridge.json` 未被 M2 服务改写；⑤拨回关 → 内嵌 1.5s 接管、再退壳恢复断线现状。

### 完整版（在 MVP 之上依次叠加，可按批拆）

| 项 | 内容 | 价值 |
|---|---|---|
| 6 | G5：启动时 plist 漂移检测+自愈（enabled 且 plist≠期望 → 幂等 bootout+重写+bootstrap+kickstart，代码现成） | node 升级等场景自动修复，服务不再静默劣化 |
| 7 | G7/C-b：一次性退出挽留（退出壳时 enabled=false 且 relay 有活跃 ws 客户端 → 弹一次引导，记住选择不再问） | 痛点发生的那一刻就是最好的教育时机 |
| 8 | G9：`relay_service_status` 接入 `probe_relay_port` owner 分类，卡上可现「服务注册但异常」态 | 异常可见，排障成本降一档 |
| 9 | C-c：`ccdeck-service status/doctor` 只读 CLI | 收敛工具 + SSH 排障通道 |
| 10 | G6：plist wrapper 薄脚本（bundle 缺失时自清理）+ 卸载说明 | 零脏状态卸载 |
| 11 | G8：Windows 任务计划器等价实现（`schtasks /sc onlogon` + 崩溃自拉用计划器重复间隔模拟 KeepAlive） | 平台对齐，独立排期 |

---

## 5. 与内嵌 relay 的协同矩阵（四象限行为定义）

| | **应用开启** | **应用退出** |
|---|---|---|
| **服务已注册** | 启动探测端口已被占 → 内嵌不拉（main.rs:1180），supervisor 让位；relay_status：active ✓ embedded ✗；壳作为**客户端**复用服务（探测端口+握手，现成逻辑）。设置卡显示「开」。 | **服务独立生存**：KeepAlive 崩溃自拉（5s 节流）、RunAtLoad 开机即起；手机/会话全程无感——**用户诉求象限**。壳的 `kill_embedded_relay` 无事可做（内嵌本就不存在）。 |
| **服务未注册** | 启动自动启用（#334）：内嵌 spawn + 9s 就绪等待 + supervisor 1.5s 拍监督 + 指数退避；与现状一致。 | **现状痛点象限**：`kill_embedded_relay` → 端口空 → 手机断线、排队消息危。MVP 后该象限仅存在于用户主动不开服务的场合——由完整版第 7 项（退出挽留）负责最后一道教育。 |

矩阵隐含的一条安全性质：**任一时刻端口上只有一个 relay 实例**（内嵌 spawn 前探端口、服务开启前停内嵌+守卫外部占用、supervisor 让位规则三方一致），不存在双实例抢写数据目录；`data/relay.lock` 与 sqlite WAL 兜底。

---

## 6. 风险与开放问题

1. **切换窗口的排队注入消息**：内嵌↔服务交接时 relay 进程重启 1-2s。事件/状态已落盘（events.ndjson/sqlite），但**注入队列是否持久化未核实**——若是纯内存，切换瞬间排队的注入消息会丢。→ 待 W-RELAYCVG 产出或读 relay 源确认；若确认会丢，完整版可在 toggle 前加「等队列清空再切」的前置条件（一行探测）。
2. **launchctl 的 gui domain 假设**：现实现走 `gui/{uid}` domain（macOS 10.11+ 标准路径），macOS 13/14/15 实测环境单一（自家 Mac），风险低；未来若支持多用户/SSO 场景需重审。
3. **KeepAlive 崩溃循环的可观测性**：node 被删等场景服务会 5s 一拍地失败重启，MVP 阶段用户侧表现是「开关显示开但连不上」——G9（完整版）落地前，排障依赖 doctor CLI 或 `relay-service.log`。MVP 验收单里放一条「异常态可被日志定位」的降级验收。
4. **G3 手工 plist 的收敛归属**：替换手工服务是运维动作（W-RELAYCVG 地盘），本设计只供规范（label 命名 / bundle 引用口径 / env 清单）。**在 G2 修复上线前，手工 M2 服务不宜直接换成产品化开关产物**——否则踩回覆写生产 bridge.json 的坑。

## 7. 与 W-RELAYCVG 的衔接

- 本设计输出给它的三个规范：label 变体命名规则（`online.humumu.ccdeck[.m2].relay`）、relay.mjs 引用口径（**app bundle 唯一正解**，数据目录副本属待收敛遗产）、服务 env 清单（= 内嵌 spawn env 全集，MVP 第 2 项落成单一构造函数）。
- 它回填给本设计的一个权威值：**端口分配表**（8787/8788 现值是否维持、未来是否让位）——C-c doctor 的期望值与 plist 生成的端口来源届时对齐其产出。
- 时序建议：MVP 不等它（label/env 修复独立成立）；它交付后跑一次四 plist（生产手工/M2 手工/两变体开关产物）对照收敛，C-c doctor 作为验收工具。

---

*自测声明：本任务为纯设计交付，无代码改动；文中全部现状断言均核实于 dev 工作区源码（main.rs / web-console/index.html）、两个手写 plist 实读与 `~/.cc-deck-m2/data/` 实查，未运行构建。*
