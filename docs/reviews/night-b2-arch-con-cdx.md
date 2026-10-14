# 夜审 B2-cdx｜架构反方报告

> 立场：反方。目标不是证明所有在线路径都坏，而是找出在 relay 重启、跨账写入失败、异步同步、异构引擎恢复和通知时序下，会把“事实已成功”与“用户/PM 已看到”静默分开的断裂面。
>
> 审查时间：2026-10-14（Asia/Shanghai）。审查方式：只读源码、只读运行态文件与 B1 正方报告；未修改业务代码或并行轨产出，未运行任何 `test-*`。

## 一、反方结论

现架构的在线 happy path 有清晰的分域、单写者和 append-only 设计；但这些优点不能推出故障时的原子性或可恢复性。反方的核心判断如下：

1. **P0：跨账写入失败可能仍返回成功。** 派单台账、成员表、看板文件、看板 journal 和广播不是一个提交单元；多个写入返回值被忽略，板写失败时仍可能返回 `{ok:true}`。这是用户收到成功 ACK、但板卡/状态未落地的静默错误路径。
2. **P1：事件补发和 SNAPSHOT 只覆盖部分域。** 瞬态事件不落盘、不进 buffer；SNAPSHOT 带 projects 但不带 boards。离线或重启后，客户端没有统一的“按水位补齐所有域”的机制。
3. **P1：显示层缺少全局 epoch/水位门控。** 旧 SNAPSHOT 可以在新增量之后无条件替换状态；Team 的板锚定丢失后又会直接丢弃未锚定的 `BOARD_UPDATED`。
4. **P1：PM 看板镜像的历史会话恢复存在 no-op 窗口。** 回放会话标为 `historical`，部分 Leader 恢复路径不清除该标志，而镜像同步/对账对 historical Leader 直接跳过。
5. **P1：Claude/Codex 复活资格不是同一生命周期协议。** 老 `SESSION_CREATED` 缺引擎时没有迁移默认值；Codex 主要按会话状态恢复，Claude 主要按 task store 恢复，可能出现登记保住但工作态、进程或待办语义丢失。
6. **P1：人类通知与 PM 唤醒不对称。** `DISPATCH_DONE` 可以到达活动通知账，但 PM 可能因 duty、Leader 工作态、无 Leader 或 relay 重启补记而没有被唤醒。

因此，B1 所说的“在线 seq/replay 正确”“journal 已补强板风险”“写口收敛”只能证明正常路径的局部性质，不能覆盖上述故障窗口。建议优先把“写入结果可判定、恢复水位可证明、PM 通知可追踪”作为下一轮修复目标，而不是继续只增加显示层兜底。

## 二、故障模型与证据边界

### 2.1 关键写链不是一个事务

派单/认领路径实质上是多个独立副作用串联：

```text
HTTP command
  ├─ dispatch-log.ndjson（dispatched/running/done）
  ├─ session/member 内存与持久化
  ├─ org/projects.json 或 boards/<gid>.json
  │    └─ boards-journal.ndjson（先 journal，后覆盖板文件）
  ├─ EventBus 广播
  └─ 人类通知 / PM feed
```

其中任何一项失败，都不自动回滚其它项，也不必然改变 HTTP 命令的返回值。`task_ref/gid` 解决的是跨文本关联，不是跨账提交。

### 2.2 证据分级

- **源码可达路径**：下文对写入返回值、瞬态帧、快照消费、historical 判断和通知门控的判断，均来自当前源码。
- **运行态观察**：2026-10-14 00:15—00:16 只读盘点到 `events.ndjson` 约 12,017,808 bytes、`embedded-relay.log` 约 23,398 bytes、`hook-debug.log` 约 76,593 bytes、`title-overrides.json` 约 2,235 bytes、`boards-journal.ndjson` 约 27,100 bytes、`dispatch-log.ndjson` 约 157,762 bytes；日志可见 auto-revive 拉起记录，但没有足以证明 PM 唤醒成功的完整链路。
- **未过度声称**：标题事故的“今日覆盖”没有在本次只读窗口中完整复现；报告将其列为非原子写入风险，并以运行态事件中“先创建、后锁定标题”的多阶段事实作佐证，而不宣称已复现全部事故。

## 三、断裂面清单

### 3.1 P0：跨账写入失败后仍返回成功

