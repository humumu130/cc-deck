# 019 PM 值守机制设计规范

**版本链：v3（终检）+ v3.1（总开关增补）+ v3.2（组织模型 v2 口径迁移：值守主体统一为 PM）→ 归档版**  
**日期：2026-10-05**  
**定位：P0 产品化实施规范；不回改 `specs/018-backend-implementation.md`。**

> **口径迁移说明**：本文 2026-10-05 前版本以 Leader 指代值守主体，现统一为 PM（组织模型 v2：PM=每团队常驻重角色；A 模式直接值守，B 模式薄 Leader 只聚合提醒不接管，职责见 018 §9.3）。未实施标识符已随迁改名（`feedPM()`/`pm_actionable_work`/`PM_DUTY_ROUND`/`afterPMTurnSettled`/`pm_turn_epoch`/`CCR_PM_DUTY`）；既有代码标识符（`isLeaderSession()`、`CCR_NO_LEADER`、`leader-duty`）保留现名并标注，#83 实施批更名。

## 用户拍板记录

- **6.3 夜间自动派活：允许。** `duty_policy.auto_dispatch_enabled` 的产品默认值改为 `true`；`allowed_playbooks`、`unknown_risk=review_only`、单项 token/时间预算和夜间硬预算保留。
- **6.5 总开关位置：授权团队分析。** 采用全局插件配置键 `duty` 作为总闸，组级 `duty_policy.enabled` 作为细粒度开关；两级同时开启才生效。
- **六项收口：** 6.1 L2 条件守护按事件驱动默认生效；6.2 L1 使用 5 秒 debounce/10 秒强制关窗；6.3 夜间自动派活允许；6.4 归档为本文件；6.5 采用全局总闸+组级开关；6.6 按 1h/2h/4h 夜间通知策略默认生效。

## 1. 目标、边界与核心结论

### 1.1 目标

杜绝“有活全员闲”：用户不发消息、PM 终端暂停时，relay 仍能依据事实源判断是否存在 PM 可立即处理的活，并在正确的事件点唤醒 PM、验收回单、派出下一批或升级用户。值守不是无条件定时器，也不是第二任务状态机。

### 1.2 三层值守模型

1. **L1 事件驱动即时喂活（主路径）**：worker `SESSION_DONE`、terminal receipt、失败回执、板状态联动收口或新任务入队等事件触发一次 `feedPM()`；目标是立即验收并决定下一批。
2. **L2 条件守护**：只有存在观察对象时启用，接收 worker 心跳/生命周期、watchdog 超时、迟到回单和依赖解锁事件；不设独立值守 tick 或周期性 LLM 注入。它负责发现 L1 覆盖不到的异常。
3. **L3 完全休眠与空转兜底**：队列为空且无 worker 运行时零巡检、零唤醒；仅保留空转告警的低频探测。空转告警不直接制造值守回合。

### 1.3 不建第二事实源

真实状态继续来自任务板、dispatch 台账、回执、会话状态和确认单；客户端是投影。值守只保存跨事实源的派生观察、去重和审计。`PM_DUTY_ROUND` 是独立日志条目，写入 `CCR_DATA_DIR/duty-rounds.ndjson` append-only 文件，不进入 EventBus、`EventType` union 或 `events.ndjson`，不参加业务状态机。

### 1.4 与 018 的边界

- 018 负责 relay 单写者集成、协议字段、Snapshot parity、命令权限、会话/引擎/事件事实源。
- 019 负责值守判定、喂活编排、策略开关、回执协议、告警投影、值守审计与实施拆批。
- D1/D2 必须排在 018 R1 `session-manager.ts` 单写者集成批之后；D0/D3 纯模块工作可并行。
- 本规范不设计绕过用户的生产变更、不设计无审计自动重投、不替代 Claude 个人会话的 TaskList Stop hook。

## 2. 事实信号与 PM 行动位

### 2.1 队列信号源

