# 任务流转全链路审计（pipeline-audit）· v4 五面扩展版

> v4 2026-10-21（W-AUDIT4 #196）：在 v3 逐跳明细基底上新增**五块**——§8 主链拓扑两态
> （可选 Leader 节点）/ §9 三可视面投影审计 / §10 验收单回流腿 / §11 旁路纠错通道
> （含 1021 上线的 NOTIFY2+CHAIN2 五层栈）/ §12 数据层盘点（七账本+chain-audit+turn-spool）。
> 1021 实战断点（死会话路由 6 次/交付零通知 2 波/对账 5 孤儿）写进对应损失点实证列。
> v3 2026-10-19 · W-PIPELINE2 初版 + Leader v2 扩写（逐跳触发三要素）· 零代码纯梳理
> 方法：代码走读 + 生产脚本/工具取证 + 前序审计吸收 + W-SCHEDFIX2 实施期机制证伪修正。
> 素材来源：段二三四吸收 `~/.cc-deck/artifacts/w-sched-b.md`（注入通道三层队列 + stop 丢队根因）与 `~/.cc-deck/artifacts/w-sched-c.md`（生产取证 12h 窗 21 单零丢失）；段一、段五为 W-PIPELINE2 补查；段二/段三机制修正吸收 `~/.cc-deck/artifacts/w-schedfix2.md`（拉活轮询不存在实锤 + DONE 熟手直注落地）。
> 每跳统一口径：**触发节点**（哪个进程/组件执行）·**触发时间**（何时发生）·**触发机制**（同步调用/事件推送/定时轮询/钩子/HTTP）·**数据落点**（中间存储）·**观测面**（在哪能查到）。
> 配套派单纪律文档：仓库 CLAUDE.md「开发 Leader 铁律」/「分支与提交纪律」/全局 CLAUDE.md「会话任务调度准则」——本文只记**机器面真实发生了什么**，行为纪律以引用方式出现。

---

## 0. 全链总图

```
┌─────────────────────── 段一 用户 → PM ───────────────────────┐
│ 本地 CLI 打字 ────────→ 转录 JSONL（~/.claude/projects/…）    │
│ 手机/网页对话 ──WS COMMAND_EXT_INPUT──→ pending_inputs 队列   │
│ （托管会话走 COMMAND_MESSAGE → SDK 流）                       │
│         ↓ PM（Claude CLI 会话，hook 桥接跟踪）                │
│ 分诊（行为准则）→ TaskCreate → ~/.claude/tasks/<sid>/<n>.json │
│ 辅助闸：UserPromptSubmit 注入待办摘要 / Stop 拦截带单收工      │
└──────────────────────────┬───────────────────────────────────┘
                           ↓（PM 认为该派）
┌─────────────────────── 段二 PM → 派单系统 ────────────────────┐
│ /api/org dispatch → dispatchWorker 认领                       │
│   ├─ 有空位 → wrapDispatchPrompt → 注入三分支（新建/直注/换流）│
│   └─ 全忙  → dispatch-queue.json FIFO（持久+boot 回灌）       │
│ 台账：dispatch-log.ndjson；回显：SESSION_LOG user_message     │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌─────────────────────── 段三 worker 执行 ──────────────────────┐
│ CLI spawn → worktree（磁盘隔离纪律）→ 写码/测试/等反馈         │
│ 状态：WORKING ⇄ 等反馈；收口 onTurnEnd → SESSION_DONE          │
│ 监控：events.ndjson + patrol（light 5min / full 30min）        │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌─────────────────────── 段四 worker → PM ──────────────────────┐
│ 回执文件（artifacts/、/tmp/…/receipts）+ git commit            │
│ deliver 登记（data/deliverables.json + artifacts-index.json）  │
│ PM 感知：DISPATCH_DONE 事件 / 值守喂活（worker_done 计数 feed）│
│         / verify-receipt-claims 机器核验 / patrol / 用户催     │
└──────────────────────────┬───────────────────────────────────┘
                           ↓（PM 收割 squash → 出包）
┌─────────────────────── 段五 PM → 用户 ────────────────────────┐
│ A 出包：VERSION → release-test.sh 七步 → tag → CI → Actions    │
│         → KV 三件（apk+exe+latest-test.json，md5 回读校验）    │
│ B 手机更新检查：双镜像清单 → isNewer → 下载断点续传 → 安装器    │
│ C 通知链：/api/notify → 绿框 TASK_DONE / 黄框 [待确认]          │
│         decision-notify ledger 五类（离线重载不丢）             │
│ D 验收单：bin/acceptance → LAN 链接 + KV 云链接（per-sheet key）│
│         → 用户填 → LAN 直提 / CF Worker → relay 60s 拉回        │
│         → cwd 归因回填通知 + 看板卡 done 联动                   │
└───────────────────────────────────────────────────────────────┘
```

**v4 新增五章导航**：§8 主链拓扑两态（协作模式开关）· §9 三可视面投影 · §10 验收回流腿 · §11 旁路纠错通道（NOTIFY2+CHAIN2 五层栈）· §12 数据层盘点。

### 每跳一览（存储 / 状态 / 监控）

| 跳 | 中间存储 | 状态迁移 | 监控覆盖 |
|---|---|---|---|
| 用户消息→PM 会话 | 转录 JSONL（落盘）+ pending_inputs（外部链内存数组） | 用户发出 → 已入队 → CLI 消费（ackId 对账） | unacked 重放账（用户消息）✅；events.ndjson user_message |
| 分诊→任务入单 | `~/.claude/tasks/<sid>/<n>.json`（权威磁盘店） | pending → in_progress → completed/deleted | hooks 双闸（注入+拦截）+ relay pollTaskStore + 看板镜像 |
| 派单注入 | dispatch-queue.json（org 层）+ SDK 内部队列（黑盒） | queued → dispatched → running → done | dispatch-log.ndjson 台账 ✅；SESSION_LOG 回显（乐观）⚠️ |
| worker 执行 | worktree 磁盘 + CLI 进程 + 转录 | WORKING ⇄ 等反馈；收口→DONE | events.ndjson + patrol 巡检 ✅ |
| 结果回传 | 回执文件 + deliverables.json + artifacts-index.json + git | 写回执 → PM 感知 → 收割 | verify-receipt-claims.mjs 机器核验 + 值守喂活 + 巡检 |
| 出包分发 | VERSION + git tag + Actions 产物 + KV/ECS 文件 | bump → tag → CI → 推清单 | check-bundle-sync 闸 + kv-put-verified 回读 ✅ |
| 手机更新 | latest[-test].json（KV+ECS 双镜像）+ 本地 .part | 检查 → 提示 → 下载 → 校验 → 安装 | 端上全静默容错 ⚠️（失败返回 null 不打扰） |
| 通知 | TASK_DONE 落盘事件 / USER_NOTE transient（不落盘） | 发出 → 端上展示 | decision-notify ledger（五类持久）✅ |
| 验收闭环 | data/acceptances/<id>.json + <id>.results.json | 待填 → 提交 → 回流 → 卡 done | 待填汇总随 SNAPSHOT 下发 + 回填通知 |

---

## 1. 段一：用户 → PM

### 1.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 1.1 | 本地打字 | 用户终端 → 本机 CLI 进程 | 用户敲回车瞬间 | CLI 进程内输入循环（同步） | 转录 JSONL 追加写 `~/.claude/projects/-Users-xdd-dev-cc-deck/<sid>.jsonl` | 转录文件 |
| 1.2 | 手机/网页→**外部**会话 | 手机 app → CF Worker/WAN → relay WS → bridge → CLI stdin | 用户点发送 | WS 帧 `COMMAND_EXT_INPUT`（**事件推送**，无轮询） | `state.pending_inputs` 内存数组 → CLI 空闲时合并投递（`"A\rB"` 合并语义，bridge:1289） | 端上 pending 气泡；SESSION_UPDATED.pending_inputs |
| 1.3 | 手机/网页→**托管**会话 | 同上入口 → relay → `s.agent.sendMessage` | 用户点发送 | WS 帧 `COMMAND_MESSAGE`（**事件推送**；与 1.2 双向互斥路由，session-manager:2631/2893，错道直接报错） | SDK 内部队列（黑盒）；账面=`s.unacked.push`（:2706/2757） | SESSION_LOG user_message（乐观）；ackId 出队=消费证据 |
| 1.4 | 分诊 | PM（Claude CLI 会话） | PM 读到用户消息的当个回合内 | **行为准则**（提示词层，无机器闸）+ UserPromptSubmit hook 注入待办摘要（**钩子**，每条用户消息触发一次） | 决策不落盘（在回合内完成） | 无直接观测（A1 结构性盲区） |
| 1.5 | 任务入单 | PM 调 task 工具 | PM 决定入单的回合内 | **工具调用**（同步写盘） | `~/.claude/tasks/<cli_sid>/<n>.json`（单文件单任务：id/subject/description/activeForm/status/blocks/blockedBy） | 手机「任务」tab；看板镜像卡 |
| 1.6 | 任务下游同步 | relay（session-manager） | ①**30s 定时节拍**（setInterval 块 :863-867，常量 CRON_POLL_INTERVAL_MS=30_000 :523，与 pollCronTasks 同 interval）②会话事件边（:2931） | **轮询+事件边**混合；readTaskStore（task-store.ts 权威）→ setTodos 咽喉（:1794） | relay 内存 todos → SNAPSHOT 下发 → 手机 tab + Leader 会话 mergeBoardMirror 单向镜像（只读不回写，W-TASKFLOW 锁死） | 端上任务卡状态 |
| 1.7 | Stop 收工闸 | task-stop.mjs（Stop hook） | PM 会话尝试收工时刻 | **钩子**：存在可执行待办（pending/in_progress）→ `decision:block` 拦截；60 秒内第二次停止放行；**远程活跃豁免**=events.ndjson mtime<3min 不拦（A5 误判面）；CLI 连续 8 次 block 强制结束 | 拦截行为不落盘 | 面板可见被拦的停止尝试 |

### 1.2 分诊：行为层 + 机器层

