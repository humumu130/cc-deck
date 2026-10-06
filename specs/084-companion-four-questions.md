# 084 · 伴随面四问框架与 Fixture 清单

> 版本：P84-doc v1 · 2026-10-05
> 定位：组织模型 v2 的先行文档件。本文把「伴随面四问」从评审提醒变成可填、可验收、可回退的固定框架，供 P84-impl、设计提案和实施任务书复用。本文只定义框架与 fixture，不改 `083-org-model-final.md`、`019-pm-duty.md` 或代码。

## 1. 适用范围与四问总则

伴随面不是第五种角色，也不是第二事实源；它是每次涉及 PM 常驻化、A/B 模式、通知路由、派单编排、值守或三端投影的变更，都必须附带的一页影响与回退说明。

四问必须围绕同一个变更单元回答：

| 问号 | 固定问题 | 判定为“答完” | 必填输出物 |
|---|---|---|---|
| Q1 | **影响哪些现有功能？** | 列出受影响的角色、入口、状态、数据源、事件/通知、三端面；每项都能指向现有事实源或明确“无影响”理由 | 影响矩阵：`对象/现行为/变更后/影响等级/事实源/兼容要求/验收 fixture` |
| Q2 | **需要哪些配套？** | 每个受影响面都有对应的 schema、命令、投影、权限、迁移、UI 或测试配套；没有“后续补齐”这种无主项 | 配套清单：`配套项/所有者/靶子/前置依赖/完成证据/未完成时的降级` |
| Q3 | **什么情况下失效？** | 至少覆盖正常路径之外的边界与失败；写清触发条件、可观察信号、用户影响和不应发生的副作用 | 失效表：`失效条件/可观察事实/严重度/禁止副作用/通知语义/fixture` |
| Q4 | **如何回退？** | 回退目标、触发门槛、执行动作、验证信号和数据兼容均明确；回退不会制造第二事实源或丢失审计 | 回退卡：`旧路径/触发器/动作/验证断言/数据处理/责任人/恢复后再开条件` |

### 1.1 填写规则

1. **以事实源回答，不以角色记忆回答。** 可引用 `events.ndjson`、`dispatch-log.ndjson`、`projects.json`、`boards/<gid>.json`、`confirms.json`、`notifications.json`、`SNAPSHOT` 或 transcript；若事实源没有字段，必须写“不可判定”，不能用 UI 状态补猜。
2. **区分当前态与审计态。** 当前实体状态由事实源/未来 SQLite 回答；`events.ndjson` 只作广播/审计摘要；019 值守审计写 `duty-rounds.ndjson`，不进入 EventBus/EventType。
3. **回退优先回到已存在的旧路径。** 例如 B→A 回到用户直达 PM 工作台，通知回到既有 ledger/SNAPSHOT 投影，派单回到 `orgAction()` 单漏斗；不得以“暂时再写一个 JSON”作为回退。
4. **每个 Q2 配套必须落到一个任务单。** 设计提案可以暂缺实现单，但必须给 owner、靶子和后续单号；任务书不得接收无 owner 的“配套完善”。
5. **fixture 的判定只看可观察结果。** 允许断言事件、台账、板、确认单、快照、ACK、通知或回退状态；不把内部函数调用次数当唯一验收依据。

## 2. 四问填写模板

以下区块可直接复制到设计提案末尾：

```md
### 伴随面四问

#### Q1 影响哪些现有功能？
- 角色/入口：
- 状态/事实源：
- 命令/事件/通知：
- Web/Expo/Desktop：
- 兼容与影响等级：
- 对应 fixture：

#### Q2 需要哪些配套？
| 配套项 | owner | 靶子 | 依赖 | 完成证据 | 未完成降级 |
|---|---|---|---|---|---|
| | | | | | |

#### Q3 什么情况下失效？
| 失效条件 | 可观察事实 | 严重度 | 禁止副作用 | 通知/升级 | fixture |
|---|---|---|---|---|---|
| | | | | | |

#### Q4 如何回退？
| 回退目标 | 触发器 | 动作 | 验证断言 | 数据处理 | 责任人 |
|---|---|---|---|---|---|
| | | | | | |
```

