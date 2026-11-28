# 可见面单一事实源契约（DEV-58 · 元能力 P0②）

> 2026-11-28 定稿。输入：`docs/product-review/product-review-2026-11-28.md` P0-2（元能力）＋
> `docs/design/status-vocabulary.md`（六态词汇表=词汇单一源）＋ DEV-50 liveness 端上消费落地现状
> ＋ `docs/night-audit/updated-at-writers.md`（写手台账）＋ `docs/design/task-lifecycle.md`（任务轴
> SSOT 定案）＋ `docs/product-review/arch-review-2026-11-28.md` §2.4/R4（三端规则复制）。
> **地位**：与状态词汇表互为表里——词表管「态长什么样」，本文管「态从哪来、谁许写、端上许做什么」。
> 所有新可见面（任何端的状态位）上线前必查本文契约；违契约即审查退回项（与词表同闸）。

## 〇、为什么需要这份契约

用户两月 121 次催办里相当比例是「状态看不见/看见了不对」：板面说谎 ≥6 现（R4/R12）、空闲跳序四现
（R1）、「进行中 7 审查中 10 显然不对」（11-09 用户明示）、「怎么全都空闲了」活性误报三现同谎
（11-11）。夜审定性（defect-ledger §五）：**修现象不修注册面**——每轮修掉一个写手/一个乱面，留下
同类复发面；DEV-40（词表）与 DEV-50（liveness 消费）已把「词汇」和「信号」落地，本契约补最后一块：
**可见面本身的取数与拼装边界**。

## 一、可见面清单（现状盘点）

> 2026-11-28 全量扫描定稿（web 五域 js / expo 全屏 / relay 下发面三路并行盘点+抽查核验）。
> 「拼装方」列：**relay** =端上拿到即渲染；**端上** =端上 JS/TS 从原始字段现算词/色/判定——后者是契约差距的聚集地。
> 桥副本（bridge-core.js）=桌面壳离线/桥态下的 IIFE 复制域，与主壳同口径双份；手机=web-console 手机视图（mobile.js）。

### 1.1 轴 A｜会话/成员运行态（六态+liveness）