| 信号 | 值守判定 | 口径 |
|---|---|---|
| board `todo` | 有活；只有已解锁项才是行动位 | active 组、未冻结、依赖可计算且已满足 |
| board `doing` | 分为健康进行中或悬挂 | 有近期真实进展不触发；无 open dispatch/无进展则确认 stale 后进入候选 |
| dispatch `dispatched` | 有活 | 投递窗口或待接管，不等同于 PM 可派发 |
| dispatch `running` | 有观察对象，不等于空转 | 健康进展只等待外部事件；超时/心跳停止才成为异常行动位 |
| terminal `done/failed` receipt | 未验收时是行动位 | `failed` 需决定接替/放弃/通知；`done` 需核对回执、板与产物 |
| 依赖已解锁 | 有行动位 | 仅结构化 `depends_on[]` 可计算；旧板缺字段时标记不可计算，不猜测 |
| pending confirm | 有阻塞，但不是自动行动位 | 必须由用户确认，值守只生成/维护通知 |

`depends_on` 是 `BoardEntry`/`upsertBoardEntry` 的显式可选字段，后续与 018 的 `member_archive` 共用 `projects.ts` schema owner 串行扩展。旧板缺字段时不得误判“已解锁”。

### 2.2 `pm_actionable_work` 门控

“队列非空”只决定 L2 是否有观察对象，**不决定回合结束是否拦截休眠**。回合结束和所有外部事件都调用同一判定器；只有 `pm_actionable_work=true` 才能喂活 PM。

行动位包括：

- terminal receipt 已产生但未验收/未收口；
- 失败或悬挂 dispatch 待处置；
- 已解锁且无现存 open dispatch 的 `todo`；
- 已确认 stale 的 `doing`；
- 用户确认刚完成并明确解锁的下一动作；
- worker 心跳停止、running 超时、会话死亡/不可恢复、`doing` 与 open dispatch 不一致等异常。

以下只进上下文，不成为续办事项：健康 `running`、pending confirm、冻结项、依赖不可计算项、仅在线/未读通知、无法证明来源的自由文本依赖。

**全 running 反例：** 如果所有 worker 都在 `running`、近期有真实进展，且无待验收回单、已解锁任务、待复核产物或异常，则 `pm_actionable_work=false`；PM 回合结束必须放行真休眠。禁止再次注入“检查一下有没有活”，否则形成结束→拦截→无事→结束的 token 忙等死循环。

### 2.3 优先事项候选序

`pm_actionable_work=true` 时只从下列候选集中选一个，顺序固定：

1. 待验收回单；
2. 失败/悬挂派单；
3. 已解锁 `todo`；
4. 已确认 stale 的 `doing`。

候选集为空时，即使队列仍非空也放行休眠。健康 running、pending confirm、冻结项不能因“最老”或 `top_items[0]` 被注入为优先事项。

## 3. 触发、回合结束与统一喂活

### 3.1 事件落点

| 触发 | 现有落点/条件 | 行动 |
|---|---|---|
| worker `SESSION_DONE` | `onTurnEnd` 汇聚回调、dispatch 收口 | 新 receipt 可验收或依赖变 ready 时喂活 |
| 回单落盘 | `dispatch-log.ndjson` 写入与读取 | 新增 `done/failed` receipt 或迟到证据时喂活 |
| 异常 | watchdog/stall、心跳停止、running 超时 | 形成异常行动位时喂活或升级 |
| 新任务入队 | board upsert、dispatch 入账 | 新 active todo、依赖解锁或可承接 dispatch 时喂活 |

具体源码落点：dispatch 写入/读取为 `relay/src/org.ts:224-245`，收口接线为 `relay/src/session-manager.ts:3260-3271`，board upsert 为 `relay/src/projects.ts:393-425`，watchdog/stall 为 `relay/src/session-manager.ts:4287-4300`。

### 3.2 PM 回合结束团队 Stop-hook

个人 Claude 会话已有 `~/.claude/hooks/task-stop.mjs`：会话收工时查 TaskList，有 `pending/in_progress` 就拦截继续。团队值守把同一语义上移到 relay，但只处理跨会话团队队列；PM 自己会话的 TaskList 仍归个人 hook。

回合结束落点：`onTurnEnd` 完成 `closeOpenDispatches`、更新终态并发出 `SESSION_DONE`/`SESSION_ERROR` 后，异步调用 `afterPMTurnSettled()`。范围为 `relay/src/session-manager.ts:2481-2538`，`2539` 起为 `onSessionEnd`。`onTurnEnd` 是 14 处 adapter 回调（`agent-adapter` 5、`agent-codex` 4、`agent-jsonl` 5）的唯一 SessionManager 汇聚点，值守只接在该统一回调，不修改三个 adapter。

