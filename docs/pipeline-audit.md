# 任务流转全链路审计（pipeline-audit）· v2 逐跳明细版

> 2026-10-19 · W-PIPELINE2 初版 + Leader v2 扩写（逐跳触发三要素）· 零代码纯梳理
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
| 1.6 | 任务下游同步 | relay（session-manager） | ①relay boot（:865）②会话事件边（:2931）③**30s 定时节拍**（与 pollCronTasks 同 interval，:6801） | **轮询+事件边**混合；readTaskStore（task-store.ts 权威）→ setTodos 咽喉（:~1800） | relay 内存 todos → SNAPSHOT 下发 → 手机 tab + Leader 会话 mergeBoardMirror 单向镜像（只读不回写，W-TASKFLOW 锁死） | 端上任务卡状态 |
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
| 2.1 | 派单发起 | PM 会话 | PM 决定派单的回合内 | (a) **HTTP**：`POST /api/org?token=…` body={action:"dispatch",…}（ws-server:715——动作白名单→P81 授权位求值→orgAction）(b) **WS**：`COMMAND_ORG_ACTION` 帧。两路汇入同一咽喉 `orgAction("dispatch")`（session-manager:5622） | 审计行 auditOrgCommand | dispatch-log.ndjson 台账（dispatch_id↔session_id） |
| 2.2 | 同步 ACK | relay → 派单发起方 | orgAction 校验/认领完成后**立即**（实测 0.98s 含权限链） | **同步返回** `{ok, dispatch_id, session_id, queued?}`——`queued:true`=编制触顶进队（端上据此显示排队态，零猜测） | ACK 即台账写 | 派单回执 |
| 2.3 | 调度决策 | relay（dispatchWorker） | ACK 前同步完成 | **同步调用**：形状校验（anchor 绝对路径/prompt 必填/tier 三档）→ 可选编排链（task 存在→先写卡 board upsert→computeReady 依赖/gate 检查→blocked 零 spawn）→ 认领：有空位按技能/角色匹配空闲或 DONE 熟手；全忙→dispatch-queue.json FIFO | 卡：org board entries；队：dispatch-queue.json（内存权威+写穿持久+boot 回灌+drainReentrant 防重入；**无容量上限**=B3） | 看板卡状态（backlog/claimed/doing） |
| 2.4 | prompt 拼装 | relay（wrapDispatchPrompt :7189） | 认领成功边同步 | **同步调用**：任务正文外包四层——tier 纪律块+该角色经验块（经验库 top）+岗位模板块+规则块（预算 600、created_at 序）；头部打 `[task_ref:…]` 对账锚 | 内存字符串（随注入传递） | 注入的 user_message 可见 |
| 2.5a | 注入·新建 | relay agent-adapter → SDK spawn | 认领即触发（无既有 worker 可复用时） | **同步**：create → SDK spawn 新 CLI 进程 → 首回合即任务（create 即回合，不经队列） | CLI 进程+转录 | SESSION_CREATED → WORKING 帧 |
| 2.5b | 注入·直注（W-SCHEDFIX2 新落） | relay → 既有 CLI 的活流 | 认领 DONE 熟手且流健康（agentStreamAlive：流在+未 ended+未弃管+宿主 pid 活） | **同步** `sendMessage` 直注入账（hold:"turn"）——**不杀 CLI 不重载 transcript**；状态推 WORKING/清 done_reason；时间线落「派单直注」系统行 | unacked 账+CLI 回合队列 | 时间线「派单直注」行+user_message；窗长=模型首 token |
| 2.5c | 注入·换流 | relay（resumeAgent） | 认领 DONE 熟手但流死/ended/gaveUp/ERROR（**R3 不变式：僵尸熟手必换流承接原班**） | **同步**：杀旧流 → SDK spawn resume → transcript 重载 → 首条 prompt 带账注入（hold:"turn"，流死可重放） | 新 CLI 进程+原转录 | WORKING 帧；窗长=CLI 重启+重载+首 token（实测中位 65s、长尾 323s） |
| 2.6 | 账面对账 | relay+CLI | 注入即 push → CLI 消费回显即出队 | **事件对账**：注入即 `unacked.push({id,text,ts,hold})` → CLI 回显 user_message 带 ackId → 对账出队（=消费证据）→ 回合中断 flushResumeBacklog 带账补投 → 补投文再入账（W-SCHEDFIX2 补全）→ 回合收口出清 | s.unacked 内存账（resume 链可重放） | ackId 出队日志 |
| 2.7 | 外部 CLI 链 | relay bridge | PM 派给**外部** CLI worker 时 | **enqueue**：挂 pending_inputs → CLI 空闲合并投递（covered 去重+CLI enqueue 回执晋升出队 #43+看门狗滞留跳过已进队） | state.pending_inputs（无上限） | pending 气泡；enqueue 回执 |