| 项目 | 内容 |
|---|---|
| 触发条件 | `appendDispatch`、成员写入、`upsertBoardEntry` 或板文件覆盖写遇到权限、磁盘满、文件冻结、并发覆盖或部分写入；其中任一返回失败。 |
| 断裂路径 | `session-manager.ts` 派单路径先追加 dispatch 行，随后建会话/加成员/写板；`appendDispatch` 失败只返回 `false`，调用侧多处不检查。`projects.ts` 的 journal 与板文件是两个写点；收口又可能先记台账终态，再调用 `moveEntryByDispatch`。最终 HTTP 仍可能返回成功，广播也可能继续发送。 |
| 现有缓解 | dispatch-log append-only、板 journal、读侧按 id 取末行收敛、`task_ref/gid` 结构化关联、板写者集中在 `projects.ts`。这些提高了排障和事后对账能力，但不构成提交协议。 |
| 缺口 | 没有跨账 command id 的 prepare/commit 状态，没有失败传播/补偿队列，也没有“板事实未提交则 ACK 必须失败”的 fail-closed 规则。`moveEntryByDispatch` 还忽略 `saveBoardFile()` 返回值并绕过 `resolveStatusTransition()`。 |
| 建议 | 以 command id 建立 durable operation/outbox；所有副作用返回可判定结果，任一关键账失败则返回 `ok:false` 并记录待补偿状态；板搬移、台账收口、通知使用可重试的提交阶段；增加启动/定时 reconciliation，明确谁是每个字段的最终权威。 |
| 证据 | `relay/src/session-manager.ts:6705-6791`；`relay/src/org.ts:325-337`；`relay/src/projects.ts:546-578`；`relay/src/session-manager.ts:4599-4648`；`relay/src/projects.ts:742-751`。 |

这是本报告唯一列为 P0 的问题：即使故障被日志记录，调用方已经拿到成功 ACK 后，用户仍会把“未落板”理解为“已完成”，且后续恢复没有必然触发。

### 3.2 P1：relay 重启窗口丢瞬态事件，SNAPSHOT 不能覆盖所有域

| 项目 | 内容 |
|---|---|
| 触发条件 | 客户端离线、relay 重启、EventBus 落盘失败、事件超过 buffer 窗口，或事件本身被定义为 transient。 |
| 断裂路径 | `emit()` 的落盘异常被吞后仍在线广播；`emitTransient()` 使用 `seq:0`，不落盘、不进 buffer、不补发。`PROJECTS_UPDATED`、`BOARD_UPDATED`、`DISPATCH_DONE` 属于 transient。boot compaction 主要保留 SESSION state/log；WS 与云 SNAPSHOT 带 projects，但不带 boards。离线端重连后只能拿到部分全量，板还需另发 `COMMAND_PROJECT_DETAIL`。 |
| 现有缓解 | 连续 seq 可走 `replayAfter`；越过 buffer 时走 SNAPSHOT；板有按需 detail 拉取；通知账为部分终态提供旁路。 |
| 缺口 | 缓解是分域、分事件的，缺少统一恢复水位。丢掉的板/项目瞬态没有统一 outbox；`DISPATCH_DONE` 也没有可供所有客户端消费的持久事件历史。 |
| 建议 | 为项目/板变更建立持久 revision 或 outbox；SNAPSHOT 携带各域 revision/epoch，或在首帧后强制 hydrate boards；为 transient 定义明确的可丢弃等级和补偿来源；落盘失败不应静默降级为“仅在线广播”。 |
| 证据 | `relay/src/event-bus.ts:41-47,58-73`；`relay/src/types.ts:623-646`；`relay/src/history.ts:36-73,429-436`；`relay/src/ws-server.ts:988-991`；`relay/src/cloud-client.ts:480-492`；`relay/src/session-manager.ts:4785-4807`。 |

### 3.3 P1：SNAPSHOT 与增量的顺序竞态可回滚新状态