**行为层（无机器闸）**：CLAUDE.md「会话任务调度准则」的消息分诊四分类（新任务入单/补充更新/纯问答不入单/30 秒顺手做掉）是纯提示词约束——没有任何机器面校验「用户消息 → 任务条目」的转化率。口头说了没入单在这一层发生。

**机器层（任务存在之后生效，hooks）**：
- **UserPromptSubmit hook**（`~/.claude/hooks/task-context.mjs`）：每条用户消息注入当前可执行待办摘要（≤8 条，豁免 `[搁置]`/`[常驻]`/parked），辅助 PM 分诊不漏已有单。
- **Stop hook**（`task-stop.mjs`）：见跳 1.7。
- 任务清单读取：`task-lib.mjs` **权威存储优先**（`~/.claude/tasks/<sid>/<n>.json`，与 relay task-store.ts 同源 #206），无目录回退转录重放（TodoWrite 全量快照 + TaskCreate/TaskUpdate 增量 + tool_result 回填真实 taskId）。

### 1.4 丢失面（段一）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| A1 | **口头需求未入单**——分诊纯行为约束，无「消息必须落任务」的机器闸，PM 漏判无告警 | CLAUDE.md 准则（提示词层） | 未修（结构性，只能靠 hook 注入提醒降低概率） |
| A2 | **CLI 工具集缺 todo 工具**→转录无任务调用，两 hook 静默放行 | task-lib.mjs:9 注释自认；GLM-* 直传会裁 todo 工具（memory claude-glm-model-alias） | 已绕（GLM 走 claude-* 别名解锁全量工具），机制面无闸 |
| A3 | **转录落盘滞后**——Stop 时刻末次任务更新偶未落盘，hook 容忍轻微滞后 | task-lib.mjs:7 | 已缓解（权威存储 readTaskStore 优先后影响收窄到无目录会话） |
| A4 | **会话死亡任务滞留**——任务店 per-session（`~/.claude/tasks/` 已积 180 个会话目录），跨会话不自动携带；Stop 60 秒二次放行=允许带任务收工；跨会话唯一通道是 memory 固化（行为纪律，忘固=丢） | task-stop.mjs:46 + 目录实查 | 部分（`[搁置]`/`[常驻]` 豁免+固化纪律是软兜底；无机器兜底） |
| A5 | **远程活跃误判放行**——events.ndjson 3 分钟内被**任何**会话触碰（哪怕与收工无关的活动）→ Stop hook 跳过拦截，带单静默收工 | task-stop.mjs:38（mtime 判据粗糙） | 未修 |
| A6 | **手机消息入队后 CLI 死亡**——外部链 pending_inputs 数组在 relay 侧保留但 CLI 进程死=同灭，靠看门狗滞留跳过/超时清扫（托管链流死后 sendMessage=注入黑洞，adapter:382 自认） | w-sched-b Q2/P5 | 未修（P5 建议 stop/进程死亡钩子清 pending+通知） |

---

## 2. 段二：PM → 派单系统（吸收 w-sched-b/c + W-SCHEDFIX2 修正）

### 2.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 2.1 | 派单发起 | PM 会话 | PM 决定派单的回合内 | (a) **HTTP**：`POST /api/org?token=…` body={action:"dispatch",…}（ws-server:715——动作白名单 ws-server:736-760→orgAction :762；**P81 求值闸在 dispatchWorker 内** permission-policy.ts:293）(b) **WS**：`COMMAND_ORG_ACTION` 帧→orgCommand dispatch 分支（session-manager:5630，转调 orgAction :6079→dispatchWorker :6963）。两路咽喉同一 dispatchWorker | 审计行 auditOrgCommand | dispatch-log.ndjson 台账（dispatch_id↔session_id） |
| 2.2 | 同步 ACK | relay → 派单发起方 | 校验→认领→**注入已发出后**同步返回（实测 0.98s 含权限链；ACK 前直注 sendMessage 已推 SDK :7227/换流 spawn 已启动） | **同步返回** `{ok, dispatch_id, session_id, queued?}`——`queued:true`=编制触顶进队（端上据此显示排队态，零猜测） | ACK 即台账写 | 派单回执 |
| 2.3 | 调度决策 | relay（dispatchWorker :6963，同步函数） | ACK 前同步完成 | **同步调用**：形状校验（anchor 绝对路径 :6965/prompt 必填 :6968/tier 三档 :5632）→ 可选编排链（**仅 WS 面带 task 载荷时**：orgCommand :5638-5712 先写卡 board upsert→computeReady 依赖/gate 检查→blocked 零 spawn；HTTP 面无 task 载荷无编排）→ 认领：有空位按技能/角色匹配空闲（:7048-7057 最久 idle）或 DONE 熟手（pickVeteran :7060）；全忙→dispatch-queue.json FIFO | 卡：org board entries；队：dispatch-queue.json（内存权威+写穿持久+boot 回灌+drainReentrant 防重入 :749；**cap=200** dispatch-queue.ts:70，满队=台账 failed+转通知 :7466-7475，#125 d8681c1 落） | 看板卡状态（backlog/claimed/doing） |
| 2.4 | prompt 拼装 | relay（wrapDispatchPrompt，调用点 :7201/定义 :8491） | 认领成功边同步 | **同步调用**：任务正文外包四层——tier 纪律块+该角色经验块（经验库 top）+岗位模板块+规则块（预算 600 team-rules.ts:92-93、created_at 序 :24）；头部打 `[task_ref:…]` 对账锚（:7196-7200） | 内存字符串（随注入传递） | 注入的 user_message 可见 |
| 2.5a | 注入·新建 | relay agent-adapter → SDK spawn | 认领即触发（无既有 worker 可复用时） | **同步**：create → SDK spawn 新 CLI 进程 → 首回合即任务（create 即回合，不经队列） | CLI 进程+转录 | SESSION_CREATED → WORKING 帧 |
| 2.5b | 注入·直注（W-SCHEDFIX2 新落） | relay → 既有 CLI 的活流 | 认领 DONE 熟手且**前置闸全过**（①**熔断冷却检查最前**：resumeCooldownUntil 未到期→throw→降级新会话承接/failed 收口，:7210 ②流健康 agentStreamAlive :4005：流在+未 ended+未弃管+宿主 pid 活；veteranAlive :7222） | **同步** `sendMessage` 直注入账（hold:"turn"，:7211-7243）——**不杀 CLI 不重载 transcript**；状态推 WORKING/清 done_reason；时间线落「派单直注」系统行（:7243） | unacked 账+CLI 回合队列 | 时间线「派单直注」行+user_message；窗长=模型首 token |
| 2.5c | 注入·换流 | relay（resumeAgent） | 熔断闸过后，熟手非活流（流死/ended/gaveUp/ERROR——ERROR 态可被选为熟手 :7400，经 veteranAlive 的 DONE 检查落此分支；**R3 不变式：僵尸熟手必换流承接原班** :7062） | **同步**：杀旧流 → SDK spawn resume → transcript 重载 → 首条 prompt 带账注入（hold:"turn"，流死可重放） | 新 CLI 进程+原转录 | WORKING 帧；窗长=CLI 重启+重载+首 token（实测中位 65s、长尾 323s） |
| 2.5d | 注入·失败出口（W-AUDIT-B 补） | relay | 认领后各失败点 | **五个出口**：①熟手复活失败→降级新会话（:7270-7274，R3 降级例外）②复活后再失败/首拉失败→台账 failed+notifyDispatchClosed（:7276-7305）③入编兜底闸：spawn 成功但 addMember 拒→停流+failed（:7330）④引擎 preflight 失败→P81 审计 reason=preflight_failed（:7116）⑤排队重放真抛→failed 防悬账（:7535-7540） | 台账 failed 行 | notifyDispatchClosed 通知 |
| 2.6 | 账面对账 | relay+CLI | 注入即 push → CLI 消费回显即出队 | **事件对账**：注入即 `unacked.push({id,text,ts,hold})` → CLI 回显 user_message 带 ackId → 对账出队（=消费证据）→ 回合中断 flushResumeBacklog 带账补投 → 补投文再入账（W-SCHEDFIX2 补全）→ 回合收口出清 | s.unacked 内存账（resume 链可重放） | ackId 出队日志 |
| 2.7 | 外部 CLI 链 | relay bridge | PM 派给**外部** CLI worker 时 | **enqueue**：挂 pending_inputs → CLI 空闲合并投递（covered 去重+CLI enqueue 回执晋升出队 #43+看门狗滞留跳过已进队） | state.pending_inputs（无上限） | pending 气泡；enqueue 回执 |

### 2.2 丢失面（w-sched-b 问题清单，状态更新至 2026-10-19 晚）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| B1 (P1) | **系统注入不走 unacked 重放账**——流死静默丢 | 原 :4996/:7921 锚（实施期发现一处已被此前批次吸收、一处描述不准，真缺口=水位告警 ackId 不透传+补投文不再入账） | **已修 2026-10-19（W-SCHEDFIX2）**：水位告警 msgId 透传 ackId+push 先于 send（:7960-7970）；flushResumeBacklog 补投文再入账 hold:"turn"（:5002-5008） |
| B2 (P2) | **stop 后 SDK 队列内容命运黑盒**——COMMAND_STOP → denyAllPending（:1103）+**250ms 等待**+q.interrupt()（:1110，**时序约束：不等 250ms deny 响应未落地被打断=权限通道打坏** adapter:1101-1109），SDK 内部排队消息随流丢弃（用户实锤「stop 后排队消息全部丢失」托管侧根因） | adapter:1101-1110 | 部分缓解（系统注入有账可经 resume 补投；SDK 队列本体仍黑盒） |
| B3 (P3) | ~~org FIFO 无容量上限~~ **已修**：cap=200+溢出策略（满队=台账 failed+转通知，#125 d8681c1 落，dispatch-queue.ts:70/session-manager:7466-7475）；**仍在**：pending_inputs 无 cap（:1592/:1617 直 append）、SDK 黑盒不可见 | W-AUDIT-A 实锚 | 部分已修 |
| B4 (P4) | **注入回显是乐观推 SDK 非 CLI 消费**——SESSION_LOG user_message 即发即记；ackId 回显语义=「已投递」，hold:"turn" 回合收口才是消费级（session-manager:453-466/:3830-3835，W-AUDIT-A #11 精化） | adapter sendMessage 立即 onLog | **已修 2026-10-19（W-DISPVIS）**：project-detail receipts 带 consumed 布尔（消费=回合收口 done/failed），web 活动行两态点（灰=已注入/绿=已消费） |
| B5 (P5) | ~~外部链 stop 后 pending 残留~~ **现码不成立**：stop（extStop=注入 Esc 打断）排队消息照常投递（bridge:1728-1755）；进程死亡路径看门狗收口清 pending+留弃单日志（bridge:1181-1187，4a9cd7b 起）；仅剩「进程死亡→看门狗扫描」窄时窗可见残留 | W-AUDIT-A 实锚 | 已修（时窗面可注扫描间隔） |

