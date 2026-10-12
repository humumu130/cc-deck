# 任务生命周期与唯一事实源（SSOT）定案

> W-TASKFLOW · 2026-10-12 · 用户拍板两条：①梳理任务完整生命周期，不完善的完善之
> ②**唯一事实源强制**——面板各处任务展示/汇报/追踪全部基于任务表（org 看板），
> 强制执行不许到处不同步。
>
> 实现落点：`relay/src/board-mirror.ts`（同步器/对账/升级纯函数）+
> `session-manager.ts`（setTodos 咽喉合并 + emitBoard 挂点 + 对账看门 v2）+
> `web-console/index.html`（任务 tab 镜像徽标）。测试：`relay/scripts/test-board-mirror.ts`（51 断言）。

## 1. 问题：双源并存必然漂移

| 源 | 形态 | 消费面 | 漂移面 |
|---|---|---|---|
| PM 会话任务清单 | CLI 任务存储 `~/.claude/tasks/<sid>/*.json`（会话私有） | 面板会话详情页「任务」tab、dock 摘要、手表 | PM 自建任务与团队实际任务两张皮；relay 重启/跨端各看各的 |
| org 看板 | `<orgDir>/boards/<gid>.json`（relay 持久化，天然跨端跨会话） | 团队域面板、org CLI、duty 值守 | 团队任务权威态，但面板任务 tab 不读它——用户在任务 tab 看到的不是团队真相 |

派单已锁死走 org dispatch（ccops 机制强制，自动入板 claimed、收口联动搬卡）——**写路径单一**已经成立；缺的是**读路径统一**：任务 tab 仍读会话清单。本定案补齐读路径。

## 2. SSOT 架构定案

1. **org 看板 = 团队任务唯一事实源**（relay 持久化文件，跨端跨会话天然一致）。
2. **PM 会话任务清单 = 镜像视图**：从看板单向同步渲染（`[组名·板态] 卡文本` 徽标条目），**禁止反向写**——会话清单侧的任何改动（CLI 任务操作、✕ 隐藏）不回写看板。
3. **面板任务 tab 数据源 = PM 会话清单（含镜像）**：双跑期本地自建任务与看板镜像同屏（镜像带「板」徽标可辨）；最终切换判据见 §7。
4. 单向性的机制保证（不是记忆约定）：同步器（`board-mirror.ts`）全部函数**只读**看板、只产内存镜像（`TodoItem.source="board"` 标记条目）；唯一合并点是 `setTodos` 咽喉（session-manager），无任何看板写路径。测试件 sha 比对锁死（纯函数层 + setTodos 路径 + pollTaskStore 磁盘链三路）。

### 同步器工作方式

- **合成点**：`setTodos(id, todos)` 咽喉——对 Leader（PM）会话自动 `mergeBoardMirror(磁盘自建集)`。所有上游（30s 权威轮询 pollTaskStore / CLI 流 onTodos / REFRESH 命令 / [待确认] 追加）天然过此点，无一漏挂；非 Leader 会话零变化。
- **触发节拍**：①板变更即推——`emitBoard` 末尾重合成（派单搬卡/板操作后同拍生效，不等轮询）；②30s 轮询兜底（磁盘重读时统一合成）；③Leader 就位（ensureLeader）即合成首帧（首个 SNAPSHOT 就带完整镜像）。
- **完结回收**：done 是终态（D14 卡态不回转），done 卡不进镜像——镜像视图里即刻回收。
- **旁路语义**：parked/archived 组板冻结 → 卡退出镜像（恢复在办自动回来）；gate/依赖阻塞卡照常投影（backlog 态，徽标「待认领」）。
- **不污染既有判定**：`lastStoreTodos` 缓存、diff、TASK_DONE 完成汇报全部基于磁盘可见集；镜像条目可 ✕ 隐藏且重合成不复活（用户侧噪音控制）。
- **三态渲染映射**（五态语义不动，仅投影）：backlog→pending（待认领）；claimed/submitted/ready_to_install→in_progress（进行中/待复核/待装机徽标词区分）；done 不投。

## 3. 生命周期状态机（五态 + 旁路）

```
                 ┌────────────────────────────────────────────┐
                 │            （组级旁路：parked ⇒ 板冻结只读）  │
                 ▼                                            │
  [派单/手动建卡]                                     [手动 upsert]
 backlog ──认领/派单──▶ claimed ──完成候选+复核资格──▶ submitted
    ▲                      │                            │复核通过
    │失败回收               │直接完成                      ▼
    └───────────────       ▼                        ready_to_install
         （closeOpenDispatches boardTo）                 │装机验证通过
                 done ◀─────────────────────────────────┘
                （终态：卡态不回转 D14）
```

## 4. 每态进入/退出条件与责任者