| 位 | 端 | 文件:行 | 数据源 | 拼装方 |
|---|---|---|---|---|
| 会话卡状态点（六态+活性五档 class 链） | web | session-domain.js:1502（判定 :1348-1355） | SNAPSHOT+增量帧 status/liveness/pm_standby | 端上拼 class 与 title 词 |
| 会话卡秒计时/回合计时 | web | session-domain.js:1360,5945 | turn_started_at（帧） | 端上 1s 定时器 |
| 卡面徽章（⑂N 后台/等你拍板/已派单/离席成因） | web | session-domain.js:1319-1359 | subagents/waiting_request（帧）+本地派生队列 | 端上 |
| 卡 idle 置灰（#160） | web | session-domain.js:1271-1274,5955-5963 | updated_at+localStorage 阈值 | **端上判 S6** |
| 状态坞（态图标+语义动作+计时） | web | session-domain.js:96（DOCK_STATE）,2705-2765 | status/action_summary/waiting_request | **端上拼词**（B21 自成词面 running/waiting/suspended/closing） |
| 子 Agent 面板计数 | web | session-domain.js:2774-2788 | subagents（帧） | 端上 |
| 检查器会话胶囊/成员灯/任务清单 | web | session-domain.js:95,2861-2886 | s.status/s.todos | 端上查表 |
| 「更多」tab 状态行 | web | session-domain.js:4346-4356 | s.status | 端上（**第五套词面**） |
| 团队抽屉 roster 行灯（lamp-dot） | web | session-domain.js:1640-1642 | S.sessions+headcount | **端上**（词色两表内联） |
| 团队抽屉「在办 N」+六泳道比例条计数 | web | session-domain.js:1583,1601-1632 | S.boards（帧） | **端上数** |
| 团队 chip 活跃数/置灰 | web | session-domain.js:1291-1309 | headcount×sessions+isRealWorking | **端上算**（#291 端上判） |
| 列表筛选档/排序比较器 | web | session-domain.js:1793-1800,1995-1999 | status+updated_at/pinned | 端上（排序=状态呈现的一部分） |
| 检查器待命判定（#291 isRealWorking） | web | session-domain.js:905-926 | last_tool_use_at（帧原料） | **端上派生**（三端手抄之一） |
| 成员卡角灯/胶囊+心跳信号（good/warn/bad） | web | team-domain.js:107-118,210-239 | SNAPSHOT.sessions（仅快照）+last_heartbeat_at/last_business_log_at | **端上判活**（10/30min 阈值分档——roster 面活性） |
| 成员排序（PM→WORKING→WAITING→排队→闲置） | web | team-domain.js:129-150 | 同上+receipts 本地派生 | 端上 |
| 手机卡 tag/状态坞/更多行/进行中组/任务板三泳道 | web | mobile.js:32-78,192,412,629-674,756 | bridge.sessions（B4 桥副本帧） | 端上（含 #291 借道全局 isRealW :33-34） |
| 项目域 vrow 徽章/teamRows 成员徽章/项目卡聚合点 | web | bridge-core.js:678-680,795,906-958 | bridge.sessions | 端上（VROW_K 词表+pc3 豁免点） |
| 占位会话卡（B2 接管前首帧） | web | settings-domain.js:2494-2516 | 地基快照 | 端上（主壳映射的镜像副本） |
| SessionCard 灯（liveness 五级优先级 dotColor） | expo | ListScreen.tsx:1008-1016 | UPDATED.status+HEARTBEAT.liveness | 端上复合；liveness 三值映射=DEV-50 落 |
| SessionCard 摘要行/LiveStat/Elapsed | expo | ListScreen.tsx:821-870,1090-1110 | 帧字段 | 端上 |
| 团队入口卡角灯+mini 灯行 | expo | ListScreen.tsx:757-795 | snap.sessions | 端上 |
| 统计行四态 chips+图例 | expo | ListScreen.tsx:1433,1961-1964 | sorted 计数 | **端上数** |
| 活动坞 dockLine（词+呼吸点+走秒） | expo | DetailScreen.tsx:3150-3170,status-dock.ts:51-74 | SESSION_ACTIVITY 帧（seq_local 乱序闸） | 端上投影；dockColor WORKING=绿/WAITING=黄（:2159，词表矩阵外） |
| StatusStrip 终态收口/审批横幅/TeamPane 泳道计数 | expo | DetailScreen.tsx:1404-1438,2141-2152,54-116 | 帧 | 端上（TEAM_LANES/laneInk 局部词表） |
| 活性判定 isRealWorking | expo | protocol.ts:1138 | last_tool_use_at | **端上派生**（三端手抄之三） |
| PM 成员灯+词 | expo | DetailScreen.tsx:63,151-171 | snap.sessions | 端上（PM_STATUS_ZH） |

### 1.2 轴 B｜任务板态（五态）