以 `isLeaderSession()`（`relay/src/session-manager.ts:2919-2924`，现名，#83 实施批更名）硬区分 PM 与普通会话。fixture 必须覆盖 result、stream close、Codex error、JSONL error 四类收口。

回合结束流程：

1. 读取最新事实源并计算 `pm_actionable_work`；
2. 无行动位：写 `PM_DUTY_ROUND(result="sleep", reason="worker_running|blocked|empty")` 审计条目，放行休眠；
3. 有行动位：按 §2.3 选优先事项，注入一项自包含值守活；
4. 注入失败：保留原回合终态，记录 `pm_unwakeable` 并升级用户，不伪造继续成功；
5. 全 running 或全阻塞时不注入；等待 worker/用户/外部事件精准唤醒。

### 3.3 `feedPM()` 单一入口

L1、回合结束拦截、L2 异常守护、K=3 continuation 都进入同一个 `feedPM(reason, snapshot)`，不允许各自 `resumeAgent`。

同一 relay mutex 内完成线性化：

```text
read pm_turn_epoch
→ claim feed_generation
→ re-read team snapshot
→ decide sleep / continue
→ write duty-rounds.ndjson
→ unique resume
```

真正 resume 前再次校验 claim 仍有效；去重主键使用 `pm_turn_epoch + feed_generation`，不能只依赖 `feed_id`。PM `WORKING` 时合并 feed 上下文而不追加回合；睡眠/可恢复会话只复用已有 SDK/session id，不为每次喂活新建 PM 卡。

`WAITING` 必须记录：

- `waiting_reason=USER_CONFIRMATION|EXTERNAL|UNKNOWN`；
- `waiting_since`；
- 关联 `condition_key`。

只有 `USER_CONFIRMATION` 抑制重复注入；等待超时或关联确认失效转为 PM 异常；用户确认完成后原子清除 waiting 并重算 actionable。

### 3.4 防抖、合并与 continuation

- L1 使用单调时钟 `5 秒` debounce 窗口 `[first, first+5s)`，`10 秒`强制关窗；失败回执或不可恢复事件可绕过等待立即升级。
- 关窗后到达的事件进入下一 feed；多个 worker 完成合并为一个 `feed_generation`，携带全部 `dispatch_id/session_id`。
- 单飞 feed 未完成时只合并原因和快照，不并发补发。
- 单次喂活最多处理 `K=3` 个事项。K 是一条连续 duty chain 的计数器，turn-end/L1/L2 共用；真实自然休眠并完成冷却后重置。
- K=3 后若仍有 actionable，持久化 `deferred_duty_continuation`，`5–15 分钟`退避后只触发一次延迟喂活，受预算控制并计入同一 chain，不能无限循环。

## 4. 值守回执与审计协议

### 4.1 自包含值守 prompt

每次注入必须包含 `feed_id`、`feed_generation`、触发原因、队列摘要、最老事项、事项内容、来源、年龄、允许动作、验收目标和预算提示。模板与 `wrapDispatchPrompt` 同层，但不能伪装成 worker 派单，也不改变 worker 纪律。

PM 回合最后输出单独一行 JSON，不加 Markdown fence、不夹自然语言：

```text
DUTY_RECEIPT {"v":1,"feed_id":"...","actions":[{"kind":"accept|dispatch|board|notify|none","ids":[]}],"blocked":[{"id":"...","reason":"user_confirm|external|permission|unknown"}],"next_trigger":"event|turn_end|user"}
```

`actions[]` 支持一轮多个动作。`none` 必须能区分 `no_actionable_work`、`blocked_by_permission`、`blocked_by_user_confirmation`，不能用一句“无事”掩盖未处理事项。

### 4.2 回执有效性

有效回执必须同时满足：

1. PM 回合完成；
2. `feed_id` 回显匹配；
3. JSON 结构与枚举合法；
4. 动作在事实源产生可验证副作用。

副作用校验：`dispatch` 比对 dispatch-log 前后快照；`board` 比对 board snapshot；`accept/notify` 比对验收/通知事实源；`none` 必须由当前快照证明。只凭模型声称成功不算有效回执。