| 项目 | 内容 |
|---|---|
| 触发条件 | 同一客户端存在刷新连接、桥重连、LAN/云切换或临时 Team 刷新；旧 SNAPSHOT 在新 `BOARD_UPDATED`/`PROJECTS_UPDATED` 之后到达。 |
| 断裂路径 | LAN 与云侧只做 `lastSeq = Math.max(...)`，随后仍无条件消费事件，没有按 epoch 拒绝旧帧。`SNAPSHOT` 消费会无条件替换会话/时间线；Team 收到 SNAPSHOT 会清空 boards 和锚定集；未锚定的 board delta 直接丢弃。临时刷新连接复用同一总线，旧快照可能注入主页面。 |
| 现有缓解 | seq 单调推进、快照重建、board delta 的锚定判断。它们分别解决“编号前进”和“数据替换”，没有解决多源/多连接的先后关系。 |
| 缺口 | 没有 connection epoch、snapshot barrier、delta 暂存队列或 per-domain revision 比较；`lastSeq` 前进不等于当前画面已消费了该 seq 的新事实。 |
| 建议 | 每个连接分配 epoch；SNAPSHOT 必须带 stream/domain revision，旧 epoch/旧 revision 直接丢弃；在快照应用期间暂存 delta，快照完成后按 revision 合并；板详情请求需带锚定版本，避免空锚定时静默丢 delta。 |
| 证据 | `web-console/index-005.html:8977-8987,10836-10841`；`web-console/index-005.html:2851-2869`；`web-console/index-005.html:11558-11607`；`web-console/index-005.html:11634-11700`。 |

### 3.4 P1：PM 看板镜像在重启恢复路径出现 historical no-op

| 项目 | 内容 |
|---|---|
| 触发条件 | relay 重启后从事件回放或 org anchor 重建 Leader/PM；会话仍保留 `historical=true`，但需要把板事实同步回 PM todos。 |
| 断裂路径 | 回放 `adopt()` 将会话标为 historical；`adoptExistingLeader()` 调用 `syncBoardMirror()` 却未清除 historical；`syncBoardMirror()` 与 `reconcileBoardMirror()` 对 historical Leader 直接 no-op；从 org anchor 重建的 Leader 也明确为 historical。结果是磁盘板是事实源，但 PM 内部 todos 可能保持旧值或为空。 |
| 现有缓解 | adoption 时尝试 sync；运行时有约 30 秒对账；正常活跃 Leader 路径可同步。 |
| 缺口 | historical 同时承担“回放来源”和“禁止镜像写入”两个语义；没有恢复后的强制全量 compare，也没有客户端/PM 端的 revision 欠账标记。用户端若在客户端重启前保留旧渲染，不保证立即自愈。 |
| 建议 | 拆分 `historical` 与 `mirrorEligible`；Leader 恢复完成后先从 board revision 做一次强制全量 hydrate，再允许增量；对账失败进入可见 backlog/重试，而非 no-op；PM todos 记录 source revision。 |
| 证据 | `relay/src/session-manager.ts:1308-1310`；`relay/src/session-manager.ts:4366-4394`；`relay/src/session-manager.ts:6358-6380`；`relay/src/session-manager.ts:4417-4444`。 |

### 3.5 P1：Claude/Codex 复活语义不对称

| 项目 | 内容 |
|---|---|
| 触发条件 | 老事件缺少 `engine`，relay 重启自动 revive，Codex 会话处于 WORKING/ERROR/DONE 边界，或 Claude task store 与会话状态不一致。 |
| 断裂路径 | `SESSION_CREATED.engine` 可选；旧帧缺字段时回放不补默认。`newAgent()` 引擎缺失时默认 Claude。Codex 复活按会话状态判断，Codex `reviveSaved()` 可直接合成 DONE/等待输入而不启动进程；普通恢复又走一回合一进程 reinjection。Claude 则读取 task store todos。相同的“已登记”并不代表相同的“可继续工作”。 |
| 现有缓解 | 新派单会写入计划引擎/model/provider；auto-revive 延迟 5 秒；外部 hook 回归可重新声明引擎。 |
| 缺口 | 历史事件没有 schema migration；revive 的资格、终态、收口事件没有跨引擎统一契约；auto-revive 失败也没有持久化的 retry/failed reason。可能出现登记保住、WORKING 丢失、错误引擎启动或重复收口。 |
| 建议 | 将 engine/provider/model/version 作为必填持久字段并对旧事件显式迁移；定义统一 `revive_started/revive_succeeded/revive_failed/terminal_reconciled`；每个引擎实现同一状态机适配层；失败写 durable retry queue。 |
| 证据 | `relay/src/history.ts:132-163`；`relay/src/session-manager.ts:1367-1400,753-797,4011-4034,3773-3804`；`relay/src/index.ts:375-381`。 |

### 3.6 P1：标题 override 的非原子静默失败

