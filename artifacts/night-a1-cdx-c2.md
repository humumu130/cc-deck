# 夜审 A1-cdx｜正确性透镜

- 审查日期：2026-10-14
- 审查范围：`fbd39449032c8252176d24a18c29655739a889a9..423defc722a87db884b2873769c9b76018f1c888`
- 重点批次：test.23 liveness / agent activator / board journal / source delete / pairing UI / session-list slim / project IA / Codex auto-revive / bundle 收编
- 方法：逐笔 `git log`/`git diff` 静态阅读；对叠加区按“意图 vs 实现”核对；未修改业务代码，未运行任何 `test-*` 套件
- 结论：**无 P0；P1×8；P2×3**

> 交付登记说明：用户指定的 `/Users/xdd/.cc-deck/artifacts/night-a1-correctness.md` 已存在且当前沙箱不可写，本报告使用带 `-cdx` 后缀的工作区副本，未覆盖既有文件或他轨产出。

## P1

### P1-1 派单成功收口绕过 D18 看板状态机

- **位置**：`relay/src/projects.ts:610-624,741-751`；调用点 `relay/src/session-manager.ts:4577-4618`
- **前置条件**：板卡已有 `dispatch_id`，并被显式标记 `review_required=true`；worker 回合正常完成，进入 `closeOpenDispatches(..., status="done")`。
- **复现路径**：先建/认领一张 `claimed` 卡，再通过 `upsertBoardEntry(..., review_required=true)` 设置复核资格；令该卡对应派单成功收口。`closeOpenDispatches` 最终调用 `moveEntryByDispatch(gid, dispatchId, "done")`。
- **实际**：`moveEntryByDispatch` 直接给 `e.status` 赋值并落盘，不经过 `resolveStatusTransition`，不追加 `transitions`，也不清理/消费 `review_required`。带复核门的完成候选可直接变成 `done`。
- **预期**：与 `upsertBoardEntry`/`moveBoardEntry` 共用同一规则内核；`review_required=true` 的完成候选应落 `submitted` 等待人工复核，只有复核确认后才可 `done`。
- **根因/影响**：派单联动保留了旧的裸搬卡写口，成为状态机的第四写口；自动成功回执能够绕过用户知情/验收门，且历史迁移线不完整。应让该入口返回/传播状态迁移失败，并统一调用状态机内核。

### P1-2 激活器在真实死流错误竞态上先判定为 `agent-alive`

- **位置**：`relay/src/agent-activator.ts:36-54`；资格链 `relay/src/session-manager.ts:1367-1393`；错误时序 `relay/src/session-manager.ts:3644-3705`；流关闭 `relay/src/agent-adapter.ts:536-552`
- **前置条件**：托管会话已有 `s.agent`；该 Agent 在回合中因 stream/error 退出，且尚未执行 `pump()` 的 `finally`。
- **复现路径**：让 `AgentSession.pump()` 进入 `catch`，在 `ended=false` 时回调 `onTurnEnd(false, reason, ...)`。`onTurnEnd` 同步发出 `SESSION_ERROR`，EventBus 同步调用激活器；随后才执行 `finally { this.ended=true; onSessionEnd(...) }`。
- **实际**：激活器收到首个 `SESSION_ERROR` 时，`reviveEligible()` 只检查 `if (s.agent)`，返回 `agent-alive` 并跳过复活。之后 `onSessionEnd` 不清空 `s.agent`、也不再发第二个 `SESSION_ERROR`，会话可永久停在 `ERROR`。
- **预期**：对“流已结束但 `ended` 尚未翻转”的事件，应延迟到流终态可见后重判，或资格链明确要求 `s.agent && !s.agent.ended`。
- **根因/影响**：事件发出点早于 Agent 生命周期标志更新，且 `agent.ended` 不是激活器资格条件；这正是无人投递场景下激活器应兜住的停摆路径。现有 `test-agent-activator.ts` 只 seed 无 Agent 的死会话，未覆盖该竞态。

### P1-3 激活器的无效 skip 会烧掉全局复活配额