### 4.3 值守审计

每轮写入 `CCR_DATA_DIR/duty-rounds.ndjson`，建议字段：

```json
{
  "kind":"PM_DUTY_ROUND",
  "v":1,
  "feed_id":"...",
  "feed_generation":"...",
  "pm_turn_epoch":"...",
  "trigger":["worker_done","turn_end"],
  "observed":{"actionable_count":1,"top_items":[]},
  "acted":{"dispatch_ids":[],"board_ids":[],"receipt_ids":[]},
  "blocked":[],
  "result":"continue|sleep|disabled|pm_unwakeable|failed",
  "duration_ms":0,
  "policy":{"playbook":"...","token_used":0,"budget_remaining":0},
  "ts":0
}
```

这是 append-only 审计日志，不进入 EventBus、`EventType` 或 `events.ndjson`。关闭值守时也记录 `result="disabled"`，但不执行喂活副作用。

## 5. 告警、恢复与通知投影

### 5.1 空转判定

派生时间：

- `last_worker_progress_at`：真实 `SESSION_LOG`/工具结果/状态收口或 `dispatched→running`，不能只用心跳；
- `last_pm_round_at`：PM 最近完成自然回合或值守回合；`SESSION_UPDATED`/`SESSION_LOG` 的 `ts` 是 relay 记账时间，细粒度时间按 018 的 `occurred_at`；
- `last_queue_change_at`：板移动、派单状态变化、回执进入或确认状态变化。

worker `60 分钟`只标记疑似 stale；连续两次观察无进展，或达到 `90–120 分钟`才确认 stale，长任务按预计时长/任务类型豁免。`WAITING` 不视为推进，除非已经进入明确的用户确认链。

### 5.2 三种用户语义

1. **需要处理**：值守连续失败、仍有行动位、PM 无法继续，请用户确认接管。  
   `title=需要处理：团队值守无法继续`  
   `body=PM 无法继续值守，仍有 <N> 项可处理；请确认接管或恢复 PM。`
2. **团队可能停转**：至少 2 小时无有效推进，显示最老事项和 PM 状态。  
   `title=团队可能停转`  
   `body=已 <age> 无有效推进；最老事项 <item>（<item_age>），PM 当前为 <state>。`
3. **已自动恢复**：昨夜值守已续办，不要求立即处理。  
   `title=昨夜值守已自动恢复`  
   `body=值守已验收 <N> 项、派出 <M> 项、仍待确认 <K> 项；无需立即处理，详情见团队摘要。`

### 5.3 分级触达与 condition identity

- `1h`：内部提醒，仅工作台，不推手机；
- `2h`：高优先级或用户阻塞事项推送；
- `4h`：普通事项最终兜底推送；
- PM dead/unwakeable：立即推送，不等待 4h；
- 自动恢复不在凌晨打扰，进入“昨夜值守摘要”。

`condition_key = root_cause + oldest_actionable_key` 是稳定 identity；只有 severity 升级或根因改变时递增 `revision`。恢复仅接受三者之一：事实源发生可验证 `acted` 变化、明确建立用户阻塞条件、`actionable_work` 集合为空。仅 `reviewed/observed`、打开通知或 dismiss 不算恢复。恢复后再恶化经过短去抖冷却再 reopen。

首次告警后仍未恢复，每 2 小时重提醒一次，建议封顶 `N=3`；relay 重启按 condition key 重建；dismiss 只改变用户处理态，不压制来源条件。

### 5.4 通知目标

`leader-duty`（现名，#83 实施批更名）不走 `targetSession()`，因为 `relay/src/decision-notify.ts:262-266` 会按 preferred→leader→sessions[0]（现有代码退化链）退化，可能把通知投回失效的 PM 卡。值守告警直接写 notification ledger，经 018 已冻结的 `NOTIFICATIONS_UPDATED`/`SnapshotPayload.notifications` 投影到 Web、Expo、desktop。

在线横幅可复用 `USER_NOTE`，但它是 `seq:0` 瞬态帧；离线恢复必须依赖 ledger/SNAPSHOT。通知打开不清零，`dismissed` 与 `resolved` 永远分离。通知路由按 A/B 模式分支见 018 §9.6（A 落用户可见面；B 先投薄 Leader 聚合，决议回原 PM）。