| 位 | 端 | 文件:行 | 数据源 | 拼装方 |
|---|---|---|---|---|
| 六泳道看板+卡位 | web | team-domain.js:3,502-560 | **relay**：SNAPSHOT.boards+BOARD_UPDATED（含 projection 卡位）+COMMAND_PROJECT_DETAIL | 泳道归并端上按 status；**卡位真相=relay 投影**（:507-518 有投影用投影） |
| 「进行中 N 审查中 N」计数图例/比例条 | web | team-domain.js:527,554 | board entries（帧） | **端上数**（relay 不给计数） |
| 任务卡色条/派单回执 chips | web | team-domain.js:418,585-586,669-712 | lane key/receipts（帧） | 端上 |
| 板账异常红条（stuck 卡） | web | team-domain.js:543-552 | **relay**：board.health 随 BOARD_UPDATED | relay 给 kind，端上译人话 |
| todos 分组（◐/○/✓+#85 待验证档） | web | session-domain.js:2886 | s.todos（帧） | 端上 |
| 手机 todos 四组/任务板 | web | mobile.js:228,321-336,756 | s.todos/会话态 | 端上 |
| PM 会话任务 tab 镜像（板→TodoItem） | relay | board-mirror.ts:68-97（纯读投影） | 看板文件→setTodos 咽喉合成 | **relay 单向镜像**（task-lifecycle §2 定案） |
| 五色总览条+台账卡/六泳道计数 | expo | TeamDetailPage.tsx:143-185,592-600 | BOARD_UPDATED delta（org-delta.ts:188-212 锚定才并）+BOARDS_DIGEST 对账+resync | **端上数**（LANE_COLORS/MEMBER_ST_ZH 局部词表） |
| 看板词表/成员灯/org 三态胶囊 | expo | OrgZone.tsx:49-64,OrgTabs.tsx:240 | 帧 boards/sessions | 端上（BOARD_LANES 注释自认与 relay 对齐靠纪律） |
| 验收单状态四词 | expo | ProjectDetailPage.tsx:210-212 | ACCEPTANCES_UPDATED/SNAPSHOT | 端上内联 |

### 1.3 轴 C｜设备/服务/连接态

| 位 | 端 | 文件:行 | 数据源 | 拼装方 |
|---|---|---|---|---|
| 连入设备台账（在线/离线/冷却/忽略） | web | settings-domain.js:1626-1695 | **HTTP /api/device-admin**（非 ws） | relay 给态，端上拼词色 |
| 源列表/其他电脑行（在线/离线/上次在线） | web | settings-domain.js:636-728,808 | ACCT_RELAYS 帧+SNAPSHOT.acct_relays（云口同名键丢弃防视角污染） | 端上 |
| 设备清单（已配对+踢出） | expo | SettingsPage.tsx:1329-1400 | COMMAND_PEERS ACK 拉+PAIRED_DEVICE 触发重拉 | 端上（peerKindLabel「relay 派生优先」） |
| 服务器卡四态灯+connText 三色 chip | expo | SettingsPage.tsx:848-914;App.tsx:1082 | **本地连接状态机**（connStatusPatch store.ts:723-802） | **端上**（连接态=端上自判被观察对象） |
| SetupScreen 连接指示三态 | expo | SetupScreen.tsx:473-497 | snap.connState/failNote（本地） | 端上（连不上=红 #357） |
| relay-devices（设备 online） | relay | devices.ts:16-84,ws-server.ts:606-607,1824 | 活连接集注入 online，**仅随 SNAPSHOT 下发，无增量帧** | relay |
| 桌面壳网页状态行（端口/内嵌/node/err） | desktop | desktop-tauri/src/main.rs:423,999-1012 | Rust spawn 探测（NODE_OK 缓存） | **壳侧拼装**（手搓 JSON） |
| 引擎登录徽章（ready/needs_auth…） | web+expo | protocol.ts:91,NewSessionModal.tsx:56,395-441 | SNAPSHOT.source_capabilities+AUTH_REQUIRED 帧 | 端上（ENGINE_STATE_LABEL 三端同词靠纪律） |
| 席位在场/离线计数（「编制 N 席·离线 N」） | web | team-domain.js:1211-1215 | 快照在场性 | 端上 |

### 1.4 盘点总结论（给差距表定位）