| 态 | 含义 | 进入条件（谁） | 退出条件（谁） |
|---|---|---|---|
| **backlog** | 待认领 | ①派单建卡失败回收——系统（`closeOpenDispatches` boardTo=backlog）；②手动建卡——Leader/用户（org board upsert / 面板）；③重启悬账补记回炉——系统 | 认领：派单承接（系统，建卡即 claimed）或手动搬 claimed（Leader/用户） |
| **claimed** | 进行中 | 派单承接建卡（系统，dispatch 联动 claimed 卡）；手动认领（Leader/用户） | ①完成候选→submitted（见 R1/R2 规则）；②直接完成→done（收口联动/手动）；③失败回收→backlog（系统） |
| **submitted** | 完成候选待复核 | **仅**完成候选且 review_required=1（R1 生成锁：upsert/move 双入口同规则）——Leader/用户标资格 | ①复核通过→ready_to_install（Leader/用户）；②复核确认→done（Leader/用户）；③打回→claimed（Leader/用户） |
| **ready_to_install** | 待装机 | 复核通过显式搬卡（Leader/用户）；无存量自动生成 | 装机验证通过→done（系统：验收单 all_pass 收口 `settleAcceptanceResult`；或手动） |
| **done** | 完成收口（终态） | 收口联动（系统）/复核确认/验收收口/手动 | 无出边——任何后续（重复结算/改判 fail）零动作（卡态不回转，D14） |

**旁路（非态，是维度）**：
- **gate（blocked）**：卡级等待闸（`gate:{reason}`）——在场即不可派（computeReady 恒不就绪）。进入：显式 upsert（人/CI/外部等待映射）；退出：**仅人显式 `gate:null`**——无自动放行（红线，确认卡是用户决策唯一写面）。
- **依赖（depends_on）**：卡级依赖引用——依赖全 done 才可派。坏引用按未就绪处理（保守向）。
- **组 parked**：整板冻结只读——卡全部退出镜像与可写面；恢复 active 自动解冻。

**规则内核（R1/R2/R3，既有冻结面，本批不动）**：submitted 生成锁（R1）、done 候选升级（R2）、复核闭环清位（R3）——`resolveStatusTransition` 单点共用。

## 5. 责任者总表

| 动作 | 责任者 | 机制 |
|---|---|---|
| 建卡（派单联动） | 系统 | ccops/org dispatch → `upsertBoardEntry` claimed 卡 |
| 建卡（手动） | Leader/用户 | org CLI / 面板团队域 / orgAction board |
| 搬卡（收口联动） | 系统 | dispatch 收口 `moveEntryByDispatch`（done/backlog） |
| 搬卡（复核/装机） | Leader/用户 | submitted→ready_to_install→done 人工链 |
| 搬卡（验收收口） | 系统 | 验收单 all_pass → `settleAcceptanceResult` → done |
| 镜像同步 | 系统 | setTodos 咽喉 + emitBoard 挂点（本文档 §2） |
| 对账纠偏 | 系统 | 对账看门 v2（§6） |
| gate 开/关 | 人（显式） | upsert gate / gate:null——无自动路径 |

## 5b. 回执匹配：task_ref 全链路匹配键（2026-10-12 用户拍板）

**粒度 = 会话级**：一任务 ↔ 一会话（dispatch 派单的 worker 会话承接整卡）；worker 会话内部的 todo（自建任务清单）**不逐个登记板**——板卡对应交付承诺，不对应执行细节。

**四处同键**（`t-<8hex>`，即板卡 id）：

| 环节 | 载体 | 生成点 |
|---|---|---|
| ① 派单 prompt 头 | `[task_ref:t-xxx] [gid:pg-xxx] 标题` 结构化头（relay org dispatch 组装） | `dispatchWorker`：新卡**预生成**卡 id 后注入 prompt 头（认领模式用既有卡 id）；建卡带同 id 落板 |
| ② 板卡 | `BoardEntry.id` = task_ref | 同上（预生成 id 与 prompt 头同键） |
| ③ worker 回执头 | 收口 receipt 前置 `[task_ref:t-xxx] ` | `closeOpenDispatches`：收口时按 dispatch_id 定位卡（relay 内部精确键），receipt/通知文本前置卡 id |
| ④ 派单台账 | 收口行 receipt 文本携带同头 | 同上 |

**匹配规则**：
- **relay 内部泳道流转**按精确键匹配——`moveEntryByDispatch` 按 `dispatch_id`（一卡一派单一一对应，等价于按 task_ref 精确匹配）；验收归因按 `entry_id`（`settleAcceptanceResult`）。**废除启发式**：任何按标题/首行文本模糊对账的路径（人读回执对卡、工具抓取归因）一律以 task_ref 头为准。
- worker 回执不需要「自觉」携带——relay 收口侧统一前置（回执文本头注入是机制不是约定）；prompt 头的 task_ref 同时供 worker 回执引用与 Leader 读单对卡。
- 随手办（无 gid 无板卡）不注入 task_ref（它是板卡匹配键，无卡即无键）。