## 6. 开关、策略与用户触达

### 6.1 四级有效式

```text
effective_duty_enabled =
  CCR_NO_LEADER !== "1"
  && CCR_PM_DUTY === "1"
  && plugin_config.duty === true
  && duty_policy.enabled === true
```

层级语义：

| 层 | 位置 | 关闭效果 |
|---|---|---|
| 环境门 | `CCR_NO_LEADER`（现名，#83 实施批更名）、`CCR_PM_DUTY` | 不建 coordinator、不 ensureLeader（现名，#83 实施批更名）、不注入、不发 PM 自身告警；只记 disabled |
| 全局总闸 | `~/.cc-deck/config.json` 的 `duty` | 全组停止值守 feed/自动派活，工作面隐藏；设置行保留 |
| 组级开关 | `duty_policy.enabled` | 当前组不进入值守 feed，但普通 worker/事实源继续运行 |
| 自动派活策略 | `duty_policy.auto_dispatch_enabled` | 只验收、修正事实源和告警，不自动派新单 |

全局关闭压倒组级开启。值守审计仍记录 disabled；关闭不杀正在执行的 worker，不删除队列、回单或 dispatch 台账。重新开启先重算 actionable，不重放旧 feed。

### 6.2 全局配置键位置

采用 `PLUGIN_CFG_KEYS` 第五键 `duty`，复用 `relay/src/ws-server.ts:43-61` 的配置读取与 `/api/plugin-config` 读写、SNAPSHOT 下发和设置拨杆同构链。桌面/web-console 在插件能力区显示全局拨杆；Expo 在 `SettingsDrawer` 的插件/源能力区显示当前 relay 的 global state；聚合模式按 source 分别显示，不合并不同源。

值守总闸与 `deliverables` 独立：`deliverables=false` 只关闭输出物 tab、投递约定和 deliver 能力，不关闭值守；`duty=false` 只关闭值守，不关闭会话输出物、`deliver` 登记或产物中心。值守可以观察 deliver 回单/产物验收，但不依赖 deliverables hook。

全局关闭时，工作面隐藏“正在值守”、自动派活和值守动作；设置页保留“已全局暂停”拨杆与说明。团队页/019 摘要显示当前组策略和 effective 状态，并链接回设置，不复制第二个全局事实源。

### 6.3 `duty_policy` 与夜间自动派活

建议组级策略：

```text
duty_policy {
  enabled,
  allowed_playbooks: [],
  per_action_token_budget,
  per_action_time_budget_ms,
  overnight_budget,
  unknown_risk: "review_only",
  auto_dispatch_enabled: true
}
```

`auto_dispatch_enabled=true` 是用户已拍板的产品默认值，但只有 effective duty 开启、playbook 在白名单、预算未耗尽且动作不属于 review-only 时才能派活。已有显式 `false` 的组不被迁移覆盖。

夜间硬预算是主要防线：单项 token/时间预算或夜间总预算任一达到上限，立即停止主动派活，只保留验收、事实源收口和用户告警。未知风险和下列类别一律 `review_only`：未知 playbook/工具、生产变更、破坏性文件或系统操作、凭证/预算变化、成员增删、项目立项/升降级/暂缓/结项、跨源动作、需要用户确认的动作。允许列表必须是可审计预授权 playbook，不接受模型临时解释。

所有自动派活动作写入 duty audit，包含 playbook、对象、策略命中、预算消耗和结果；不自动重投、不绕过用户确认。

### 6.4 六项默认生效表

| 项 | 默认 | 影响 |
|---|---|---|
| 6.1 L2 条件守护 | 生产开启事件守护、无独立巡检间隔；沙盒显式关闭 | 只在有观察对象期间接收心跳、watchdog、回单和依赖事件 |
| 6.2 L1 去重 | 5 秒 debounce、10 秒强制关窗、`feed_generation` 单飞 | 批量完成合并一次喂活；失败/不可恢复可立即升级 |
| 6.3 夜间自动派活 | `auto_dispatch_enabled=true`；预算/白名单/review-only 护栏保留 | 夜间可推进预授权低风险 playbook，预算耗尽即停派 |
| 6.4 归档 | 本文件 `specs/019-pm-duty.md` | 不回改 018；D1/D2 仍排 018 R1 后 |
| 6.5 总开关 | 全局 `duty` + 组级 `duty_policy.enabled` | 全局关闭压倒组级，保留审计和设置入口 |
| 6.6 夜间通知 | 1h 工作台；2h 高优先级/用户阻塞；4h 普通兜底；dead/unwakeable 立即推 | 低价值恢复不凌晨打扰，严重停转仍触达 |