## 3. 四域 Fixture 清单

### 3.1 统一 fixture 格式

每个 fixture 至少包含：`fixture_id`、前置事实源、触发动作、期望可观察结果、禁止结果、回退动作、回退成功断言。正常/边界/失败三类不可用同一个“全链路通过”断言替代。

事实源坐标约定：

- **事件/快照**：`relay/src/types.ts:451-520` 的 `EventType/EventPayloadMap`；在线看 `PROJECTS_UPDATED`、`BOARD_UPDATED`、`NOTIFICATIONS_UPDATED`，离线看 `SNAPSHOT`。
- **组织与派单台账**：`relay/src/org.ts:213-307` 的 `org.json`、`dispatch-log.ndjson`；组织动作统一经过 `relay/src/session-manager.ts:3949-4121` 的 `orgAction()`。
- **项目板与确认单**：`relay/src/projects.ts:66-130,393-425,580-670` 的 `boards/<gid>.json`、`confirms.json`。
- **值守判定**：`relay/src/leader-duty.ts` 的 `DutyQueueSnapshot/evaluateLeaderActionableWork/validateDutyReceipt`；审计目标是 019 约定的 `duty-rounds.ndjson`。

### 3.2 PM 域

| ID | 类型 | 场景与输入 | 事实源/可观察字段 | 期望结果 | 回退动作与成功断言 |
|---|---|---|---|---|---|
| PM-N | 正常 | A 模式；用户从团队目录选择 PM 发起一项需求 | `projects.json.groups[]` 的 `id/status/tier`；`dispatch-log.ndjson` 的新 `id/tier/target/actor`；`SNAPSHOT.projects` | 需求先形成 task/board 事实，再出现派单；PM 来源与 group id 可追溯，未绕过单漏斗 | 失败回 `orgAction()` 单漏斗；断言无第二写入口、台账最多一条同 id 链、组状态不被半写入改变 |
| PM-B | 边界 | PM 卡休眠、worker 健康 running，队列非空但无行动位 | board entry `status=doing`；dispatch `status=running`；`leader-duty` 判定 `reason=all_running`；`duty-rounds.ndjson` | PM 回合结束放行休眠，不重复喂活；worker 后续 `SESSION_DONE` 才产生一次新 feed | 回退到普通休眠/事件等待；断言 feed 数不增加、无新 PM 会话、原 running 与台账不变 |
| PM-F | 失败 | B 模式薄 Leader 失联或 mode 切换失败 | `org-config.json`/mode 投影；PM/Leader session 状态；通知的 `condition_key`/`return_path`；`SNAPSHOT` | 切换保持旧 mode 或回退 A 用户可见面；不把薄 Leader 授予验收/commit/rescue 权限 | 使用 B→A 交接快照；断言用户能在 PM 工作台看到队列，旧台账/确认单未丢，失败通知指向用户而非死 Leader |

### 3.3 通知域