| 项目 | 内容 |
|---|---|
| 触发条件 | `title-overrides.json` 写入失败、文件损坏/解析失败、重启回放与外部 transcript 推导交错，或旧帧迟到。 |
| 断裂路径 | override 是独立文件；解析失败回空对象。`COMMAND_RENAME` 与 `setTitleOverride()` 使用直接 `writeFileSync()`，异常被吞且仍可返回成功。外部会话回归时会按 override 覆盖标题，但 override 未落盘时重启后又回到 prompt 派生标题。运行态事件可见同一会话先有 `SESSION_CREATED`、后有锁定标题的多阶段写入窗口。 |
| 现有缓解 | 内存态立即更新；`title_locked` 防止正常路径再次自动改名；有独立 override 文件。 |
| 缺口 | 没有 atomic temp+rename/fsync、校验和、写失败反馈或版本号；不能证明改名与会话事实的持久化顺序。 |
| 建议 | 改名与会话 revision 绑定；采用临时文件+fsync+rename；解析失败显式告警并保留坏文件；写失败返回 `ok:false`，禁止继续广播“已锁定”事实。 |
| 证据 | `relay/src/session-manager.ts:393-407,2793-2812,4456-4474,1510-1523`；运行态 `events.ndjson` 中同会话存在创建帧与后续锁定标题帧。 |

### 3.7 P1：worker DONE 的人类通知与 PM 唤醒不对称

| 项目 | 内容 |
|---|---|
| 触发条件 | worker 正常 DONE、failed、PM 正在 WORKING、duty 关闭、无 Leader，或 relay 重启补记 hung dispatch。 |
| 断裂路径 | `notifyDispatchClosed()` 总发 `DISPATCH_DONE` 瞬态帧并写通知账，但只有特定 failed+leader 情形注入 Leader。正常 worker DONE 的 `feedPM("worker_done")` 受 `dutyEnabled()`、Leader 存在和 Leader 非 WORKING 等门控；PM WORKING 时直接合并/返回。relay 重启补记 `closeHungDispatchRows()` 会写 done/backlog 并发通知，却不调用 `feedPM()`。于是人类 activity 已知不等于 PM agent 已收到可执行上下文。 |
| 现有缓解 | 通知账保留部分终态；`turn_end`/`worker_done` 有统一 feedPM 入口；Leader 工作态避免打断在途回合。 |
| 缺口 | 没有“需要 PM 重新评估”的持久唤醒意图、ack 或重试；瞬态通知丢失时无统一补偿；“不打断 WORKING”与“不能遗漏待评估事实”没有分层。 |
| 建议 | 将 DONE 产生的 PM wake intent 写入 durable outbox；PM WORKING 时合并上下文而不是丢弃 intent，回合终态再消费；人类通知与 agent 唤醒分别 ack；重启补记必须进入同一唤醒队列。 |
| 证据 | `relay/src/session-manager.ts:4785-4807,3713-3724,4935-4965,4728-4755`。 |

### 3.8 P2：重启补记把“被中断”收敛成 done，语义容易误导

| 项目 | 内容 |
|---|---|
| 触发条件 | relay 重启时存在 `running`/`dispatched` 台账行。 |
| 断裂路径 | `closeHungDispatchRows()` 将行追加为 `done`，回执写“relay 重启，回合中断”，板条目尝试搬回 backlog，并发送终态通知。台账状态是 done，但业务成果并未完成；如果板写失败或 PM 未唤醒，三个读面给出的“完成/待办/无人处理”会不一致。 |
| 现有缓解 | receipt 明确写入中断；板尝试回 backlog；通知账补记。 |
| 缺口 | `done` 同时承载“正常交付”和“重启中断”；没有 interrupted/cancelled 独立状态，也没有强制验收或 PM 复核。 |
| 建议 | 将 interrupted 设为独立终态或可重试态；只有验收/依赖链确认后才转 done；补记流程必须生成 PM review intent。 |
| 证据 | `relay/src/session-manager.ts:4728-4755`。 |

## 四、与 B1 正方报告的对质