1. **写侧已收口（比预期好）**：relay 侧 status 翻转过 `transition()` 单点（34 处调用，2 处备案直写）、updated_at 过 `touchIfChanged()` 单点（30 处）、板写经 `saveBoardFile()` 单漏斗；下发面 EventBus 单通道、LAN/云双出口键级对称。**「可见面说谎」的病根不在写侧漏写，在读侧各自派生。**
2. **判定与计数分裂是最大未收口面**（relay 盘点结论）：#291 待命判定三端手抄（原料 last_tool_use_at 写手在 relay，判定却下放端上）；六泳道计数、在跑 N、mini 灯行、统计 chips 全部端上现算（relay 内部 `realActiveManagedCount`/`realGroupLiveWorkers` :11599/:11614 有现成计数面不下发）——三端三算=口径漂移面（「进行中 7 审查中 10」事故的结构土壤）。
3. **词/色映射表全仓 30+ 处字面量表**（web ~20+expo 10+），词面多套并存（待处理/等待确认/待确认、完成/已完成/空闲）；状态坞与 dockColor 是词表矩阵外的自成层。
4. **roster 成员活性=端上判活**（signalTone 心跳/日志 10/30min 阈值），未消费 relay liveness——「怎么全都空闲了」误报家族的 roster 面。
5. **设备态无增量帧**：上下线要等下次 SNAPSHOT 收敛。

## 二、单一事实源契约

### 2.1 三条状态轴，各有唯一源与唯一写手

**轴 A｜会话/成员运行态（六态 + liveness 覆核）**

- **唯一写手**：relay `session-manager`。status 翻转、`touchIfChanged`（updated_at 单点，DEV-31 收
  编后 relay 侧裸赋值仅守卫体内 1 处）、`displayLivenessOf` 真活性三值判定，全部在 relay 完成。
- **唯一下行通道**：SNAPSHOT（全量装配，会话对象约 45 键含快照专有 pm_standby/liveness）＋
  SESSION_HEARTBEAT（5s 捎带 liveness/updated_at 帧完整性键）＋ 增量帧（SESSION_UPDATED 经
  MERGE_KEYS 34 键白名单合并/LOG/WAITING/ERROR/DONE 等）＋ resume 对账帧（SESSIONS_RECONCILE/
  BOARDS_DIGEST）。**MERGE_KEYS 是增量合并契约**：增量帧键 ⊆ 快照键 ⊆ 端上可消费面，探针
  （probe-liveness-shot）锁第一层包含关系；新增下发键必须同时进三层并补锚（DEV-50 的 liveness
  即范例：收键 :930→清陈标 :968→心跳入账 :990）。
- **端上零写**：心跳不洗 updated_at（专用键 last_heartbeat_at）、日志只刷 last_tool_use_at（#291）、
  状态翻转不本地造时刻——updated-at-writers 台账三律已三端落地。

**轴 B｜任务板态（五态：backlog/claimed/submitted/ready_to_install/done）**

- **唯一事实源**：org 看板文件 `<orgDir>/boards/<gid>.json`——task-lifecycle §2 用户拍板原文「面板
  各处任务展示/汇报/追踪全部基于任务表，强制执行不许到处不同步」。
- **唯一写手**：relay（派单联动建卡/收口搬卡/org 命令）。端上看板渲染只消费 `emitBoard` 下行帧；
  PM 会话任务 tab = board-mirror 单向镜像（source="board"，禁止反向写）。
- **已知数据面前置债**（不在本文修复范围，但可见面契约依赖它成立）：板文件四写口全量覆盖写无
  journal（DL-P1-4）；boardrecon 对账 observe 干跑（auto-tiers 默认档）。

**轴 C｜设备/服务链路态（relay 活、端口监听、node、云桥连接）**

- 现状由「被观察对象的监督者」各自拼装：桌面壳 Rust `relay_status_value`（port/embedded/node/err）
  喂网页状态行；expo 连接指示消费自持探测；云桥 heartbeat 走独立链路。
- 契约口径：轴 C 的**判定**天然分散（监督者各判各的被监督对象），但**呈现**仍受词表约束——服务
  未起/连不上=红（#357 定版），离线/未同步=灰（S6 相），不许发明「服务态」专属色。

### 2.2 派生规则单点：relay 派生，端上零派生

- 六态判定（词表 §一判定列：status × isRealWorking × waiting_request × offline 事件）全部在 relay
  侧完成，**端上拿到的已是终态**（status + liveness），不需也不许再判定。