| ID | 类型 | 场景与输入 | 事实源/可观察字段 | 期望结果 | 回退动作与成功断言 |
|---|---|---|---|---|---|
| NT-N | 正常 | 新确认单或 dispatch failed 产生结构化通知 | `confirms.json` pending 项；`dispatch-log.ndjson` terminal `status/receipt`；`notifications.json` 的 `key/actionable/resolved_at/handled_at`；`NOTIFICATIONS_UPDATED` | 通知实体一单一行，在线由 UPDATED，离线由 SNAPSHOT；点击不自动清除 resolved | 回退到 `notifications.json + SNAPSHOT`；断言重启后通知仍在、`resolved_at` 未因打开变化 |
| NT-B | 边界 | 两台设备同时读取/标记同一通知；打开 alert 但未完成事实动作 | `notification_client_state(notification_id,client_id,read_at)`；实体 `handled/resolved`；decision ledger 的 `revision` | 各设备 `read_at` 互不覆盖；read/dismiss 不等于 resolved；alert badge 仍按 actionable 未处置派生 | 回退到结构化实体只读投影，保留端侧状态；断言另一设备未被清零，来源 condition 仍可重现 |
| NT-F | 失败 | 通知目标 PM/Leader 已死亡，或 ledger JSON 损坏/投递失败 | `decision-notifications.json` 可解析性；`notifications.json`；`SNAPSHOT.notifications`；session 状态 | 不调用会退化到 `sessions[0]` 的目标选择；写入 ledger/结构化通知失败时不阻断主事实落账，并升级用户 | 回退到 `notifications.json + SNAPSHOT` 离线面；断言确认单/dispatch 仍落事实源，用户可见“需要处理”通知而非静默丢失 |

### 3.4 派单域

| ID | 类型 | 场景与输入 | 事实源/可观察字段 | 期望结果 | 回退动作与成功断言 |
|---|---|---|---|---|---|
| DS-N | 正常 | 依赖已满足的 board todo 进入派单 | `boards/<gid>.json.entries[]` 的 `depends_on/gate/status`；`dispatch-log.ndjson` 的 `dispatched→running→done`；`BOARD_UPDATED` | `computeReady` 判 ready 后才 spawn；派单、回执、板搬运和 lesson 来源可对账 | 回退到现有 `dispatchWorker()`/`orgAction()`；断言 task/dispatch/board/receipt 四者同一 id 链且无重复 spawn |
| DS-B | 边界 | `depends_on` 坏引用或 gate 在场；健康 running 仍存在 | board entry 的坏 `depends_on`、`gate.reason/opened_at`；无新增 dispatch 行 | 以未就绪/blocked 保守拒派；健康 running 只进上下文，不被误判成 PM 行动位 | 回退为保持原 board entry；断言无 worker session、无 `dispatch-log` 新 dispatched 行、gate 只能由明确人类动作清除 |
| DS-F | 失败 | worker 超时/死亡，或派单 ACK 未到；需要重投 | `dispatch-log.ndjson` 的 `status/attempt_no/parent_dispatch_id/receipt/command_id`；`SESSION_ERROR/SESSION_DONE` | 原终态行保留；重投为新行接 parent 链；ACK/receipt 对账出现 timeout/orphan 时不静默成功 | 回退到人工巡检/用户通知，不自动无审计重投；断言原 dispatch 不被覆盖、failed/timeout 通知可见、重投次数可数 |

### 3.5 模式切换域

| ID | 类型 | 场景与输入 | 事实源/可观察字段 | 期望结果 | 回退动作与成功断言 |
|---|---|---|---|---|---|
| MD-N | 正常 | A→B 切换，无未收口的危险操作 | `org-config.json` 的 `mode/switching`；PM/薄 Leader session；`SNAPSHOT` 的 mode/入口；未决 confirms/dispatch | 进入 `switching`，生成交接快照，安全收口后切到 B；通知目标走薄 Leader 聚合 | 回退执行旧 mode 路由；断言最终只有一个 effective mode，交接上下文可读，未收口单仍可追溯 |
| MD-B | 边界 | 切换期间存在 pending confirm、running dispatch、验收单未收口 | `confirms.json.status=pending`；dispatch 非终态；acceptance result/history；board status | 延迟生效而不是半切换；新旧入口不同时写同一事实源 | 回退保持旧 mode；断言 mode 仍为旧值或明确 switching，原确认/派单/验收均未被改写 |
| MD-F | 失败 | B 模式薄 Leader 卡死、切换超时或交接包不完整 | Leader session 状态/last heartbeat；`org-config.json.mode`；通知 `condition_key`；PM 工作台事实源 | 失败保持旧模式；若 B 已不可用则回退 A 用户可见面，不自动重建越权薄 Leader | 回退到 A 入口并显示交接摘要；断言用户可直接选 PM、派单/确认仍走旧路径，旧 actor 兼容读不报错 |