**实现清单**（本批已落）：
1. `dispatchWorker` prompt 头注入 + 预生成卡 id（session-manager.ts）；
2. 新卡建卡带预生成 id（与头同键）；
3. `closeOpenDispatches` 收口 receipt/通知前置 `[task_ref:卡id]`；
4. 断言锁死（test-board-mirror.ts ⑫ 段：prompt 头/板卡同键/回执头/搬卡闭环四点）。

## 6. 超时升级规则与对账看门

### 分层超时（两级催办 + 一级升级）

| 层 | 窗口 | 动作 | 责任者 |
|---|---|---|---|
| 值守催办 | 90min（`dutyStaleMs`，env 可调） | claimed 卡挂的 dispatch 不在 open FIFO 且卡龄超窗 → dutySnapshot `stale_doing` 候选 → 喂 PM 处理 | PM（值守 feed） |
| **升级（本批新增）** | **48h**（`boardEscalateMs`，`CCR_BOARD_ESCALATE_MS` 可调） | claimed 卡龄（板 updated_at 距今）超窗 → **用户通知**（attention 档，一卡一账 stableKey 防重） | 用户 |
| 组闲置 | 14 天 | M3 挂起自动化：建议暂缓确认单 | 用户决议 |

**「无帧」口径**：卡 `updated_at`——任何泳道迁移/编辑/收口联动都刷新它；48h 无刷新=无进展证据。与 stale_doing 的 FIFO 口径互补（那个防重启丢 FIFO 误报，这个是生命周期硬窗）。

### 对账看门 v2（v1 只报告不搬 → v2 强制回写+报警）

- **节拍**：随 30s 轮询（与 pollCronTasks/pollTaskStore 同 interval）。
- **判定**：`mirrorDiff(实际镜像, 看板投影)`——missing（漏推）/stale（态过期）/extra（残留）任一非空即漂移。健康态零动作（emitBoard 挂点已推平，看门只兜竞态窗口/外部改 state/同步器故障）。
- **动作**：①强制以看板为准回写（`syncBoardMirror`，裁决方向恒定：看板赢）；②每差异卡一行通知（upsertNotification，stableKey 幂等防轰炸）；③派单台账一行审计（tier=看门狗，#25-P7 先例口径）。
- **升级扫描顺带**：reconcile 同拍扫 claimed>48h → 用户通知。

## 7. 渐进迁移路线（红线：双跑验证后再切）

| 阶段 | 状态 | 内容 |
|---|---|---|
| **P0 双跑（本批）** | ✅ 已落地 | 镜像进 PM 会话清单（source=board 标记）；任务 tab 双源同屏，镜像带「板」徽标；对账看门 v2 兜底；51 断言锁死单向性 |
| **P1 验证** | 待生产双跑一轮 | 判据：①对账看门台账行数趋零（同步器健康）；②镜像条目与看板逐卡一致（抽查）；③无「镜像闪烁/复活」类反馈 |
| **P2 切数据源** | 待用户拍板 | 面板任务 tab 默认只显示看板镜像（过滤 source!=="board" 的本地条目或降权折叠）；PM 自建任务仍可用但不再是「团队任务」展示面 |
| **P3 收尾** | 待拍板 | 手机端（expo-app）任务面板同样识别 source 徽标；镜像条目点按跳转团队域对应组板（board_ref 已带 gid/entry_id，端上零协议改动） |

**不切的保护**：若双跑期发现镜像与看板出现不可解释的持续漂移（看门修复后仍复发），暂停 P2 并回流排查——SSOT 的前提是镜像可信。

## 8. 兼容红线备案

- **五态语义零改动**：`BoardEntryStatus` 词表、R1/R2/R3 规则内核、收口联动、验收收口全部原样（test-projects 99 断言回归绿即证）。
- **看板 API 零改动**：upsert/move/del/lessons 接口与广播帧（BOARD_UPDATED delta）原样；镜像是纯读侧投影，旧端忽略 `source` 字段零影响。
- **CLI 任务存储零侵入**：镜像只存在于 relay 内存态（s.state.todos → SNAPSHOT/UPDATED 帧），不写 `~/.claude/tasks/`——CLI 自己的任务系统行为零变化。
- **非 PM 会话零波及**：合并只对 leaderId 会话生效（test 断言锁死）。

## 9. 遗留与边界

- **升级通知不重复触发**：一卡一账（stableKey 幂等）——卡有进展后再次超窗不重新报（v1 口径；若需「复发重报」走 revision 天粒度，后续批）。
- **镜像条目无 #NNN 任务号**：CLI 数字 id 域与看板卡 id 域不同源，镜像不设数字 id——转录 #NNN 跳转自然跳过镜像（预期行为非缺陷）。
- **TASK_DONE 完成汇报不含镜像**：汇报基于磁盘集——团队卡完成走看板/通知面（DISPATCH_DONE / 验收回流），不走任务完成悬浮框（语义分离，防双报）。
- **PM 自建任务的定位**：双跑期保留同屏；P2 后降级为「PM 个人草稿」，团队任务一律走看板。