### 2.2 丢失面（w-sched-b 问题清单，状态更新至 2026-10-19 晚）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| B1 (P1) | **系统注入不走 unacked 重放账**——流死静默丢 | 原 :4996/:7921 锚（实施期发现一处已被此前批次吸收、一处描述不准，真缺口=水位告警 ackId 不透传+补投文不再入账） | **已修 2026-10-19（W-SCHEDFIX2）**：水位告警 msgId 透传 ackId+push 先于 send；flushResumeBacklog 补投文再入账 hold:"turn" |
| B2 (P2) | **stop 后 SDK 队列内容命运黑盒**——COMMAND_STOP → denyAllPending+q.interrupt()，SDK 内部排队消息随流丢弃（用户实锤「stop 后排队消息全部丢失」托管侧根因） | adapter:1101 | 未修（现在系统注入有账，stop 丢的账可经 resume 补投缓解；SDK 队列本体仍黑盒） |
| B3 (P3) | **三层队列均无容量上限/溢出策略**——org FIFO 无 cap、pending_inputs 无 cap、SDK 黑盒不可见 | 代码无 cap 常量 | 未修（建议 org FIFO cap 50 转通知） |
| B4 (P4) | **注入回显是乐观推 SDK 非 CLI 消费**——SESSION_LOG user_message 即发即记，面板「已发」可能未消费；消费级证据面已存在（ackId 出队/enqueue 回执） | adapter sendMessage 立即 onLog | 未修（建议 dispatch 状态卡区分「已注入/已消费」两态） |
| B5 (P5) | **外部链 stop 后 pending_inputs 残留**（进程已死，数组不删） | bridge kill 路径不清 pending | 未修 |

### 2.3 生产实证（w-sched-c，2026-10-19 前夜 12h 窗）

**21 单零丢失零不处理**：dispatch→台账 running 0-2s（21/21 配对）；dispatch→prompt 注入**全部 0.0s**（21/21，user_message 带 task_ref 精确对时）；prompt→CLI 首响应 13-323s（中位 ~65s）。受控复现单全链 35.6s 零卡点。
**「收了不处理 SESSION_DONE」=换流窗观感**：dispatch→prompt 即达（0.0s）→目标 worker 回合已 DONE→换流/等待消费→CLI 新回合处理。~~等 autoRevive 拉活轮询 30-60s~~ **（W-SCHEDFIX2 证伪：全仓不存在 30-60s 拉活轮询——dispatch→DONE 熟手同步走 resumeAgent；65s 中位窗实为 CLI 重启+transcript 重载+模型首 token；直注落地后健康熟手只剩首 token）**。
**排队丢失 0 实证但有两点风险备案**：①历史前科在案（W-INJECT 批修过账本回退 miss 窗口事件永久丢失——relay 重启窗 in-flight 帧黑洞，已修）；②窗口内 relay 未重启，该风险面未被测试。

---

## 3. 段三：worker 执行（吸收 w-sched-b/c + W-SCHEDFIX2 修正）

### 3.0 跳明细（触发三要素）