### 2.3 生产实证（w-sched-c，2026-10-19 前夜 12h 窗）

**21 单零丢失零不处理**：dispatch→台账 running 0-2s（21/21 配对）；dispatch→prompt 注入**全部 0.0s**（21/21，user_message 带 task_ref 精确对时）；prompt→CLI 首响应 13-323s（中位 ~65s）。受控复现单全链 35.6s 零卡点。
**「收了不处理 SESSION_DONE」=换流窗观感**：dispatch→prompt 即达（0.0s）→目标 worker 回合已 DONE→换流/等待消费→CLI 新回合处理。~~等 autoRevive 拉活轮询 30-60s~~ **（W-SCHEDFIX2 证伪：全仓不存在 30-60s 拉活轮询——dispatch→DONE 熟手同步走 resumeAgent；65s 中位窗实为 CLI 重启+transcript 重载+模型首 token；直注落地后健康熟手只剩首 token）**。
**排队丢失 0 实证但有两点风险备案**：①历史前科在案（W-INJECT 批修过账本回退 miss 窗口事件永久丢失——relay 重启窗 in-flight 帧黑洞，已修）；②窗口内 relay 未重启，该风险面未被测试。

### 2.4 熔断恢复链与压制闸（W-AUDIT-B 补——整链此前漏画）

- **熔断记账**：resume init 失败连击（resumeAgent 看门狗 ERROR/reviveSaved fail/看门狗接管失败三入口）达阈值→**指数退避冷却** `min(base×2^(streak-threshold), cap)`，系统行提示「自动恢复进入冷却（本次 N 分钟）」；streak 仅 onInit 成功复位（session-manager:4945-4960，复位 :3614-3615）
- **suppressAutoResume 双压制闸**（:4963-4979）：①熔断冷却中 ②**pin 停放休眠**（pinned+saved 且无 agent=用户手动停放的「点卡按需恢复」形态，#49）——两态压制一切自动拉起；带 queueMessage 的注入改入队 unacked（恢复后补投），纯跳过类（值守 prompt/引导语）直接丢
- **flushResumeBacklog 的 renewable 丢弃例外**（:4985-4990）：冷却期积压补投时，renewable（值守 prompt）不补投直接丢（旧 prompt 队列快照已过期，duty 下轮重推导）
- **熔断计数为内存态，重启即赦免**

### 2.5 relay 重启窗·六本账命运（W-AUDIT-B 补）

| # | 账本 | 重启命运 | 证据 |
|---|---|---|---|
| 1 | 托管链 unacked 重放账 | **纯内存，重启即清**——B1 修复只覆盖运行期流死；重启窗内未消费消息+冷却期 backlog 全灭 | session-manager:484 |
| 2 | dispatch-queue.json | 持久+boot 回灌 ✓；但落盘失败=内存有效重启丢该单（warn 后无重试无通知——磁盘满时静默弱化） | :7482 |
| 3 | duty continuation 退避 | setTimeout 不持久——sleep 退避窗内重启=喂活链断，等下一 trigger | :5119 |
| 4 | 熔断计数/冷却 | 内存态重启即清（=重度失败会话重启后立即再试） | :484 |
| 5 | 外部链 pending_inputs+stuckWatch+verifyTimers+askFallback | 全内存全灭；ext 会话本体经 ensureExternal 从 transcript 重建（:404），但**排队消息与看门狗账本不重建** | bridge:308-330 |
| 6 | 置顶清单 | pinned 跨重启保留（applyPinned 登记为休眠 saved）；写穿失败静默降级 | :422/:442 |

---

## 3. 段三：worker 执行（吸收 w-sched-b/c + W-SCHEDFIX2 修正）

### 3.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 3.1 | CLI 进程拉起 | relay agent-adapter（托管）/ 用户或 PM 手动（外部） | dispatch 认领成功边（2.5a/c）或手动建会话 | **SDK spawn 子进程**（托管）；外部链=用户自启 CLI+hook 桥接 | CLI 进程+转录 JSONL | SESSION_CREATED 帧 |
| 3.2 | worktree 磁盘隔离 | worker 会话自身 | 动工前（纪律层） | `git worktree add`（**纪律强制**，非机器闸；混合工作区坏包=0927 事故根源） | /private/tmp/cc-deck-w-* 独立目录 | git worktree list |
| 3.3 | 执行循环 | CLI 进程 | spawn 后持续 | **SDK 回合循环**（prompt→模型→工具→…→回合终态） | 转录+工作区文件 | SESSION_ACTIVITY/SESSION_UPDATED 事件流（events.ndjson） |
| 3.4 | 等反馈 | CLI+relay | 遇 AskUserQuestion/权限请求 | **SDK 控制流 pending**（denyAllPending/interrupt 管理面） | 权限 pending 队列 | 确认卡（端上） |
| 3.5 | 回合收口 | relay（onTurnEnd 真入口） | 模型回合结束 | **事件**：ok→status=DONE+清 done_reason+auth_hint+SESSION_DONE 帧（:3909-3912）；**!ok→ERROR+last_error+authHint 挂兜底重探**；closeOpenDispatches(done/failed)→notifyDispatchClosed→DISPATCH_DONE transient（emitTransient :5068）→ PM 感知 | SNAPSHOT 状态 | SESSION_DONE 帧；PM 侧值守喂活计数+1 |
| 3.6 | 死会话复活 | relay | ~~30-60s 轮询~~（**W-SCHEDFIX2 证伪：不存在**） | 实际三类：①autoReviveManaged **仅 boot 后 5s 一次**②激活器**纯事件驱动**③dispatch 认领 DONE 熟手时同步 resume/直注（2.5b/c）；壳侧 kickstart 由壳负责（patrol.ts:5 分工注释） | — | resume/直注日志 |
| 3.7 | patrol 巡检 | relay patrol.ts | **定时器**：light 5min / full 30min（CCR_PATROL_LIGHT_MS/FULL_MS 可覆盖；CCR_PATROL=0 应急停） | 轮询快照健康→异常 notifyDone 同通道推送 | — | 黄框/绿框通知 |

### 3.2 丢失面（段三）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| C1 | **worker 卡死无机器超时**——执行中卡住靠 Leader 行为纪律巡检（铁律 1：40 分钟无动作查事件流），无逐 worker 机器看门狗 | CLAUDE.md 铁律（行为层） | 未修（行为兜底） |
| C2 | **换流窗「发了像没发」**——DONE 熟手换流路径窗长中位 65s、长尾 323s（CLI 重启+重载+首 token）；健康流直注已落（W-SCHEDFIX2），换流路径与「等待中」可见性角标仍开放 | w-sched-c §二 + w-schedfix2 回执 | 部分（直注落；角标未落） |
| C3 | **上下文吃紧**——紧急收尾协议收口+拆接续 worker 是行为纪律；机器面无水位自动收口 | CLAUDE.md 铁律 1 | 未修（行为兜底） |
| C4 | **混合工作区坏包**——多会话共享主 checkout 磁盘时构建扫进别人未提交代码（0927 事故根源）；机器闸=check-bundle-sync.sh 部署前必跑 | CLAUDE.md worktree 铁律 + 脚本 | 已修（机器闸+纪律双层） |

---

## 4. 段四：worker → PM（吸收 w-sched-b/c + 补查）

### 4.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 4.1 | 回执写文件 | worker 会话 | 交付收口时（自觉纪律） | **Write 工具**（同步落盘） | `~/.cc-deck/artifacts/w-*.md` 或 `/tmp/<批>/receipts/fix.md`（末行固定格式「结果：…｜改动文件：…」） | artifacts 目录；deliver 看板 |
| 4.2 | deliver 登记 | worker/PM 会话 | 交付物产出后 | **HTTP** `~/.cc-deck/bin/deliver <路径>` → POST /api/deliver（只记 path/size，不动文件） | `data/deliverables.json`（重启回放挂回）+ artifacts-index.json（W-ART 账本） | 输出物看板 |
| 4.3 | git 提交 | worker 会话 | 开发过程中/收口 | **git commit**（分支纪律：worktree 内随意，squash 回主干） | feat/w-* 分支 | git log |
| 4.4a | PM 感知·事件 | relay → PM 会话 | 回合收口瞬间 | **transient 事件** DISPATCH_DONE（session-manager:5060）——PM 在线即达；**PM 正忙/离线则丢**（D1） | 不落盘 | PM 会话内提示 |
| 4.4b | PM 感知·值守喂活 | relay leader-duty.ts → 注入 PM CLI | **事件触发**：worker_done_pending 计数（worker 回合 DONE 且未被 Leader 处理；托管侧 onTurnEnd 内 :3958-3959——目标=Leader 自身→归零+feedPM("turn_end")；其他会话 ok→+1+feedPM("worker_done")；external 侧 finishExternal 同款 :2358/2361）在 PM turn_end / worker_done 边沿生成 feed 候选 → 注入「[值守喂活]」prompt（含队列最老项+处置指令+DUTY_RECEIPT 回执协议）。**两个节流语义**：①K=3 防忙等——连续 3 次 feed 后写一次性延迟喂活（setTimeout wake_once，跨重启不持久 :5116-5124）②PM WORKING 时合并不追加（:5281 直接 return，候选留给回合终态重算）——「为什么有时没喂」的完整判据 | duty 队列+**PM_DUTY_ROUND 审计账**（data/duty-rounds.ndjson append-only：feed_id/result/blocked/continuation，:5146-5176） | PM 会话内 [值守喂活] 消息；duty-rounds.ndjson |
| 4.4c | PM 感知·巡检 | relay patrol / PM 自巡检 | patrol light 5min / full 30min；PM 行为层 40 分钟无动作查事件流（铁律 1） | **轮询** | — | 通知/巡检记录 |
| 4.4d | PM 感知·机器核验 | verify-receipt-claims.mjs / check-deploy-complete.sh | 收割时（Leader 主动跑） | **脚本断言**：回执声明逐条核验+部署完整性五面闸 | 核验输出 | 终端输出 |
| 4.5 | 收割 | PM（Leader） | 感知到交付后 | cherry-pick/squash → 全量自测 → 合并/部署/出包 | 主干 git+生产部署位 | git log/闸输出 |