- liveness 三值覆核（词表 §七）同理：relay `displayLivenessOf` 复合判定（pid kill-0/SDK 流活/帧龄），
  端上只按固定映射呈现（alive 零覆核 / between-turns 降 S2 / dead 出 S6 形）。
- **派生上移清单**（现状在端上、契约归 relay 的判定——差距表 G1/G2/G4 的契约依据）：
  ① #291 待命判定（isRealWorking）→ relay 捎带 `standby` 布尔；② 板面/会话域计数 → relay 随帧
  下发 counts；③ roster 成员活性分档（signalTone）→ 消费 liveness/relay 下发成员 signal。端上拿
  原料自判的一切「活性/计数」面都属此类——relay 判定一次下发 N 端，好过 N 端各判一次。
- 端上唯一允许的「映射」是**渲染字典**：键=六态枚举（+liveness 三值覆核形），值=词面/色相/glyph
  （内容=词表 §三矩阵）。渲染字典不是派生规则；三端各持一份但**键集与色相必须一致**（跨端机器锚，
  见 2.4）。

### 2.3 边界定义：端上只消费不拼装

端上**允许**做：

1. 渲染字典查表（六态/liveness → 形）；
2. 帧合并入账：过 MERGE_KEYS 白名单 + updated_at 三律守卫（缺载不推进/同值回拨不洗/force 仅真态变）；
3. 纯本地 UI 态（选中/展开/过滤/本地排序偏好）。

端上**禁止**做（违者=审查退回项，与词表违律同闸）：

1. **从原始信号推断状态**——帧频/日志时间戳/ elapsed 自判「空闲/挂死」。历史事故源：11-11 帧频判活
   三现同谎；端上判活一律回 relay displayLivenessOf。
2. **本地造状态时刻**——`x.updated_at =` 裸赋值（test-updated-at-guard 源码锚已锁，新增写手必须过
   touchUpdatedAt/touchIfChanged 口）。
3. **自算板面计数**——「进行中 N/审查中 N」是板态派生值，派生归 relay；端上只显示下发值。
4. **新增态名/色相/词形**——词表铁律（映射不进六态=设计变更单）。
5. **绕过白名单改会话对象**——MERGE_KEYS 之外的字段不经合并口直写本地态。
6. **直读/直写板文件**——端上板面一律消费下行帧；任务 tab 一律消费镜像。

### 2.4 契约的机器锚（reviewer 护航点）

| 锚 | 现状 | 迁移目标 |
|---|---|---|
| 快照字段 ⊆ MERGE_KEYS 对账 | probe-liveness-shot 探针级（CI 接线归 DEV-42 锚批） | 进 CI 矩阵（M1） |
| updated_at 守卫源码锚+行为锚 | test-updated-at-guard 三端面+relay R 组已锁（56 项） | 保持；新端接入即补锚 |
| 渲染字典跨端对齐锚 | **缺**——三端字典各自维护，键集漂移无测试 | 新增源码锚：三端字典键集一致（M1 锚现状）→ 键+色相双断言（M4） |
| 板面计数对账 | boardrecon observe 干跑（DL-P1-4） | 通电拍板后：抽查板面=dispatch-log 100% 一致机器化（M3 验收②，批 A 前置） |
| 空闲 60s updated_at 不变 | relay 面等价断言已在（R4 组「同值重报×12」） | 真机静置 60s 零跳序入装机回归轮清单（已列） |

## 三、差距表（现状 vs 契约）

> 量级：S≈半天内 / M≈1-3 人日 / L≈一周级。**P0/P1/P2** 为不还的利息定级（对齐 arch-review 分级习惯）。