- **位置**：`relay/src/agent-activator.ts:25-55`
- **前置条件**：一小时内先后收到多个 `SESSION_ERROR`/派单失败事件，其中若干会话最终会被 `reviveManagedSession` 以 `no-open-todos`、`pinned-dormant`、`resume-in-flight` 等原因跳过；默认 `CCR_ACTIVATOR_MAX_PER_HOUR=6`。
- **复现路径**：连续触发 6 个不满足资格链的会话错误，再触发第 7 个确有未完成工作的死会话错误。
- **实际**：`lastAttempt.set`、`recent.push`、`st.triggers++` 都发生在调用 `mgr.reviveManagedSession()` 之前；前 6 次 skip 仍占满 `recent`，第 7 个真实可复活会话直接命中 `windowHits`，至少等待整小时。
- **预期**：全局窗口应限制真实的 resume/spawn 尝试或失败，不应把确定不会 spawn 的资格检查消耗算入配额；同会话冷却仍可保留以防事件风暴。
- **根因/影响**：频控记账位置在资格判定之前；少量无效错误事件即可饿死真正需要自动恢复的会话，造成“激活器在线但拒绝拉活”。

### P1-4 `Bridge.forget()` 删除挂起审批后留下未决 Promise 与旧定时器

- **位置**：`relay/src/bridge.ts:189-236,2840-2862`；删除挂点 `relay/src/session-manager.ts:2189-2207`；SessionEnd 路径 `relay/src/bridge.ts:3002-3021`
- **前置条件**：外部 CLI 进入 `PreToolUse` 审批等待，hook 请求正在等待 `pending` Promise；会话随后被删除或上报 `SessionEnd`。
- **复现路径**：触发审批卡 → 调 `deleteSession()`/让 `onSessionEnd()` 调到 `bridge.forget(id)` → 等待默认审批超时。
- **实际**：`forget()` 只 `this.pending.delete(id)`，未 `clearTimeout(p.timer)`，也未 resolve/reject 原 Promise。原 hook 请求最长可挂到默认 `590000ms`；旧 timer 到期后仍执行 `setExternalStatus` 并直接 `bus.emit("SESSION_WAITING_RESOLVED")`，即使该会话已经从 `SessionManager` 删除。
- **预期**：删除会话必须原子地清理 timer，并以明确的取消/拒绝结果结束等待中的 hook；删除后的迟到 timer 不得再发会话事件。
- **根因/影响**：本次 `forget()` 只处理了 Map/Set 回收，没有处理 `Pending` 对象自身的 Promise 生命周期。除请求长挂外，还会产生已删会话的幽灵 resolved 事件。
- **同项次生问题**：`forget()` 删除 `inputQueue` 后未调用 `saveQueueDisk()`，删除会话的持久化排队消息可能继续留在 `ext-input-queue.json`，直到后续清扫。

### P1-5 看板镜像隐藏与对账看门互相打架，形成 30 秒自激振荡

- **位置**：`relay/src/session-manager.ts:1682-1691,6358-6399,823-830`；`relay/src/board-mirror.ts:111-126`；隐藏源 `relay/src/todo-hidden.ts:31-55`
- **前置条件**：Leader 会话中存在一条看板镜像，用户通过 `COMMAND_TODO_HIDE` 隐藏它。
- **复现路径**：隐藏镜像后观察 `s.state.todos`；每个 30 秒等待 `reconcileBoardMirror()` 再观察 `board-mirror` 台账和 `SESSION_UPDATED`。
- **实际**：`setTodos()` 在 `mergeBoardMirror()` 之后按 `hiddenTodoKeys()` 过滤，镜像始终不进入会话清单；但 `mirrorDiff()` 不知道隐藏集，仍把该卡列入 `missing`。每个周期都会 `syncBoardMirror()`（再次过滤掉它）、更新 Leader 的 `updated_at`/发送状态帧，并追加一行 `target="board-mirror"` 审计。通知 stable key 只能阻止通知重复，不能阻止审计和状态帧重复。
- **预期**：隐藏是用户对读侧镜像的有效展示选择，对账应把隐藏镜像视为“已按策略隐藏”，不应判缺失；或者对账实际集应在同一隐藏语义下比较。
- **根因/影响**：投影器的“期望全集”和会话侧隐藏过滤分属两个真相口；看门只比较原始板投影与已过滤清单。一个隐藏卡即可造成永久写放大、事件流增长和错误“强制同步”记录。