### 4.2 丢失面（段四）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| D1 | **worker 交付了 PM 不知道**——收口事件（DISPATCH_DONE）是 transient，PM 会话若正忙/离线，感知退化为巡检轮询或用户催；值守喂活（4.4b）已把 worker_done 计数化，但喂活依赖 PM CLI 存活 | session-manager:5060 + leader-duty.ts | 部分（值守喂活已上；transient 丢失面仍在） |
| D2 | **看板卡与回执劈叉**——裸设置器（moveEntryByDispatch）可碾过业务闸，搬卡入口未全过内核时卡态与实际交付脱节 | 团队经验条目（状态机第四写口审查法） | 待核（审查方法论已立，专项修复未见立案） |
| D3 | **回执虚报**——声明「已验证」实际未做；机器核验器 verify-receipt-claims.mjs 已建（核验分级硬规则配套） | CLAUDE.md 铁律 8 + 脚本 | 已修（机器闸；真机行为仍需人核，L3/L4 项 headless 断言≠真机） |
| D4 | **relay 重启窗事件黑洞**——账本回退 miss 窗口事件永久丢失（真产品 bug） | W-INJECT 批已修 | 已修（账本回退修 miss 窗口） |

---

## 5. 段五：PM → 用户（本批补查重点）

### 5.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 5.1 | 版本 bump | PM（Leader） | 出包批次开始 | **人工** `echo <ver> > VERSION` + `node scripts/version.mjs --write`（七落点派生：expo app.json/build.gradle/双 web-console/desktop package.json/plugin.json/marketplace.json） | VERSION（唯一事实源）+七落点 | pre-commit 钩子校验 |
| 5.2 | 出包发起 | PM | 本地测试通过后 | **人工**跑 scripts/release-test.sh 机械链（实际序含提交步，W-AUDIT-B E1 修正：①bump ②--write ③build-plugin 重建 bundle ④git add -A+commit ⑤check-bundle-sync 守卫不绿可 git reset --soft HEAD~1 回退、绝不 tag ⑥tag v<X.Y.Z>-test.N-nova ⑦push ⑧等 CI） | git tag+分支 | 闸输出 |
| 5.3 | CI 构建 | GitHub Actions runner（android=ubuntu；desktop.yml 双作业=windows（exe/NSIS+updater 签名 latest.json）+ **macos-14（dmg，未签名**） | tag push 到远端（**webhook 事件**） | push 触发 android.yml/desktop.yml；产物 upload-artifact（snap 不建 Release 不传清单） | Actions artifacts | gh run list |
| 5.4 | KV 三件推送 | PM 手工 | CI 绿后 | **手工** scripts/kv-put-verified.sh（put 后强制回读校验：≤8MB 全量 md5/大文件 Range 抽查首尾 1KB+总长——F4 分档 W-RELFIX 落；api.cloudflare.com 被墙时 curl 走本地代理打 REST 等价上传）。清单推送已带**配对闸**（回读 version==本次 VER 不符即阻断，F1 W-RELFIX 落：ECS+KV 公网双过闸） | KV：cc-deck-<ver>.apk / -setup.exe / latest-test.json | https://cc.humumu.online/dl/* |
| 5.5 | 部署位同步 | PM | 收割后 | cp relay.mjs+web-console → cc-plugins 部署位+desktop-tauri resources+App Resources/relay-service；check-deploy-complete.sh 五面闸；relay 换 bundle=kill sidecar（App 监督线程存续意愿自动重拉） | /Applications/CC Deck Nova.app/Contents/Resources/* | 五面闸输出 |
| 5.6 | 手机更新检查 | expo app（updates.ts） | **每次 App 启动自动检查（#387 起不再 24h 窗口，App.tsx:869-875）+ 关于页手动**；shouldAutoCheck/CHECK_WINDOW_MS（updates.ts:150/:43）为死代码残留零调用 | **启动一次性+用户触发**：GET 双镜像清单（KV 主域 https://cc.humumu.online/dl/latest[-test].json + ECS http://8.133.211.170:8888/…；通道隔离 test 读专属清单）→ isNewer semver（同号正式>预发布；dev 通道豁免）→ 下载（.part 断点续传，Range 206 才续；AppState active 自动续+指数退避+4 次失败换源）→ 校验=**size===total+10MB 下限（:518）+安装器 APK 签名兜底**（「KV 通道 md5」属服务端 kv-put-verified 上传闸，不在端上链）。**全链静默容错失败返回 null（失败即失明，服务端不知道）；安装器拉起失败 installFail 标记（:355，#6）** | 本地 .part/安装包 | 关于页版本号/更新弹窗 |
| 5.7a | 通知·绿框 TASK_DONE | relay（notifyDone :1755） | /api/notify POST 或任务收口 | **HTTP/事件**→bus.emit **落盘**+last_task_done | events.ndjson 落盘帧 | 端上绿框通知（可回放） |
| 5.7b | 通知·黄框 [待确认] | relay（notifyConfirm） | /api/notify mode=confirm | **HTTP**：目标会话 todos 追加 pending 条目（**落盘兜底**）+ emitTransient USER_NOTE（**seq:0 不落盘不补发**——离线端丢，靠 todo 兜底=弱兜底） | todos 落盘+transient | 端上黄框；会话待确认条目 |
| 5.7c | 通知·决策 ledger | decision-notify.ts | 五类事件（org-confirm/waiting/dispatch/acceptance/system） | **事件**+revision 快照持久 | decision ledger | 离线重载不丢 ✅ |
| 5.8 | 验收单出单 | bin/acceptance（Python） | PM 批次交付时人工跑 | **脚本**：宽容解析四段结构 → data/acceptances/<id>.json（cwd=出单会话归因键 #138+per-sheet key #28）→ 双链：LAN http://<en0 动态 IP>:8787/acceptance/<id> + 云 https://cc.humumu.online/view/acceptance-<id>.html#<key>（顺序闸：key 先传成功才吐云链接；失败降级 LAN only） | acceptances/<id>.json+KV key/页面 | 双链消息 |
| 5.9 | 验收回流 | 用户浏览器 → LAN 直提 / CF Worker → KV → relay | 用户提交后 | relay **60s 定时轮询**拉回 KV 提交数组（去重身份键=**k nonce 优先、内容签名兜底**，acceptance.ts:388-401 #28；同一套校验落盘） | <id>.results.json（history 帽 50 条 #25-P4） | 回填通知 |
| 5.10 | 回填归因闭环 | relay（ws-server:58 → settleAcceptanceResult :5460） | results 落盘后 | **事件**：按 cwd 归因 matchSessionByCwd → 会话通知；cwd 匹配不到/会话已收摊=**静默**（设计取舍）；全 ✓ 唯一触发看板卡 done；归因 NULL 档零写/unknown 禁操作/卡态不回转（done 终态） | 看板卡状态 | 卡 done+会话通知 |

### 5.1 出包分发链（test 包为例）

```
VERSION（唯一事实源，七落点由 version.mjs --write 派生）
  → scripts/release-test.sh 七步机械链（2026-10-11 手工顺序三次犯错后的锁死）
  → CI：android.yml（ubuntu runner，versionName 烙 tag 后缀）/ desktop.yml（windows
    runner，NSIS + tauri updater 签名 latest.json）
  → Actions 产物（upload-artifact；snap 不建 Release 不上传清单）
  → 手工推 KV 三件：kv-put-verified.sh（put 后强制回读 md5 比对 + zip 类 unzip -t）
    ⚠️ 包与清单是**两次独立手工动作**——只传包不传清单=手机不更新（无机器闸 F1）
  → 部署位同步（relay.mjs+web-console → relay-service）check-deploy-complete.sh 五面闸
```

正式版三段式：`v<X.Y.Z>` 干净 tag → CI 建 GitHub Release + latest.json 清单 → `scripts/release-publish.sh`（⓪版本一致性闸 → ①下载产物 → ②推 ECS+KV tauri manifest → ③ /api/notify 广播 → ④核对）→ main 快进。

### 5.2 手机更新检查链（expo-app/src/updates.ts）

```
24h 静默检查 + 关于页手动检查（FETCH_TIMEOUT 5s，全链静默容错失败返回 null）
  → 双镜像清单：KV 主域 https://cc.humumu.online/dl/latest[-test].json
             + ECS http://8.133.211.170:8888/latest[-test].json
    （通道隔离：test 通道读专属清单，正式/快照设备永远看不到 test 包——
     test.11 曾混入主清单，正式用户被提示装测试包，2026-09-18/20 修）
  → isNewer semver 比较（core 三段+预发布串；通道规则：同号正式>预发布；
     dev 通道整链豁免不参与——0.5.2-dev.90 首启被提示"升级"降级包实踩）
  → 下载：清单 url 优先（本域 KV 直出，公司网屏蔽 ECS 裸 IP 不再失明）
     .part 断点续传（Range 206 才续，200 全量重下）+ AppState active 自动续传
     + 指数退避 + 4 次失败换源
  → 校验：size===total 精确比对 + 10MB 下限 + KV 通道 md5 实测
    （ZIP magic 常量错字曾致更新自上线从未成功过一次——校验常量必须从真实产物
     反推；expo readAsStringAsync length:4 在 Android 不生效返回整文件 base64，
     magic 比对已整体移除）
  → 系统安装器（APK 签名兜底）
```

### 5.5 丢失面（段五）

**已修（历史事故台账，防再犯证据链）**：

| # | 事故 | 根因 | 修复 |
|---|---|---|---|
| E1 | 应用内更新自上线从未成功过一次（99% 循环） | ZIP magic 常量手算错字（`UEsDBg==` 应为 `UEsDBA==`）恒 False→每次下载完判假包删除重下 | 26b70eb 修常量；dfc3814 整体移除 magic 比对（expo length:4 在 Android 不生效） |
| E2 | 断点续传拿 200 弃包全量重下 | CF Worker /dl/ 直出无 Range | 87a84f8 加 206/Content-Range（worker v4a8de4b5） |
| E3 | 公司网更新死路 | cc-deck.apk 硬 302 ECS 裸 IP 被屏蔽 | **87a84f8（修复主体：KV 直出优先+Range/206+manifest url 优先）**+7d6e659（配套 dlOut 变量修正）——W-AUDIT-A 归因重排 |
| E4 | 正式用户被提示装 test 包 | test.11 混入主清单 | 通道隔离：test 专属清单 latest-test.json + 永不进主域纪律 |
| E5 | test 清单停更→手机被推 0.6.1 降级包（W-NQA M1） | 清单单源失明+比较器跨线 | isNewer 通道规则 + dev 通道豁免（updates.ts:99-134/239-267） |
| E6 | 正式版已发版本号被 test 基线复用（0.5.2-test.17 事故） | 无基线校验 | build-test-apk.sh 基线守卫：base 不严格大于 ECS latest.json 即拒 |
| E7 | KV 坏包装机闪退+99% 循环误导向（test.1 事故） | 上传无校验 | kv-put-verified.sh：put 后回读 md5 + unzip -t |
| E8 | test.24/25 连续两晚上传失败 | api.cloudflare.com 被墙，wrangler 直连超时（undici 不吃 http_proxy） | curl 走本地代理打 REST 等价上传，md5 回读照旧 |
| E9 | 手工出包顺序三次犯错 | 靠人记七步 | release-test.sh 机械链锁死，守卫不绿绝不 tag |
| E10 | bundle 提交欠账（77caf1a 后）+ 中间态三红闸 | 无版本一致性闸 | W-RELCHAIN：VERSION 唯一源七落点 + pre-commit 钩子 + check-bundle-sync（两两一致+同参重建对比+版本闸） |
| E11 | 「修了没效果」五轮排查（test.32-36 时代） | Tauri v2 壳页面**编译期嵌进二进制**，对 Resources/web-console 热部署完全无效 | 1017 教训固化：壳 HTML 修复唯一生效路径=重编译换装；check-deploy-complete.sh 五面闸 |
| E12 | 验收卡永久滞留（12 张仅 2 消） | 消失条件=全行判完，实际填单常留未测 | #195 submitted 语义 |
| E13 | 单文件 history 无上限膨胀 | 云回流反复改判只增不减 | #25-P4 本地 50 条帽 |

**未修/开放（当前风险面）**：

| # | 风险 | 证据 | 建议 | 状态 |
|---|---|---|---|---|
| F1 | **KV 清单漏推无闸**：包与 latest-test.json 两次独立手工推送——test.25→test.36 实证发生 | ccdeck-1017-test37-state | 出包链尾加「清单版本==tag 版本」机器核验 | **已修（W-RELFIX 8f257bb：ECS+KV 公网双配对闸，阻断语义），待装机验证** |
| F2 | **阿里云镜像 latest-test.json 404**：双镜像第二源失效，KV 主域兜住 | 同上 | 补镜像需 aliyun-run.mjs 远端执行，被生产读取权限闸拦，等用户放行 | 等用户 |
| F3 | **LAN IP 漂移**：.105→.103，文档固定口径过时（bin/acceptance 动态探测没问题） | 同上 | 文档口径改「以出单工具回吐链接为准」 | 未修 |
| F4 | **kv-put-verified.sh 回读误报**（代理慢 300s 超时/md5 全对报损坏——2026-10-19 test.44 实锤） | 同上+当晚实操 | 分档校验+Range 抽查兜底 | **已修（W-RELFIX 8f257bb：≤8MB 全量/大文件 Range 抽查+全量 600s 兜底，生产键活体验证一次过），待装机验证** |
| F5 | **transient 通知离线不补发**：USER_NOTE（seq:0）离线端丢失，todo 兜底是弱兜底 | session-manager notifyConfirm | 评估决策通知 ledger 面统一收编 | 未修 |
| F6 | **发版广播单点丢失**：/api/notify 无在线端 503 即丢，无重试无队列 | ws-server handleNotify | 发版通知改走 decision ledger 或落盘事件 | 未修 |
| F7 | **embedded-relay.log 排障盲区**：长时段零带时间戳行，inject/submit 面全无日志 | w-sched-c §五.3 | 查日志链+补 dispatch 注入结构化日志行 | **已修（W-RELFIX：[dispatch] start/dispatched/running/queued/failed 七行+[submit] ext-input+启动 pid 行；生产活体验证 start/dispatched/running+pid 行），queued/queue-full/ext-input 三行待顺验** |
| F8 | **装机-验收断点靠人**：出包→用户装→填单全链无机器跟踪 | scripts/delivery-tracker.sh | 待拍板（装机遥测——隐私边界需用户定） | 未修 |

---

## 6. 监控覆盖矩阵（现状总览）

| 面 | 机器监控 | 缺口 |
|---|---|---|
| 用户消息到达 | unacked 重放账（托管）+ ackId 对账 + events.ndjson | ~~B1~~ 已修 2026-10-19；ackId 回显=已投递证据，消费级=hold:"turn" 收口（B4 已上 consumed 面） |
| 任务清单 | hooks 双闸 + pollTaskStore（30s 节拍 :863/:523+事件边 :2931）+ 看板镜像 + 手机 tab 同源 | 入单转化率无监控（A1） |
| 派单 | dispatch-log.ndjson 台账 + **[dispatch] 结构化日志行**（F7 落）+ 注入三分支账面 + consumed 消费态（W-DISPVIS） | queued/queue-full/ext-input 日志行待顺验；换流窗角标已落待装机验 |
| worker 执行 | events.ndjson + patrol（light 5min/full 30min）+ 熔断恢复链（指数退避+双压制闸） | 逐 worker 卡死无机器超时（C1）；熔断计数内存态重启赦免 |
| 结果回传 | verify-receipt-claims + delivery-tracker + artifacts-index + 值守喂活（worker_done 计数+**duty-rounds.ndjson 审计账**） | 看板卡断链待核（D2）；喂活依赖 PM CLI 存活 |
| 出包分发 | check-bundle-sync + kv-put-verified 分档回读 + **清单配对闸（F1）** + check-deploy-complete 五面闸 | F2 镜像；F3 口径 |
| 手机更新 | 端上全静默容错（设计：失败不打扰）+ installFail 标记 | 失败即失明，服务端不知道用户更新失败 |
| 通知 | decision ledger 五类持久 | transient 类不补发（F5）；无在线端广播丢（F6） |
| 验收 | 待填汇总随 SNAPSHOT + 60s 云回流（k nonce 去重）+ cwd 归因回填 + 卡 done 联动 | 归因失败静默（设计取舍）；装机遥测无（F8） |

## 7. 建议优先级（2026-10-19 深夜状态：1-4 已收口，余项交后续）

1. ~~B1 系统注入补账~~ **已修**（W-SCHEDFIX2）；~~B4 已注入/已消费两态~~+~~C2 角标~~ **已修**（W-DISPVIS，待装机截图验）；~~F1/F4/F7~~ **已修**（W-RELFIX，待装机验证）。
2. **未修首推 F5/F6**（transient 补发+广播兜底）——通知面唯二丢失点，建议 decision ledger 统一收编。
3. A4/A5 Stop hook 判据精化（mtime→按会话归属）——低危随手修。
4. F8 装机遥测（等用户拍板隐私边界）、F2 镜像（等用户放行权限）、F3 文档口径。
5. expo 侧死代码清理：updates.ts shouldAutoCheck/CHECK_WINDOW_MS（W-AUDIT-A #3 顺带立案）。

---

# ═══════════ v4 新增五章（2026-10-21，W-AUDIT4 #196）═══════════

## 8. 主链拓扑两态：可选 Leader 节点（协作模式开关）

主链不是恒定五段直线——`collab-mode.json`（settings.ts readCollabMode，SNAPSHOT.collab_mode 下发）决定**用户与 PM 之间是否插入独立 Leader 节点**。两态各自成链、损失点不同：

### 8.1 两态拓扑

```
态 A：leader（协作模式开——Leader 节点在场）
用户 → Leader CLI（org 锚卡 leader_session_id，no-leader 时隐藏）
     → PM（dutyTargetId 解析：协作开=Leader 锚卡为值守目标）
     → 派单系统 → worker → PM → Leader → 用户
  特征：Leader 是常驻值守会话（feedPM 喂活目标=锚卡）；SNAPSHOT 过滤锚卡
  （snapshot() hideLeader 分支 :866——锚卡不进会话列表）；isLeaderSession
  判定链（:884 collabMode()=="no-leader" && env==leaderId）
  损失点：Leader 自身死亡=整链头部失聪（pmwake 链=1014 事故族：PM 本体/
  死壳/bg-spare 三 gap）；Leader 换届靠 org 锚卡回写（onInit 回写 leader_sdk_id）

态 B：no-leader（协作模式关——当前生产态，PM 兼任 Leader）
用户 → PM（同一 CLI 会话，dutyTargetId 解析：no-leader=用户实际 PM 会话，
  external 且进程活；无目标=可观测哑值守 no_pm_target 审计行，优于喂弃用
  锚卡的假象 continue）
     → 派单系统 → worker → PM → 用户
  特征：PM 一身两角（分诊+值守+收割）；值守目标=活 external PM；锚卡隐藏
  损失点：PM 会话死亡=值守目标消失→feedPM 全部 sleep（no_pm_target）——
  无人派单无人收割，直到 PM 复活或用户开新 PM；「PM 兼任」意味着 PM 的
  上下文水位直接吃主链容量（1021 多波断点与此相关）
```

### 8.2 两态切换损失点

| # | 损失点 | 证据 | 状态 |
|---|---|---|---|
| T1 | **切态瞬间的值守目标真空**——no-leader→leader 切换：锚卡尚未 ensureLeader 建立/换届前，dutyTargetId 空窗期 feed 全 sleep | dutyTargetId 两分支 | 未修（低频操作+哑值守审计行可查） |
| T2 | **两态判定读盘每次现算**——readCollabMode 每 snapshot/每 isLeaderSession 调用读 collab-mode.json（低频路径可接受口径，与 employeeHomeState 同款） | :866/:884/:889 | 备案（性能面非正确性面） |
| T3 | **态 A 的 Leader 死亡检测靠 dutyTargetId pid 闸**（external 且进程活）——pid 复用/换壳（1014 死壳 ab91190d 注入黑洞案例）判定漂移 | 1014 pmwake 事故族 memory | 部分（walk-first pid 根修 4b7ae45 落；死壳残留会话仍需 retire） |
| T4 | **切换不迁移在途单**——切态时 dispatch-queue/台账 running 行不感知拓扑变化（承接者照旧，但「谁该收割」的语义在两态间漂移） | 设计现状 | 备案（单量低时可忍） |

## 9. 三可视面投影审计（看板 / 任务 tab / 通知中心）

同一任务生命周期在三个可视面各有一份**投影**——投影=从各自数据源单向派生，失真=投影与权威账本不一致。审计口径：数据源→同步机制→刷新时机→失真案例。

| 可视面 | 权威数据源 | 同步机制 | 刷新时机 | 已知失真案例 |
|---|---|---|---|---|
| **看板**（org board） | org/<gid>/board.json（五态卡） | relay emitBoard 差分广播（BOARD_UPDATED entity_refs+delta，M13-2 v2 投影）+expo/board-mirror 单向镜像（autoRevive/pollTaskStore 不受镜像污染，W-NREV2 正面确认 58/58） | 板写边（upsert/搬卡/gate 翻转）+30s 轮询兜底 | ①mock 板帧不落列坑（W-V8A 实录：mock 数据源板帧被订阅链静默吞——IIFE 误用 root.querySelector）②裸设置器 moveEntryByDispatch 碾过业务闸（D2 待核——「第四写口」审查法）③SSOT 风险：板文件单点全量覆盖写无 journal（W-SSOT-C 架构级发现，建议 P2 前落 delta journal）④三账缺角（台账 running/任务面/板面不一致——CHAIN2 runLedgerRecon 上线前靠人眼，1021 对账 5 孤儿实证） |
| **任务 tab**（会话 todos） | ~/.claude/tasks/<cli_sid>/<n>.json（CLI 侧权威） | relay pollTaskStore（30s 节拍+会话事件边）→SNAPSHOT.todos→手机 tab；PM 会话另有 mergeBoardMirror 单向镜像（只读不回写，W-TASKFLOW 锁死） | 30s 节拍 :863/:523+事件边 :2931 | ①s.state.todos 的「CLI 存储统一覆盖」与 autoReviveManaged 拉活链曾让外挂同步器恒输震荡（团队经验实录——candidate 镜像落点先查既有权威写者）②会话死亡任务滞留（A4——跨会话不自动携带，180 目录实查）③CLI 工具集缺 todo 工具=转录无任务调用（A2，GLM 别名已绕） |
| **通知中心** | notifications.json（relay 内存+离线重载）+decision-notify ledger（五类持久） | 落盘事件（TASK_DONE/GREEN 黄框）+transient（USER_NOTE seq:0 不落盘）+ledger revision 快照 | 事件边+重启回放（loadNotifications） | ①transient 离线丢（F5——todo 兜底=弱兜底）②发版广播无在线端 503 即丢（F6）③通知头 chip 被移动链覆盖成「1」（W-NQA F11）④**交付零通知 2 波（1021 实战）**——worker 交付后 PM 侧无感知事件到达，D1 transient 丢失面实证（值守喂活计数兜住第 2 波）；NOTIFY2/CHAIN2 后 turn-report 外报补此面 |

**投影失真的共性根因**：三面各自订阅不同账本（板 json/任务 json/通知账），**没有单一事务保证**跨账一致——一致性靠「写边顺序约定+事后对账」（CHAIN2 三账对账=事后对账的机器化）。

## 10. 验收单回流腿损失点（独立审计）

出单→用户填→回流→归因闭环是主链外**唯一用户直接参与的腿**（v3 §5.8-5.10 基础上独立成节补损失面）：

| # | 损失点 | 机制 | 状态 |
|---|---|---|---|
| V1 | **归因失败静默**——回流后 matchSessionByCwd 按 cwd 归因：cwd 匹配不到/会话已收摊=零通知零卡动（设计取舍「不猜」） | ws-server:58→settleAcceptanceResult :5460 | 未修（设计取舍；#198 W1 gid 归因键已上——出单带 gid 的单归因精度提升，存量 cwd 单照旧） |
| V2 | **60s 回流窗依赖 relay 存活**——KV 轮询拉回在 relay 重启窗暂停（重启后恢复，KV 提交数组不丢——服务端持久兜住） | acceptance.ts 60s 轮询 | 可接受（服务端持久） |
| V3 | **双链同失效场景**——LAN IP 漂移（F3）+云通道故障同时发生=用户无可用填写入口；单链失效可忍 | bin/acceptance 双链 | 未修（F3 文档口径待改+云通道依赖 CF） |
| V4 | **回填内容本身无校验**——用户填 ✓/✗/未测自由文本，写错行/看错任务号的错账不可检（颗粒度铁律降低概率） | 表单自由填 | 设计接受（验收纪律文档约定） |
| V5 | **全 ✓ 触发卡 done 的单向性**——卡态不回转（done 终态），回填后发现误 ✓ 只能人工纠板 | 设计 | 备案 |
| V6 | **待填汇总上限 20 张**——超限老单不进 SNAPSHOT 汇总（表单页仍可打开）：长期挂单多时手机看不到第 21 张 | listAcceptances limit=20 | 备案（帽防膨胀；分页属后续） |

## 11. 旁路纠错通道（观察者 / 巡检 / 回执闸 / NOTIFY2+CHAIN2 五层栈）

主链之外的纠错通道全景。**五层栈**=1021 上线的两批（W-NOTIFY2 #92 + W-CHAIN2 #199）构成的递进防御：

```
层 1 事后对账（最外圈）  runLedgerRecon 三账对账（CHAIN2 D）：台账 running↔任务面
  （~/.claude/tasks 全局 pending/in_progress）↔板面（claimed/doing）三元缺角
  upsert 告警+心跳文件（recon-heartbeat.json，patrol 查龄>70min 告警停跳）；
  触发=PM turn-report+patrol full 双触发。1021 对账 5 孤儿=此层上线前的实证
  （人工对账发现；上线后机器化）
层 2 周期巡检            patrol light 5min/full 30min + CHAIN2 B 补盲六件：
  ①熔断到期补试 feedPM(patrol-retry)（5min 幂等窗）②审计移出 60s 频控门
  ③stale 补 WAITING>2h/compacting>90min（压缩卡死原永久静默）④三 sleep 支
  升级通知（no_pm_target/resume_breaker/pm_parked 手机无感→waiting/actionable）
  ⑤patrol.push 无 target 落 ALERT-NO-TARGET 账 ⑥[dispatch] 结构化日志七行
  （W-RELFIX，queued/queue-full/ext-input 待顺验）
层 3 事件外报（最内圈）  turn-report.mjs（CHAIN2 A）：CLI Stop 钩子外报
  /api/turn-report（CCR_RELAY_CHILD 跳过/transcript 尾 uuid 幂等/无 uuid 退
  指纹/失败静默落 turn-spool）；PM 收到=重跑 feedPM+对账，worker 收到=60s
  同键去重+worker_done 边沿喂活——「PM 死了也没人报」的断电面收口
层 4 断电补账            turn-spool/<sid>.jsonl（CLI 侧落盘池）+relay 启动 5s
  drain（CHAIN2 C）——外报失败的 turn 窗在 relay 复活后回放补账
层 5 审计镜像            NOTIFY_CHAIN_AUDIT 四动作镜像 data/chain-audit.jsonl
  （emitChainAudit :1002——pm-wake/pm-sleep 等关键动作 append-only；云桥无
  运行时 KV 直推能力，镜像文件=KV 批量同步现成队列，运维脚本后续挂载备案）
```

**既有旁路件**（五层栈之外常驻）：观察者（夜班观察者批——生产组零扰动五查范式）/回执闸（verify-receipt-claims.mjs 机器核验+check-deploy-complete.sh 五面闸）/Stop hook 双闸（task-context 注入+task-stop 拦截，review-gate 1021 起拦「未审查标完成」）/派单后探活（第一纪律：不信 ok 返回，必查落点会话活性）/死会话 member-retire（防「被路由」——1021 死会话路由 6 次实证催生）。

**旁路自身损失点**：

| # | 损失点 | 状态 |
|---|---|---|
| P1 | patrol/recon 双触发依赖 relay 进程存活——relay 挂=层 1/2 全灭（层 3/4 的 CLI 侧落盘不依赖 relay，设计上互补） | 架构性互补已备 |
| P2 | chain-audit.jsonl 镜像→KV 的批量同步脚本未挂载（备案件） | 待运维批 |
| P3 | turn-report 的 uuid 幂等退化指纹（无 uuid transcript）在重复内容回合假阳性去重（60s 窗内） | 低危备案 |
| P4 | 五层栈全部 1021 上线——生产实战数据未积累（层 1 对账告警的真实噪音率未知） | 观察期 |

## 12. 数据层盘点（七账本 + chain-audit + turn-spool）

数据层=全链的地基（第一纪律扩口径：「账实一致是链路可靠的地基，漏记错记=下游可视面失真」）。盘点口径：**写点分布**（谁在写/几个写口）+**持久性**+**账实风险**+**已知险**。

| 账本 | 路径 | 写点分布 | 持久性 | 账实风险与已知险 |
|---|---|---|---|---|
| **任务表** | ~/.claude/tasks/<sid>/<n>.json | 单写口：CLI task 工具（task-lib 权威）；relay 只读（pollTaskStore） | 落盘 ✓ | ①per-session 隔离（180 目录，跨会话不携带——A4）②CLI 工具集缺失=零写入（A2 别名已绕）③落盘滞后（A3 权威存储优先后收窄） |
| **派单台账** | data/org/dispatch-log.ndjson | 单写口：appendDispatch（dispatchWorker/closeOpenDispatches/排队溢出/对账告警六入口同函数族） | append-only ✓ | ①status 行序=末行赢语义（读侧收敛 org.ts byId）②title 键 #NN 由 CHAIN2 D 补（对账 join 键齐备）③**台账 running 行与实际会话死活无绑定**——死会话 running 行滞留=对账孤儿（1021 5 孤儿实证；runLedgerRecon 上线后机器告警） |
| **决策账本** | decision ledger（decision-notify.ts 五类） | 单写口：notify 族（org-confirm/waiting/dispatch/acceptance/system） | revision 快照 ✓ | 五类覆盖面外的事件（如 F6 发版广播）不走 ledger=无账 |
| **通知账** | data/notifications.json | 单写口：upsertNotification/loadNotifications 重放 | 落盘+重启回放 ✓ | transient 类（USER_NOTE）不入账（F5）；通知头 chip 显示压缩失真（W-NQA F11） |
| **artifacts 索引** | data/artifacts-index.json + deliverables.json | 双写口：deliver POST（登记面）/artifacts 关联持久化（W-ART） | 落盘 ✓ | ①两索引并存语义分叉面（W-ORPH 兜底落位批处理过孤儿）②登记=意图声明制（文件移动/删除后索引悬空——无失效扫描） |
| **events 流** | data/events.ndjson | 单写口：bus.emit（seq 单调；transient 帧不带 seq 不落盘） | append-only ✓ | ①transient 帧离线不补发（设计）②重启窗 in-flight 帧黑洞（W-INJECT 已修账本回退）③seq 回绕客户端失聪（isBeyondBuffer 单向，W-NREV-B 拍板项）④体积单调涨（17.7/41MB 实测，无轮转策略——低危） |
| **chain-audit** | data/chain-audit.jsonl | 单写口：emitChainAudit（#199 C 四动作） | append-only ✓ | 镜像→KV 同步未挂载（P2）；与 events.ndjson 职责分工——events=会话域帧、chain-audit=链路动作审计 |
| **turn-spool** | data/turn-spool/<sid>.jsonl | 单写口：turn-report.mjs 失败静默落（CLI 侧） | 落盘 ✓ drain 清档 | ①spool 自身无帽（长期 relay 死亡=无限涨，低危）②drain 幂等靠 uuid/指纹（P3） |
| **板文件** | org/<gid>/board.json | 多写口：upsertBoardEntry/moveEntryByDispatch（裸设置器！）/对账告警 upsert/gate 翻转/依赖解锁 | 全量覆盖写 | ①**无 journal**（单点全量覆盖写——W-SSOT-C 架构级风险，建议 delta journal）②第四写口碾闸面（D2）③三账缺角靠 runLedgerRecon 事后对账 |
| **验收单** | data/acceptances/<id>.json+.results.json | 双写口：出单 bin/acceptance（写单）/回流+云回流（写 results） | 落盘 ✓ history 帽 50 | 归因键演进中（cwd→gid，#198 W1）；results 云回流 k nonce 去重 ✓ |

**数据层三大结构性险**（横切）：①**多写口无事务**——板文件四写口/任务账本与台账无跨账原子性，一致性靠事后对账（层 1）；②**内存态账本重启即灭**——unacked/熔断计数/pending_inputs/duty 退避（v3 §2.5 六本账表）；③**账本间 join 键后补**——#NN 任务号作为人读键直到 CHAIN2 D 才进台账（机器 join 靠约定文本提取，脆弱面：标题不带 #NN 的单 join 不到——出单纪律「带 #NN」是行为层兜底）。

## 13. v4 建议增量（叠加 §7）

1. **P2 板 delta journal**（W-SSOT-C 建议+§9/§12 实证）——板文件单点全量覆盖写是三账失真的最大结构性面。
2. **chain-audit→KV 同步脚本挂载**（§11 P2）——五层栈层 5 的最后一公里。
3. **死会话 retire 机器化**（§12 台账风险③——「派单后探活+retire」从纪律升为 patrol 件：台账 running 行目标会话死亡 N 分钟→自动 member-retire+告警；1021 六次路由实证的最直接根治）。
4. F5/F6 通知 ledger 收编维持 §7 建议（v4 无变化）。

## 13. 1024 实战断点增补（test.57→63 七连包日）

> 1024 全天七连包（test.57→63）高频派单实战新增四条损失点。当日纪律变更：worker_done 喂活到达=立即收割（memory feedback-harvest-on-done，用户「非常重点」定调），巡检降为兜底——运转有效。

| # | 损失点 | 实证 | 处置/缓解 | 根治建议 |
|---|---|---|---|---|
| L-1024-1 | **内容安全过滤杀席**：bigmodel API 400「敏感内容」无预警击杀 worker CLI 会话，席上多单全废 | 1024 16:16 审查席三单全废（review-t57-a 首派即殁）；触发词不可知（正常审查文本命中） | 不可预防只可快速恢复：无回执即对账军规+重派（当日四发落地） | 喂活/巡检对 SESSION_ERROR 帧告警升级（区别于正常 DONE） |
| L-1024-2 | **relay 重启双分身竞态**：auto-revive 与路由侧并存拉起同一 CLI 会话双进程，同写一 transcript+worktree | 1024 22:19 teamsync 席实锤（两 uuid 链交错；worker 击毙分身收编工作未丢，w-teamsync-impl.md 事故记录） | worker 自处置+Leader 收编 | **revive 前「同会话活进程」检测闸**（test-bridge 189g 只测同管理器防双拉，跨重启+路由并存复合场景无闸） |
| L-1024-3 | **派单路由无定向追加通道**：dispatch 路由避开忙碌席→无法给在跑 worker 追加规格/勘误 | 1024 皇冠尺寸勘误两次误投（membergrid 席/designer C 席），靠误投忽略通知兜住 | 误投忽略通知+收割时强校验 | dispatch 支持 `--seat` 定向（允许排队注入忙碌席）或队列化追加 API |
| L-1024-4 | **同文重复卡**：重派未关旧卡致板面同文卡簇 | 编制膨胀×7/优先修复批×3/SRCVANISH×5（W-STALETRIAGE 1024 审计实锤） | 分诊审计 30 条+人工清板 | 建卡前 normalizeBoardCardText 查重闸（单口已立，闸缺位） |

附：当日另一断点「worker 无回执静默收工」三起（审查 A 两连+TS63FIX+AUDITLOG）——与 L-1021「交付零通知」同族，worker_done 即收割军规已兜住恢复侧，**根因=worker 侧收工时回执写入失败无重试无告警**，根治归 §11 回执契约机器闸的收工自检扩展（回执未落盘则 SESSION 拒绝 DONE）。

## 13. 1026 凌晨实战断点增补（test.66 反馈夜）

| # | 损失点 | 实证 | 处置/缓解 | 根治建议 |
|---|---|---|---|---|
| L-1026-1 | **压缩恢复循环吞单**：worker 会话上下文吃紧陷入「压缩恢复锚」重播循环，唤醒后 125s 零产出即 SESSION_DONE（0 files/0 lines），席上队列单（FB66B+FB66 两批 9 件）静默丢失 3 小时 | 1026 00:15 深查实锤（671ad0dc：恢复锚 2 秒重播 8 次→DONE 无回执无提交；该席此前 CHIP3/RELBTN/FB66C/FB66D 四批正常交付=好席退化） | member-retire 退化席 + 合并重派 self-contained 批（W-FB66ALL → 3b5cd57c 落地） | SESSION_DONE **stats 零产出闸**：done 时 files=0 且该席有未完结派单 → 拒绝 DONE/自动升级 pm-wake（现回执闸只对「约定回执缺失」，对「零产出+有单在身」盲） |
| L-1026-2 | **巡检活性假阳性（PM 侧方法 bug）**：`grep "会话id" events.ndjson` 会命中自家命令文本（命令里含 id 字符串），把 PM 自身心跳/日志误读为 worker 活性，掩盖 worker 已停 | 1026 全夜三轮巡检误判「671ad0dc 活跃在干」实为自回声；00:10 改 session_id 字段精确过滤后 5 分钟破案 | 巡检脚本已改字段级过滤 | 巡检件（patrol）固化过滤口径进 runLedgerRecon 同源代码，不留在人肉记忆 |
| L-1026-3 | **回执测试声明环境分歧不可复现**：worker 声称「表测 18/18 绿」Leader 复跑 17/18——**双方输出都真实**，分歧源=bash 3.2 的 `$name<多字节>` 邻接行为 **locale 依赖**（C locale 不炸/UTF-8 locale 把字节吸进变量名 set -u 炸 127）；但 UTF-8 侧实锤 deploy-web.sh:139 **--force 逃生口本身是坏的**（本批要保的正是逃生口）——同机同 bash 仍可因 env 不同得出相反结论 | 1026 01:00 W-DEPLOYGATE 收割复跑实锤（case16 FAIL）→ 打回 W-DEPLOYFIX → 补记最小复现双 locale 对照（LC_ALL=en_US.UTF-8 炸 / LC_ALL=C 不炸）；修后双 locale 19/19 | 收割复跑制度抓到（verify-receipt-claims 精神的人工执行）；${fv} 花括号修+表测硬化（警告行 grep 断言+3.2 语义禁令注释）已收 923120dc | 回执闸（§11）升级：测试类声明必须附**终端原样输出尾部+关键 env（locale/shell 版本）**，verify-receipt-claims 对「表测 N/N 绿」声明抽跑复核（多 locale） |
| L-1026-4 | **压缩恢复循环吞单复发（第 2 例）**：同 L-1026-1 机制，好席干到 5/9 件后退化死亡 | 1026 00:39 W-FB66ALL 席 3b5cd57c：五笔提交（⑦⑧⑨⑩①）后状态摘要连播+files_changed=1 即 DONE，③④⑤⑥+双回执全丢 | member-retire + 续批 W-FB66REST（含核验前席五件+还回执账） | 同 L-1026-1 根治件（零产出 DONE 闸）；另：**worker 分件提交+末尾统写回执的形态放大损失**——回执随件写（每件一还）可把损失从「整批回执」缩到「单件」，写入任务书模板 |
| L-1026-6 | **降级恢复腿盲 fork 同会话活进程**：resumeExternal 不查「该会话已有活进程」就 spawn claude --resume 新标签——真身若已是活恢复进程=同会话双活分身（L-1024-2 同族跨复发）；叠加 relay 重启后 pid 注册回读空窗（实测 06:50 重启→06:56 注入仍败→06:59 才回注册=9 分钟空窗），空窗内注入必败→误触发降级 | 1026 06:56 生产实锤：PM 会话 29ab705b 真身=10/15 拉起的恢复进程 15585（原 nohup 早已死，「无头 PM」为误诊）；INJDEGRADE 降级路径首战即拉出 37992 分身，用户手机测试消息差点喂给分身（面板「恢复进行中，消息已排队」×N）；PM 击毙 37992+队列已空+cli-pids 回指 15585 | PM 侧手动击毙分身+直接代答用户消息 | **spawn 前活进程探测闸**（pgrep 同会话 claude 活进程→改注入重试不 fork，任务 #257）；relay 重启 pid 注册表回读链路核查（空窗 9 分钟应缩短为即时）；面板「转录活跃（无 hook 会话）」误标同源 |
| L-1026-5 | **双线脚本漂移误诊（PM 侧）**：V2 五面闸爆红初判「bash 3.2 邻接第二案复发」派 W-BASHSWEEP 全仓清扫——worker 核对发现任务书指定的 check-deploy-complete.sh:27/29 **在脚本正典线（feat/1010-audit-fixbatch@1e264975）基点已修**，爆红运行体=船线（feat/test56-integ）scripts/ 的**旧拷贝**（四面同步时只 cp 了 deploy-web/test-deploygate 两件，漏了 checker）；真复发零起，实修仅 check-behavior-parity.sh 另三处会炸面 | 1026 01:17 W-BASHSWEEP 回执「重要核对发现」节实锤（cmp 证据：deploy-web/test-deploygate SAME、check-deploy-complete DIFF） | 船线收编同步 77e483d3（两件换新）+复跑 V2 全绿 rc=0；正典线合并 569b34fd | **多线并行时脚本类收编=全件 cp 不是挑件 cp**：deploy-web.sh 出包/部署流程应把 check-deploy-complete.sh 一并随批同步（或脚本单源从仓根硬链到船线），否则闸本身漂移=闸失真 |

附：本例零产出 DONE **未被任何机器闸捕获**（NOTIFY_CHAIN_AUDIT 当时只报三账缺角），靠用户巡检轮触发 PM 深查才发现——L-1026-1 的零产出闸与 §13（1024）「收工自检扩展」合并为同一根治件候选。

## 13. 1029 凌晨实战断点增补（PM 接任夜）

| # | 损失点 | 实证 | 处置/缓解 | 根治建议 |
|---|---|---|---|---|
| L-1029-1 | **验收单无生命周期终点=值守永久骚扰**：验收单唯一终态是回流（submitted），无过期/关闭/作废口；用户实践=实时反馈不回填单据（1021 memory 口径）→ 出单永挂 pending → 喂活候选滚成 79 项（receipt 为主，最老 test.27 跨 40+ 版），PM 死亡期间值守轮 no_pm_target 每 5-10 分钟空转告警 | 1029 00:30 清账实证：acceptances 28 张全 pending（test.27→test.70 全链无一回流）；relay/src/acceptance.ts 无 expire/archive；listAcceptances(50) 直灌 dutySnapshot.pending_receipts | 28 张死账物理归档 archived-20261029/（含 tar 备份，主目录清空候选归零）+板面 4 张 Codex/经验域陈卡删除 | 验收单加生命周期：出单附 TTL（版本跨 N 版自动过期归档+一次性通知）或「用户实时反馈裁决」回流口（PM 收口头结论后代关）；acceptance.ts 补 archived 状态与目录扫描豁免 |
| L-1029-2 | **PM 死亡无人知（接任夜发现）**：PM 真身 10-28 21:54 死亡，值守轮 no_pm_target 告警通知发出但无升级链（用户未看到/无人处置），链路裸奔 26 小时直到用户手动拉新 PM | duty-rounds 22:51→23:47 六轮 no_pm_target；chain-audit pm-wake candidates=79 target=ext-94e4540f（旧目标） | 用户手动接任（新 PM=本会话） | no_pm_target 连续 N 轮→升级手机推送（现仅面板通知）；「PM 位空悬>1h」入 patrol light 必报项 |
| L-1029-3 | **Nova 壳探活被死代理吞（连接断链根因，随修复批根治）**：reqwest 读 macOS 系统代理但不解析 ExceptionsList bypass——Clash 停跑+系统代理残留 7890 时，probe_local 127.0.0.1 探活被塞进死代理恒 null→前端 unconfigured 永不连；curl/浏览器遵守 bypass 故手测全通（排障盲区） | 10-28 23:53/10-29 00:20 两次冷启零 TCP 零 ws-upgrade；worker dev 真机五连「连接失败: error sending request」实锤；`.no_proxy()` 修复后在线 | fb3dcbd0 修复批（fix/relay-single-conn，六件含 .no_proxy() 根修+自愈永久退避），随 test.74 | 已根治在批；衍生经验：**网络类排障必须用与故障进程同栈的客户端复现**（curl 绿≠reqwest 绿）——入经验库 |

## 13. 1029 晨间断点增补（验收回流实测）

| # | 损失点 | 实证 | 处置/缓解 | 根治建议 |
|---|---|---|---|---|
| L-1029-4 | **云回流断流三重烂+静默无告警**：①relay 拉回 results 读面 401（Worker 验私有 CLOUD_TOKEN secret，relay env 未设用公开默认值，两端不匹配）②拉不回静默 skip 无告警（「网络失败下次再试」注释自认，401 与网络失败不分流）③KV 里 acceptance 域键整为 0（页面/key/results 全不在——但云页面 200 可开，页面真实来源存疑=四重疑点） | 1029 09:53 用户云链接提交实测：9 分钟无回流无通知；wrangler kv list acceptance 前缀 0 键；Bearer 默认值 curl 401；CLOUD_TOKEN/PUBLIC_TOKEN 双 secret 在场 | 用户改走 LAN 直提（家庭网在场即时闭环）；私有值本地无记录 | A 正修批（用户拍板）：①新随机 token 两端同设——Worker secret put + relay 侧 config.ts cloudToken 加文件回退（~/.cc-deck/data/cloud-token，env?? 文件?? 默认三级）②拉回失败分流告警：连续 3 次 401/失败→面板通知（401≠网络失败）③考古 KV 0 键与页面 200 的矛盾（页面真实来源+出单工具上传链是否早已断）④验收单出单后自检：KV 回读 key 存在才算云链就绪，否则只吐 LAN 链接 |

## 13. 1029 晚间断点增补（429 集体死亡·队列产品实证）

| # | 损失点 | 实证 | 处置/缓解 | 根治建议 |
|---|---|---|---|---|
| L-1029-5 | **提前开火=429 集体死亡**：PM 误读用户「19:05 刷新到点开」为可提前，16:24 五 worker 并发烧 15 分钟撞墙（429 五小时上限，重置点 19:05:28 一秒不差）全灭+零回执 | a197d2fa 等 5 会话 16:39-42 集体 SESSION_ERROR；台账 16:39-42 四 failed | 19:07 额度刷新后清席重发（编制 16 全假死还需 member-retire 15 席才通——第二堵点） | ①纪律：用户给的时间点=开火点不提前 ②队列产品（dispatch-queue-prd）额度探针的实证价值：release 前探额度余量+撞墙自动 snapshot-all——本损失即 Q3 场景原型 |
| L-1029-6 | **429 集体死亡后编制全假死堵重发**：dispatch 引擎拒收「16 会话全部无响应」，重发前须手动 member-retire 清席 | leader-dispatch HTTP 422 报错点名 4 假死会话 | 批量 retire 15 席（除 PM）后七单全通 | 引擎侧：假死会话（ERROR 态+超时）自动出编制或 dispatch 自动跳过；队列产品自动刹车场景需内置 |

| L-1029-7 | **并行会话共享 stash 栈撞车**：worktree 共享主仓 .git 的 refs/stash（stash 是 per-repo 非 per-worktree）——两会话 stash 窗口重叠时交叉互弹：A 的暂存弹进 B 工作树、B 的 147 行内容弹进 A 树顶掉 A 全部改动 | 1029 20:1x UI 批与 multica 批实测（UI 侧 fsck 认领 stash 提交恢复+20/20 复验无损；multica 内容 374 行备份 /tmp/w-uifeedback-probe/foreign-multica-content.diff，已通报两 worker 取回） | 通报+取回；经验入库（UI 批 worker 已申报 #pitfall） | 派单纪律硬条：**多会话并行期禁用 git stash**（基线对照用 worktree 内临时 commit）；根治=dispatch 任务书模板加禁令行 |

| L-1029-8 | **派单→板卡状态联动断裂**：今晚 15+ 单派发建卡全停 backlog（进行中甬道空+待认领堆积——用户面板实见）；dispatch 建卡与状态翻态（claimed/doing/done）联动在假死清席/重派循环/queued→drain 路径下脱钩 | 1029 20:4x 面板实见：9 张 backlog 卡含已收割 6 单+在跑 2 单；手工归位（6→done/2→doing/删重复 1/补 2） | 手工归位+本表 | 排查 org dispatch 建卡后的状态翻态链在哪条路径丢失（重派复用既有卡时 move 缺失嫌疑大）——follow-up 查修单 |