| B1 正方主张 | 反方回应 |
|---|---|
| “EventBus 的 seq/replay/SNAPSHOT 二分是正确的最小模型。” | **部分同意在线增量路径。** 但 `seq` 只约束有 seq 的帧；transient 使用 `seq:0`，落盘失败也不阻止广播，且 SNAPSHOT 不含 boards。在线补发正确，不等于所有域离线可恢复。 |
| “boards 有唯一写口和 journal，板风险已治。” | **journal 是审计/恢复材料，不是事务。** journal 成功、板文件失败时仍可出现“日志有、板无”；更关键的是调用侧忽略返回值，可能把失败包装成成功。 |
| “各表单写者单一，因此没有双写问题。” | **单写者不等于跨账原子。** `projects.json`、board、journal、dispatch-log、通知账各自只有一个主要写者，仍存在多个账本之间的提交窗口；反方关注的是一致性窗口，不是同一文件的竞争写者。 |
| “显示协议稳定，v8 只消费协议不碰 relay。” | **稳定协议仍可能有错误消费时序。** 客户端推进 `lastSeq` 后无条件消费旧 SNAPSHOT，板又不在 SNAPSHOT；这是显示层/协议组合的 epoch 缺口，不需要 relay 代码改动也能发生。 |
| “已知边界是设计余量，不是结构问题。” | **本报告区分了设计余量与静默失败。** claimed 语义偏差可以是设计余量；但 false-success ACK、historical no-op、重启补记不喂 PM 是可达的状态断裂，应该按故障级别处理。 |
| “可观测性一流，三账可 tail 排障。” | **可观测不等于可恢复。** 账本能在事后显示分叉，若调用已返回成功且没有补偿队列，排障材料仍不能自动修复用户态或 PM 态。 |

反方不否认 B1 识别出的优点：单写者降低并发复杂度，append-only 台账便于收敛，seq/buffer 能覆盖短暂在线抖动，能力位也有良好的前向兼容价值。争议点是：这些机制的保护边界必须写清楚，不能把“正常路径可观察”外推成“故障路径可收敛”。

## 五、修复优先级与验收建议

### P0（立即）

1. 所有关键写操作向上返回失败；任何 dispatch-log、board、member 的关键提交失败，HTTP 不得返回成功。
2. 引入 command id 的 durable operation 状态：`prepared → committed` 或 `failed → retryable`；禁止只靠多个 append 行推测是否提交完整。
3. 现有 `moveEntryByDispatch` 不能继续作为裸状态设置器；必须经过状态转换和可判定的板写结果。

### P1（紧接）

1. 为 board/projects 增加 domain revision，并在 SNAPSHOT、增量、detail 响应中携带；实现 epoch + revision 门控与快照期间 delta 暂存。
2. 将 PM mirror 从 `historical` 资格判断中解耦；恢复后强制全量 hydrate，并将失败留在可见重试队列。
3. 统一 Claude/Codex revive contract，补齐旧事件 engine migration，持久化 revive 失败。
4. 把 worker DONE 转成持久的 PM wake intent；通知人类和唤醒 PM 分别 ack，重启补记走同一 outbox。
5. 标题 override 使用原子写和失败反馈，并把 title revision 与会话 revision 绑定。

### 建议后续演练（本次未执行）

- 人为让 board 覆盖写失败：验证 HTTP 返回、dispatch-log、通知和 board 是否都明确为失败/待补偿。
- 丢弃 `BOARD_UPDATED` 后重连：验证 SNAPSHOT 是否能自动 hydrate board，而不是要求客户端另行猜测 detail 请求。
- 注入旧 SNAPSHOT 到新 delta 之后：验证旧 epoch/revision 被拒绝，画面不回滚。
- 回放 historical Leader：验证 PM todos 一定从板 revision 全量对齐。
- 回放无 engine 的旧 Codex 事件：验证不会静默按 Claude 处理，且 revive 终态可追踪。
- worker DONE 后分别覆盖 PM WORKING、duty=false、relay 重启补记：验证 wake intent 不丢。

## 六、P0 立即简报

收件标识：`ext-ab91190d-80bb-4b87-b6da-2f44ab77ff37`

> **P0：派单链存在 false-success 窗口。** 目前 `dispatch-log`、board 文件/journal、成员状态和通知不是原子提交；部分写入失败被吞，板搬移也可能忽略失败，但接口仍可返回成功。短期应把关键写失败改为 `ok:false` 并保留可重试 operation；在此之前，不应把成功 ACK 当作板卡已落地或 PM 已知晓。

本节是报告内的立即简报内容；本次审查遵守纯只读纪律，未向生产 `/api/notify` 注入消息。

## 七、审查回执

- 读取：当前仓库源码、运行态只读文件、`~/.cc-deck/artifacts/night-b1-arch-pro.md`。
- 未修改：并行轨产出、业务代码、store、protocol；未运行 `test-*`。
- 计划登记：将本报告登记为 `night-b2-arch-con.md`；登记脚本只登记路径，不负责复制文件。

结果：B2-cdx 反方报告完成，识别 1 项 P0 与 7 项 P1/P2 断裂面并完成 B1 对质；改动文件：`docs/reviews/night-b2-arch-con-cdx.md`