| # | 差距（现状 → 契约） | 位 | 量级/级 |
|---|---|---|---|
| G1 | **#291 待命判定三端手抄**（web session-domain.js:905-926 / mobile.js:33 / expo protocol.ts:1138；判定原料 last_tool_use_at 的写手本在 relay :3395/:4228，判定却在端上做了三份）→ 判定上移 relay：快照+心跳捎带 `standby` 布尔，端上三份退役 | 轴A 判定 | **M/P1**——三端口径漂移=「待命/在跑」互斥谎的制造机 |
| G2 | **计数全端上算**（boardCounts team-domain.js:527、在办 N session-domain.js:1601、团队 chip :1306、expo 统计行 ListScreen.tsx:1433、TeamPane/TeamDetailPage 泳道计数；relay 有 realGroupLiveWorkers 不下发）→ relay 随 BOARD_UPDATED/SNAPSHOT 下发 counts，端上计数逻辑全部退役 | 轴A+B 计数 | **M/P1**——「进行中 7 审查中 10」的结构土壤 |
| G3 | **词/色映射表 30+ 处字面量表、词面多套**（详见 §1.4-3）→ 每端收口单一渲染字典模块（键=六态+liveness 三值+连接态枚举），跨端键集源码锚；词面差异呈词表变更单定版 | 全端 | **M/P1** |
| G4 | **roster 成员活性端上判活**（signalTone team-domain.js:108-118 用 last_heartbeat_at/last_business_log_at 10/30min 阈值分档 good/warn/bad）→ 消费 relay liveness（成员卡=会话卡同源）或 relay 下发成员 signal；违 §2.3-1 禁令的现存最大位 | 轴A roster | **M/P0**——「怎么全都空闲了」121 催办家族 roster 面（词表 §七消费面收口卡面灯=DEV-50 有意留的面） |
| G5 | **expo SESSION_UPDATED 不并 liveness**（store.ts:2679-2727 逐键合并无 liveness 分支；仅心跳 :2748+快照直通）→ 对齐 web MERGE_KEYS 收键 | expo 轴A | **S/P1**——增量面丢键=DEV-50 在 web 侧修过的机械根因，expo 面同病未修 |
| G6 | **idle 置灰 #160 端上判 S6**（session-domain.js:1271-1274+localStorage 阈值）→ 判定入域包单点（纯显示降级可留端上，阈值口径必须单点） | 轴A | **S/P2** |
| G7 | **状态坞/DOCK_STATE 自成词面**（running/waiting/suspended/closing，web :96+expo status-dock.ts；expo dockColor WORKING=绿 :2159 在词表矩阵外）→ 词表 §三/§四登记该层（豁免或归位，设计变更单） | 轴A 词面 | **S/P2**——矩阵外层=词表「唯一词汇源」的旁门 |
| G8 | **updated_at 三律三份手抄**（session-domain.js:954-961/bridge-core.js:272-279/expo store.ts:269-277——DEV-40 已补齐律②，现状合规但三份复制）→ @ccdeck/domain 域包单点（**承接 arch-review R4 根治件**，不另立方案） | 轴A 规则 | **M~L/P1** |
| G9 | **设备态无增量帧**（online 仅活连接集注入+SNAPSHOT 下发，devices.ts:79-84；设备插拔上下线要等快照收敛）→ DEVICE_UPDATED 增量帧 | 轴C | **M/P2**——真机设备 23 台回连 4s 可见靠快照撞运 |
| G10 | **桥副本死词表漂移种**（bridge-core.js:678-680 STATUS_WORD/TAG 无消费面防复活注释即自认；vrow 注释「运行中绿实底」与 base.css:3905 已归黄不符）→ 删死表+修注释 | 桥副本 | **S/P2** |
| G11 | **桌面壳 relay_status 手搓 JSON**（main.rs:999-1012，轴 C 无契约成文）→ 契约补轴 C 节：服务态判定词面/色相归口（连不上=红 #357 已定版，其余态未入表） | 轴C | **S/P2** |
| G12 | **elapsed_hint 死字段**（心跳捎带 store.ts:2744 入账后零 UI 消费）→ 删或接消费 | expo | **S/P3** |
| G13 | **boardrecon 对账 observe 干跑**（auto-tiers.ts:50 缺省档；DL-P1-4 已列批 A）→ **本文前置依赖非本文范围**：可见面「计数=dispatch-log 100% 一致」机器断言需对账器通电后才有执行者 | 轴B 数据面 | 前置（批 A 承接） |
| G14 | **渲染字典跨端对齐锚缺**（§2.4 表）→ 随 G3 一并落 | 锚 | S（并入 G3） |