### P1-6 配对表单使用全局选择器，移动端会读到隐藏的桌面输入框

- **位置**：`cc-plugins/plugins/cc-deck/web-console/index-005.html:10811-10815,11064-11090,11268-11314,11316-11340`
- **前置条件**：桌面设置、移动设置（以及可能存在的添加服务器弹窗）同时保留在 DOM；用户在移动端配对输入框输入验证码。
- **复现路径**：打开移动端“连接与设备”→在移动输入框填写 6–8 位码→点击“配对”或在该输入框按 Enter。
- **实际**：委托入口调用无参 `submitPairCode()`，其 `document.querySelector("[data-cloud-pair-input]")` 取 DOM 中第一个输入框，而不是事件目标/当前可见容器；可能读到隐藏桌面输入框的空值或旧值，并清空错误输入框。`openCloudPairUI()` 聚焦也使用同一全局选择器。
- **预期**：事件入口应把当前表单输入框传给已有的 `submitPairCodeWith(code, input)` 内核，聚焦应限定当前激活设置容器。
- **根因/影响**：拆出的带参内核没有贯穿到移动/桌面委托层；移动端核心配对路径会稳定复现“明明输入了却提示未输入/配对失败”。

### P1-7 会话列表搜索无法命中被瘦身收起的 worker

- **位置**：`cc-plugins/plugins/cc-deck/web-console/index-005.html:3169-3192,3328-3338,3413-3417`
- **前置条件**：某 worker 属于项目编制、未置顶、未被选中，且不是 PM/Leader；其标题或摘要包含搜索词。
- **复现路径**：在会话列表搜索框输入该 worker 的唯一标题关键词。
- **实际**：列表层要求 `filterDef && sessionSearchTest && slimVisible`，而 `slimIsHidden()` 完全不考虑搜索命中，因此 worker 被过滤。团队入口卡的 `hit` 只按状态 `filterDef` 计算，不按 `sessionSearchTest` 计算；卡可能显示与搜索词无关的成员，但不会给出命中 worker 的可达入口。
- **预期**：搜索命中应临时解除瘦身，或至少把搜索条件传入团队卡/第四列并高亮、可直接打开命中会话。
- **根因/影响**：第三层 `slim` 过滤没有把第二层搜索作为豁免/聚合维度；结果是一个真实存在的会话对用户搜索不可见、不可直接定位，且入口卡统计口径混入无关成员。

### P1-8 聚合视角团队域只处理当前源，远程项目命令又回落本机

- **位置**：`cc-plugins/plugins/cc-deck/web-console/index-005.html:10905-10914,11372-11380,11395-11424,11430-11469,11473-11478,6841-6849`
- **前置条件**：本机 LAN 与云桥均在线，云源含项目/团队；从本机视角直接切到“多源聚合”。
- **复现路径**：先保持本机视角让两源分别收到 SNAPSHOT，再选择“多源聚合”；查看团队域项目列表，或点击一个来自云源的项目加载详情。
- **实际**：`onEvent()` 在聚合态仍只把 `context === ctx` 的帧交给 `Team.onFrame()`；`Team._aggCloud` 只在 `Team.onFrame(cloudCtx, ...)` 内写入，因此云快照在本机视角期间不会进入聚合缓存，切换时重放也只补喂本机槽，团队域可能只显示本机项目。即便云项目已进入某次并集，`requestDetail()` 发送的 payload 只有 `{gid}`，`__ccDeck005RouteWs()` 无 `session_id/sid` 时回落 `ctx.ws`，云项目详情命令打到本机 relay。
- **预期**：aggregate 应同时缓存/合并两源的团队帧，并按项目/源身份路由详情、确认、写命令；远程项目不应依赖当前主 socket 猜源。
- **根因/影响**：会话列表的 aggregate merge 与团队域的 source gate 不一致；团队域没有源归属键，命令路由也没有 `gid→source` 映射。多源场景下项目/成员面会丢远程数据或报“项目不存在/详情加载失败”。