| # | 跳 | 触发节点 | 触发时间 | 触发机制 | 数据落点 | 观测面 |
|---|---|---|---|---|---|---|
| 3.1 | CLI 进程拉起 | relay agent-adapter（托管）/ 用户或 PM 手动（外部） | dispatch 认领成功边（2.5a/c）或手动建会话 | **SDK spawn 子进程**（托管）；外部链=用户自启 CLI+hook 桥接 | CLI 进程+转录 JSONL | SESSION_CREATED 帧 |
| 3.2 | worktree 磁盘隔离 | worker 会话自身 | 动工前（纪律层） | `git worktree add`（**纪律强制**，非机器闸；混合工作区坏包=0927 事故根源） | /private/tmp/cc-deck-w-* 独立目录 | git worktree list |
| 3.3 | 执行循环 | CLI 进程 | spawn 后持续 | **SDK 回合循环**（prompt→模型→工具→…→回合终态） | 转录+工作区文件 | SESSION_ACTIVITY/SESSION_UPDATED 事件流（events.ndjson） |
| 3.4 | 等反馈 | CLI+relay | 遇 AskUserQuestion/权限请求 | **SDK 控制流 pending**（denyAllPending/interrupt 管理面） | 权限 pending 队列 | 确认卡（端上） |
| 3.5 | 回合收口 | relay（onTurnEnd 真入口） | 模型回合结束 | **事件**：状态推 DONE/清 done_reason；DISPATCH_DONE transient（:5060）→ PM 感知 | SNAPSHOT 状态 | SESSION_DONE 帧；PM 侧值守喂活计数+1 |
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
| 4.4b | PM 感知·值守喂活 | relay leader-duty.ts → 注入 PM CLI | **事件触发**：worker_done_pending 计数（worker 回合 DONE 且未被 Leader 处理）在 PM turn_end / worker_done 边沿生成 feed 候选 → 注入「[值守喂活]」prompt（含队列最老项+处置指令+DUTY_RECEIPT 回执协议） | duty 队列（内存+计数持久） | PM 会话内 [值守喂活] 消息（今晚实测形态） |
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
| 5.2 | 出包发起 | PM | 本地测试通过后 | **人工**跑 scripts/release-test.sh 七步机械链（①bump ②--write ③build-plugin 重建 bundle ④check-bundle-sync 守卫不绿绝不 tag ⑤tag v<X.Y.Z>-test.N-nova ⑥push ⑦等 CI） | git tag+分支 | 闸输出 |
| 5.3 | CI 构建 | GitHub Actions runner（android=ubuntu / desktop=windows） | tag push 到远端（**webhook 事件**） | push 触发 android.yml/desktop.yml；产物 upload-artifact（snap 不建 Release 不传清单） | Actions artifacts | gh run list |
| 5.4 | KV 三件推送 | PM 手工 | CI 绿后 | **手工** scripts/kv-put-verified.sh（put 后强制回读 md5 比对+zip 类 unzip -t；api.cloudflare.com 被墙时 curl 走本地代理打 REST 等价上传）。⚠️**包与清单是两次独立手工动作——只传包不传清单=手机不更新（F1 无机器闸）** | KV：cc-deck-<ver>.apk / -setup.exe / latest-test.json | https://cc.humumu.online/dl/* |
| 5.5 | 部署位同步 | PM | 收割后 | cp relay.mjs+web-console → cc-plugins 部署位+desktop-tauri resources+App Resources/relay-service；check-deploy-complete.sh 五面闸；relay 换 bundle=kill sidecar（App 监督线程存续意愿自动重拉） | /Applications/CC Deck Nova.app/Contents/Resources/* | 五面闸输出 |
| 5.6 | 手机更新检查 | expo app（updates.ts） | **24h 静默 timer + 关于页手动** | **定时+用户触发**：GET 双镜像清单（KV 主域 https://cc.humumu.online/dl/latest[-test].json + ECS http://8.133.211.170:8888/…；通道隔离 test 读专属清单）→ isNewer semver（同号正式>预发布；dev 通道豁免）→ 下载（.part 断点续传，Range 206 才续；AppState active 自动续+指数退避+4 次失败换源）→ size===total+10MB 下限+KV 通道 md5 → 系统安装器（APK 签名兜底）。**全链静默容错失败返回 null（失败即失明，服务端不知道）** | 本地 .part/安装包 | 关于页版本号/更新弹窗 |
| 5.7a | 通知·绿框 TASK_DONE | relay（notifyDone :1755） | /api/notify POST 或任务收口 | **HTTP/事件**→bus.emit **落盘**+last_task_done | events.ndjson 落盘帧 | 端上绿框通知（可回放） |
| 5.7b | 通知·黄框 [待确认] | relay（notifyConfirm） | /api/notify mode=confirm | **HTTP**：目标会话 todos 追加 pending 条目（**落盘兜底**）+ emitTransient USER_NOTE（**seq:0 不落盘不补发**——离线端丢，靠 todo 兜底=弱兜底） | todos 落盘+transient | 端上黄框；会话待确认条目 |
| 5.7c | 通知·决策 ledger | decision-notify.ts | 五类事件（org-confirm/waiting/dispatch/acceptance/system） | **事件**+revision 快照持久 | decision ledger | 离线重载不丢 ✅ |
| 5.8 | 验收单出单 | bin/acceptance（Python） | PM 批次交付时人工跑 | **脚本**：宽容解析四段结构 → data/acceptances/<id>.json（cwd=出单会话归因键 #138+per-sheet key #28）→ 双链：LAN http://<en0 动态 IP>:8787/acceptance/<id> + 云 https://cc.humumu.online/view/acceptance-<id>.html#<key>（顺序闸：key 先传成功才吐云链接；失败降级 LAN only） | acceptances/<id>.json+KV key/页面 | 双链消息 |
| 5.9 | 验收回流 | 用户浏览器 → LAN 直提 / CF Worker → KV → relay | 用户提交后 | relay **60s 定时轮询**拉回 KV 提交数组（rows 签名去重，同一套校验落盘） | <id>.results.json（history 帽 50 条 #25-P4） | 回填通知 |
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
| E3 | 公司网更新死路 | cc-deck.apk 硬 302 ECS 裸 IP 被屏蔽 | 7d6e659 KV 直出优先 + 清单带 url 优先 |
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
| F1 | **KV 清单漏推无闸**：包与 latest-test.json 是两次独立手工推送，只传包不传清单=手机不更新——test.25→test.36 实证发生 | ccdeck-1017-test37-state | 出包链尾加「清单版本==tag 版本」机器核验 | **W-RELFIX 在办（2026-10-19 派）** |
| F2 | **阿里云镜像 latest-test.json 404**：双镜像第二源失效，KV 主域兜住 | 同上 | 补镜像需 aliyun-run.mjs 远端执行，被生产读取权限闸拦，等用户放行 | 等用户 |
| F3 | **LAN IP 漂移**：.105→.103，文档固定口径过时（bin/acceptance 动态探测没问题） | 同上 | 文档口径改「以出单工具回吐链接为准」 | 未修 |
| F4 | **kv-put-verified.sh zip 回读「损坏」误报**（md5 全对仍报）+代理慢时校验下载超时误报（2026-10-19 test.44 实锤：上传成功校验 300s 超时） | 同上+当晚实操 | 立案修脚本（分档校验+Range 抽查兜底） | **W-RELFIX 在办** |
| F5 | **transient 通知离线不补发**：USER_NOTE（seq:0）离线端丢失，todo 兜底是弱兜底 | session-manager notifyConfirm | 评估决策通知 ledger 面统一收编 | 未修 |
| F6 | **发版广播单点丢失**：/api/notify 无在线端 503 即丢，无重试无队列 | ws-server handleNotify | 发版通知改走 decision ledger 或落盘事件 | 未修 |
| F7 | **embedded-relay.log 排障盲区**：长时段零带时间戳行，inject/submit 面全无日志 | w-sched-c §五.3 | 查日志链（stdout 缓冲/级别）+补 dispatch 注入结构化日志行 | **W-RELFIX 在办** |
| F8 | **装机-验收断点靠人**：出包→用户装→填单全链无机器跟踪，「出包了但用户没装/装了没验收」只能等用户发话 | scripts/delivery-tracker.sh | 待拍板（装机遥测——隐私边界需用户定） | 未修 |

---

## 6. 监控覆盖矩阵（现状总览）

| 面 | 机器监控 | 缺口 |
|---|---|---|
| 用户消息到达 | unacked 重放账（托管）+ ackId 对账 + events.ndjson | ~~系统注入无账（B1）~~ 已修 2026-10-19；乐观回显≠消费（B4）仍在 |
| 任务清单 | hooks 双闸 + pollTaskStore（30s 节拍+事件边）+ 看板镜像 + 手机 tab 同源 | 入单转化率无监控（A1） |
| 派单 | dispatch-log.ndjson 台账（12h 87 条可查）+ 注入三分支账面 | 回显乐观态（B4）；换流窗不可见（C2 角标未落） |
| worker 执行 | events.ndjson + patrol（light 5min/full 30min） | 逐 worker 卡死无机器超时（C1） |
| 结果回传 | verify-receipt-claims + delivery-tracker + artifacts-index + 值守喂活 worker_done 计数 | 看板卡断链待核（D2）；喂活依赖 PM CLI 存活 |
| 出包分发 | check-bundle-sync + kv-put-verified 回读 + check-deploy-complete 五面闸 | 清单与包配对无闸（F1，W-RELFIX 在办） |
| 手机更新 | 端上全静默容错（设计：失败不打扰） | 失败即失明，服务端不知道用户更新失败 |
| 通知 | decision ledger 五类持久 | transient 类不补发（F5）；无在线端广播丢（F6） |
| 验收 | 待填汇总随 SNAPSHOT + 60s 云回流 + cwd 归因回填 + 卡 done 联动 | 归因失败静默（设计取舍）；装机遥测无（F8） |

## 7. 建议优先级（交 Leader 拍板；2026-10-19 晚状态更新）

1. ~~**B1 dispatch/系统注入补 unacked 账**~~ **已修（W-SCHEDFIX2 收编上线）**——水位告警 ackId 出账+补投文再入账+DONE 熟手直注免换流。
2. **F1 清单-包配对闸**——出包链唯一的「修了没到用户」级缺口，实锤发生过（test.25→36）。**W-RELFIX 在办**。
3. **B4 dispatch 状态卡区分「已注入/已消费」+ C2 换流窗可见性角标**——把已有的 ackId/enqueue 回执证据面暴露到面板。
4. F5/F6 通知补发与广播兜底、F7 日志缺口（W-RELFIX 在办）、F2 镜像补齐——可观测性与冗余面，随批搭车。
5. A4/A5 Stop hook 判据精化（mtime→按会话归属）、F4 脚本误报（W-RELFIX 在办）、F8 装机遥测（等拍板）——低危随手修/隐私边界待定。