## 4. Fixture 执行矩阵

| 域 | 正常 | 边界 | 失败 | 最低覆盖 |
|---|---|---|---|---|
| PM | PM-N | PM-B | PM-F | mode、队列行动位、交接 |
| 通知 | NT-N | NT-B | NT-F | 在线/离线、read/resolved、目标死亡 |
| 派单 | DS-N | DS-B | DS-F | ready/gate、attempt、ACK/receipt |
| 模式切换 | MD-N | MD-B | MD-F | A/B、switching、回退 |

执行顺序：先用 fixture 写入事实源，再触发唯一入口，最后只从事件/台账/板/确认单/快照读取结果。每个 fixture 同时保存“期望副作用”和“禁止副作用”；禁止副作用命中即失败，即使主结果看似成功。

## 5. 嵌入后续模板的固定文案

### 5.1 设计提案模板栏目

可直接粘贴：

```md
## 伴随面四问（必填）

本提案不得只描述新增功能，必须回答同一变更单元的四个伴随面问题：
1. 影响哪些现有功能？列角色、入口、状态、事实源、命令/事件/三端面，并给出影响等级。
2. 需要哪些配套？逐项给 owner、靶子、依赖、完成证据和未完成降级；禁止无 owner 的“后续补齐”。
3. 什么情况下失效？至少给正常、边界、失败 fixture；写触发条件、可观察信号、禁止副作用和通知语义。
4. 如何回退？写旧路径、触发器、动作、验证断言、数据兼容和重新启用条件；不得新增第二事实源。

附件：影响矩阵、配套清单、失效表、回退卡、fixture 清单。
```

### 5.2 Worker 任务书模板栏目

可直接粘贴：

```md
## 伴随面四问验收附件（任务书必带）

- Q1 影响：本单触碰的角色/入口/状态/事实源/客户端面：
- Q2 配套：本单不负责但必须存在的 schema/权限/投影/迁移/测试；owner 与依赖：
- Q3 失效：正常/边界/失败各至少一个 fixture；每项事实源字段、禁止副作用、升级语义：
- Q4 回退：旧路径、触发门槛、回退动作、成功断言、数据兼容与责任人：
- 回单必须附：fixture 执行结果、事实源前后快照、失败项与回退验证；未覆盖项不得写“通过”。
```

### 5.3 审查/验收单最小字段

`change_id`、`owner`、`affected_surfaces[]`、`fact_sources[]`、`fixtures[{id,type,source,expected,forbidden,rollback,rollback_assertion}]`、`rollback_target`、`loss_or_null_policy`、`evidence_path`。这些字段只作为验收附件，不创建新的运行时事实源。

## 6. P84-impl 接续边界

P84-doc 交付框架、fixture 场景和固定模板；P84-impl 才负责把四问接入模式切换、值守、通知和派单的实际流程，并实现/补齐对应测试。P84-impl 不得重新定义四问词义、事实源优先级或回退原则；若实施发现事实源不足，必须回到 Q2 建立配套并在 Q3/Q4 写出降级，而不是用 UI 桩数据补齐。

本文件不把 `PM_DUTY_ROUND` 注册为 EventType，不把 `duty-rounds.ndjson` 并入 `events.ndjson`，也不改变 019 的值守主体迁移口径。

## 7. 文档验收

- [x] 框架四问每问含判定标准与输出物形态：见 §1、§2。
- [x] 四域 fixture 每项同时具备事实源坐标与回退动作：见 §3.2–§3.5；每域正常/边界/失败各 1 项。
- [x] 嵌入点文案可直接粘贴进后续任务书：见 §5.1–§5.2。

084 done: P84-doc 四问框架+四域 fixture+模板文案已交付