## 7. 实施拆批与验收

### 7.1 拆批

1. **D0 判定器 fixture（在飞）**：纯函数读取 board/dispatch/session/receipt，覆盖正常推进、悬挂、回单未验收、依赖解锁、空队列、候选集为空、恢复与 1h/2h/4h 虚拟时钟；不碰 `session-manager.ts`。测试固定 `CCR_DATA_DIR` 与 `CCR_ORG_DIR`，启动前断言非生产路径，退出清理。
2. **D1 L1/回合结束入口**：接入 worker done/receipt、`afterPMTurnSettled()`、统一 `feedPM()`、epoch/generation 线性化；必须等 018 R1 单写者集成后，串行写 `session-manager.ts`。
3. **D2 prompt/审计**：接入 `DUTY_RECEIPT`、`duty-rounds.ndjson`、回合结束拦截、K=3 continuation、事实源副作用校验；与 D1 同一 relay 集成锁串行，排 018 R1 后。
4. **D3 L2/L3 与通知（预留位已落）**：条件异常事件、1h/2h/4h 告警、`leader-duty`（现名，#83 实施批更名）notification kind、severity/revision、恢复/去重；不新建 L2 定时器。预留位提交：`a1e7299`。
5. **D4 三端投影**：Web/Expo/desktop 读取 alert、在线横幅/离线 ledger、返回 team；团队摘要/昨夜值守投影由审计与事实源派生。
6. **D5 故障矩阵**：WORKING/WAITING/dead/unwakeable、L1 并发完成、turn-end 拦截、relay restart、旧客户端、云桥离线和 7h 虚拟时钟；生产目录 mtime 哨兵不变。

不同靶子可并行，同一靶子必须串行；D0/D3 可并行，D1/D2 等 018 R1。每批必须有独立回单、探针验收、rollback target、数据兼容说明和降级行为。

### 7.2 全局 DoD

- TypeScript 类型检查、既有测试套件、真链路和验收单全部通过；
- `dispatch↔ACK↔events↔receipt` 对账探针覆盖 orphan/duplicate/timeout/seq-gap；
- `feed_generation` 幂等、5 秒合并/10 秒关窗、WORKING 不追加回合、WAITING 不重复确认文案；
- 全 running 且无行动位放行休眠；候选集为空即使队列非空也不喂活；
- `DUTY_RECEIPT` 的 feed_id、JSON 和事实源副作用全部可验证；
- 1h/2h/4h 虚拟时钟、2h 重提醒封顶、condition 恢复/reopen、夜间硬预算和 `duty=false` kill-switch 可测试；
- `CCR_NO_LEADER=1` 时不建 PM/薄 Leader、不注入、不发 PM 自身告警；
- 7h 演练无“有活全员闲”静默窗口，另保留短真实 timer smoke。

### 7.3 关闭与回滚

- 配置写入失败不乐观更新 UI，保留旧 effective 值；
- 总闸关闭是软停：不启动新 feed/派活，不强杀 worker，回单继续落事实源和 disabled 审计；
- 重新开启不重放旧 feed，只按最新快照生成新 generation；
- 旧 relay 缺 `duty` 或策略字段时按关闭/不可用降级；
- 任何值守异常先将 `plugin_config.duty=false`，不删除日志、队列或 dispatch 台账。

## 8. 实施状态

- **D0：在飞。** 当前目标为值守判定器纯函数与 fixture，不接 `session-manager.ts`。
- **D3：预留位已落。** 提交通道/占位提交为 `a1e7299`，等待协议与通知实现批接入。
- **D1/D2：排队。** 必须等待 018 R1 `session-manager.ts` 单写者集成完成后实施；不提前改三个 adapter 或并行写同一靶子。
- **018 关系：** 本文件是值守实施依据；018 保持冻结，不回写值守设计（组织模型 v2 口径见 018 §9）。