**已合规面（不列差距，防重复施工）**：relay 三单点（transition/touchIfChanged/saveBoardFile）；liveness 数据链+卡面消费（DEV-50 web/expo 已落，含终态清陈标）；板面数据 relay 下发（含 projection 卡位真相+delta 锚定合并+BOARDS_DIGEST 对账+resync 三保险）；expo updated_at 守卫（DEV-40 收编——arch-review R-5/R4 立即件实际已闭环，报告陈账）；PM 任务 tab 单向镜像；连接态 connStateTone 词面（protocol.ts:1068 与 web 同款）。

## 四、分步迁移路径

> 基线意识：test.37 装机回归（2026-11-28）R1 空闲跳序/R6 六芒星/R12 板面新鲜度已采样过闸——
> 本路径不是修当前红面，是把「已绿」变成「结构性不会再红」：每步收口一个注册面，配机器锚。
> 顺序原则：先锚后拆（对账锚先通电，再动拼装点）；小步独立可合并；每步过 CI 矩阵+装机回归轮。

### M1｜锚先行（G5+G14，S，随 DEV-42 锚批搭车）

- 内容：① probe-liveness-shot（快照字段⊆MERGE_KEYS 对账）进 CI 矩阵；② expo SESSION_UPDATED 补 liveness 合并分支（对齐 web）；③ 渲染字典跨端键集锚——单测提取三端字典常量键集断言一致（此时字典尚未收口，先锚现状键集，防漂移扩大）。
- **验收**：CI 矩阵新键绿；expo 增量帧 liveness 单测（值变才重渲+终态清陈标对齐 web X 组锚）；键集锚测试绿。reviewer 护航点=三条测试键名进矩阵单源清单。

### M2｜判定上移：standby 与成员活性（G1+G4，M，元能力 P0 专批）

- 内容：① relay 快照+SESSION_HEARTBEAT 捎带 `standby` 布尔。判定原料本就在 relay 手里（last_tool_use_at 的写手即 relay 建卡置 0+工具帧咽喉刷新 ：3395/:4228），上移=在源头算一次，不是新写第三份；注意与 liveness 分工：#291 standby=「有没有近期工具活动」（S1/S2 分档），liveness=「进程还在不在」（§七覆核）——两判定同在 relay 派生后，端上三份 isRealWorking 退役（源码锚：引用计数=0）。② roster signalTone 改消费 liveness/成员 signal（relay 侧成员聚合随快照 projects headcount 富化一列）。灰度期 A/B：下发言与端上旧算法双算对账入审计流，零差异 N 天后拆旧。
- **验收**：①源码锚——`isRealWorking` 定义处=relay 一处，端上 grep 计数=0；②A/B 对账审计流连续 7 天零分歧（分歧即回退开关 CCR_STANDBY_SHIP=off）；③装机回归新增「PM 常值守席显示待命、工具活动 5min 内翻在跑」双采样截图。

### M3｜计数下发（G2，M，元能力 P0 专批，依赖批 A boardrecon 通电后的对账断言）

- 内容：BOARD_UPDATED/SNAPSHOT.boards 每板捎带 `counts`（六泳道计数）；SNAPSHOT 捎带会话域汇总计数（在跑/待命/等你——判据用 M2 下发值）。端上 boardCounts/在办 N/团队 chip/统计行全部改读下发值。
- **验收**：①端上计数代码退役（源码锚：entries.filter 计数模式 grep=0）；②boardrecon active 档断言「板面 counts=dispatch-log 对账 100%」（P0-2 验收原话机器化）；③装机回归抽查三屏（web 看板/expo TeamPane/手机）计数一致截图。