## P2

### P2-1 激活器 `lastAttempt` 随删除会话永久累积

- **位置**：`relay/src/agent-activator.ts:25-34,36-55,57-72`
- **前置条件**：外部系统或用户持续创建、报错、删除不同会话。
- **复现路径**：对大量唯一 `session_id` 依次发 `SESSION_ERROR`，随后发 `SESSION_DELETED`；检查激活器闭包内 Map 生命周期。
- **实际**：`lastAttempt` 只写不删；`SESSION_DELETED` 订阅分支不存在。`recent` 会滚动裁剪，但 `lastAttempt` 的 key 不会回收。
- **预期**：收到 `SESSION_DELETED` 时清理 session 级冷却记录，或对冷却 Map 做 TTL sweep。
- **影响**：高频 external session churn 造成小型常驻内存增长；长期运行会话量大时累积为可观的键集合。

### P2-2 `Bridge.forget()` 漏清后续新增的会话级缓存

- **位置**：`relay/src/bridge.ts:199-236,2045-2076`
- **前置条件**：外部会话产生转录扫描/流式折叠/任务追踪数据后被删除。
- **复现路径**：让会话触发 `pushAssistantTexts()`、`emitTranscriptEntry()`、任务追踪，再删除会话；重复创建新 ext id。
- **实际**：`forget()` 清理了前段列出的 Map/Set，但没有清除 `transcriptOffsets`、`xstreamSeq`、`xchainId`、`xchainBest`、`trackers` 等后续新增缓存。部分表有粗粒度容量清空，`transcriptOffsets`/`xstreamSeq` 没有对应的会话删除清理。
- **预期**：`forget()` 应成为所有 session-keyed bridge state 的唯一回收口；新增 Map 必须在同一清单注册，或统一按 session 前缀清扫。
- **影响**：外部会话高频 churn 时转录偏移/流式序号等状态长期留存；即使部分 Map 有上限，也会把旧会话状态带到全局容量/清空策略中。

### P2-3 派单标题只修新增会话，存量 `[tier]` 标题没有迁移/显示层剥离

- **位置**：`relay/src/session-manager.ts:394-398,6792`
- **前置条件**：升级前已生成过带 `[轻立项]`/`[正经立项]`/`[随手办]` 前缀的派单会话，并在本次升级后继续查看。
- **复现路径**：保留旧 `title-overrides.json` 或旧事件流，升级到当前版本重启 relay。
- **实际**：新路径只把 `setTitleOverride()` 的写入改为纯标题；启动仍原样读取既有 override，`adopt()` 继续把旧值灌回 `state.title`，显示层没有统一剥前缀。新旧派单会话混排。
- **预期**：一次性迁移存量 override，或在读取/显示层统一规范化标题，同时保留用户手动改名语义。
- **影响**：用户令“彻底去掉前缀”只对新卡生效，历史卡继续显示旧格式，造成跨重启/新旧会话不一致。

## 未列级项的正面核对

- `relay/src/history.ts` 的 `bootReplayFile()` 与原有重放/压缩契约一致；未发现 ENOENT、坏行、截尾、DELETE/复活边界回归。
- liveness 的 `resumePending`/`streamGen` 互斥、`agentStreamAlive` 主投递门、失败同步阻断与通知幂等主路径未发现新的跨文件断链。
- board journal 的前态快照、滚动上限、journal 失败不阻断主写等主路径成立；本报告未把低概率的“写前审计”策略差异另列为缺陷。
- `ws-server.ts` 命令白名单、relay 命令字段与前端一般会话调用契约未发现明确错配；aggregate 团队域属于上述 P1-8 的特殊源路由问题。
- Codex resume 的 thread-id 锚和 `newAgent(... engine:"codex")` 链路成立；未把“WAITING 重启后是否应自动恢复”列为确定缺陷，避免把安全性选择误报为错误。

结果：无 P0；P1×8（状态机收口、激活器竞态/配额、审批挂起、镜像对账、配对表单、瘦身搜索、聚合团队域）+P2×3｜改动文件：`artifacts/night-a1-cdx-c2.md`（纯审查报告）