### M4｜词面与字典收口（G3+G7+G10，M，随 Stage 2 前端批）

- 内容：每端建单一渲染字典模块（web `js/status-dict.js`、expo `src/statusDict.ts`），键=六态+liveness 三值+连接态枚举；30+ 处字面量表迁移收口；状态坞层与 dockColor 走词表变更单登记（豁免或归位，二选一呈定版）；桥副本死表删除。
- **验收**：①源码锚——字典模块外 grep 状态词字面量（运行中/待处理/等待确认…）=0（白名单豁免行除外）；②跨端键集锚升级为「键+色相」双断言（色相查词表 §三 token 名）；③词表 §三矩阵增 dock 层行或 §四豁免登记，本文档与词表互链。

### M5｜域规则包（G8+G6，M~L，**承接 arch-review R4 根治件原方案**，排 session-manager 拆分 R1③ 之后）

- 内容：@ccdeck/domain 装 updated_at 三律/帧时序/状态翻转纯函数+idle 阈值口径；expo 直接消费，web 以构建产物注入（不改 IIFE 形态）。**本步不在本文重复设计，见 arch-review §五 R4。**
- **验收**：test-updated-at-guard 改跑包内函数（三端守卫体=同一构建产物，sha 锚）；R-5/R4 立即件的历史功绩保留（expo 守卫已合规，此步是消三份复制）。

### M6｜设备增量帧（G9+G11，M，随 P1 定位收敛批——多设备方向）

- 内容：设备上下线 DEVICE_UPDATED 增量帧（ws+云双出口）；桌面壳 relay_status 与 relay /health 的态词对齐轴 C 契约（连不上=红 #357 口径推广到服务态全档）。
- **验收**：装机回归新增「设备插拔 5s 内两端可见」（现靠快照收敛）；轴 C 词面入词表或本文附录。

### 依赖与分期总览

| 步 | 量 | 时机 | 支撑的产品方向（product-review §四） |
|---|---|---|---|
| M1 | S | 随 DEV-42 锚批 | P0 元能力「可信」的地基（锚先于拆） |
| M2 | M | 元能力 P0 专批 | P0-2 主件——121 次催办「怎么全都空闲了」根因收口 |
| M3 | M | 元能力 P0 专批（依赖批 A） | P0-2 验收原话「板面=dispatch-log 100%」 |
| M4 | M | Stage 2 前端批 | 词表作为「唯一词汇源」的实然化；开源最小就绪面 v2（第二开发者可循字典接端） |
| M5 | M~L | R1③ 后 | 三端同答案类缺陷消灭（arch R4）；治理包产品化 P1-5 的域规则地基 |
| M6 | M | P1 批 | P1 同账号自动互联/多设备矩阵的可信设备面 |

**明确不做**（防为收口而收口）：不把 web 改模块系统（M5 按构建产物注入）；不统一排序比较器入 relay（排序含 pinned/本地 UI 偏好，属 §2.3-3 端上正当自由）；不动 relay 三单点（已收口）；不在本单动生产代码（DEV-56 换装验证期基线冻结——本文纯纸面，M1-M6 全部另行拆单）。

## 五、与在途计划的关系（防撞车）

- **arch-review R4**（域包）：M5 即其根治件，本文不另立方案只引用；其「立即件」expo 守卫已由 DEV-40 落地（报告应销账 R-5）。
- **DL-P1-4 批 A**（板 journal+boardrecon 通电）：M3 的对账断言依赖其通电；本文不重复排期。
- **DEV-42 锚批**（CI 接线）：M1 搭车。
- **词表 DEV-40**：本文 §2 与其互为表里；M4 的登记动其 §三/§四须走其变更流程。
- **test.37 装机回归**：M2/M3 验收项并入下一轮回归清单（R6/R12 已过的采样面扩为断言面）。
