# 手表端功能域定义与特性适配清单（#288）

> 定位原则（用户原话）：不是让手表上完全跟手机上一样。手表屏幕这么小，最多只能显示一部分，我们要定义好手表端的功能用途——**抬腕速览 + 轻操作，非全功能镜像**。
>
> 硬件/系统约束（OPPO Watch ColorOS，无 GMS、无后台运行、1.4" OLED 圆屏）：
> ① 抬腕 1~2 秒能读完的才行；② 高频操作 1-2 次点击内完成；③ 文本输入不现实（无 GMS → SpeechRecognizer 不可用，W5 语音已降级为快捷指令）；④ 无后台 → 一切提醒只能走前台活跃期 + 系统通知。

## 1. 手表功能域定义（一页）

核心场景只有三个：

| # | 场景 | 对应界面 | 不做什么 |
|---|------|----------|----------|
| S1 | **状态速览**：哪个会话在跑/在等我/出错了，走到哪一步 | W1 会话卡（左右切）、W4 总览 | 不做全量列表管理、搜索、筛选 |
| S2 | **远程处置**：等待确认/提问时抬腕点一下（允许/拒绝/选项作答），紧急时停止 | W1 Waiting/Ask 变体、W3 环形菜单、通知栏动作 | 不做长文本输入、消息编辑、权限/模式类安全切换 |
| S3 | **异步提醒**：会话完成/出错/任务完成时震动+通知，点按直达 | Notifier + 深链 W1 | 不做常驻监控、持续震动（审核红线） |

辅助面（已有，维持现状）：W2 时间线速览（流式输出、任务卡、全文展开）、W5 语音/快捷指令、Settings（单 relay 源配置）。

判定一句话标准：**"抬腕时需不需要立刻知道/立刻点"**——需要 → A/B；可以等回到手机再看 → C。

## 2. 现有功能面（代码事实，2026-09 盘点）

- **协议解析已支持但 UI 未消费**：`cron_tasks`（`Protocol.kt` 的 `CronTask`/`parseCronTasks` 已随 SNAPSHOT 与 SESSION_UPDATED 落地到 `SessionState.cronTasks`，无任何界面读取）、`TodoItem.id`（#NNN 任务号已解析，未展示）。
- **relay 已下发、手表协议未解析（字段被丢弃）**：`context_usage`/`context_limit`、`subagents`、`permission_mode`、`last_task_done`；`TASK_DONE` 事件在 `RelayRepository.onEnvelope` 无分支，静默忽略。
- **双通道同形**：直连 relay（OPPO 表主通道）与手机 GMS 网关（`expo-app/src/watch.ts` 原样转发 sessions JSON）拿到的字段一致，新特性只需补手表端解析，relay 与手机网关均无需改动。

## 3. 手机端新特性 A/B/C 分级

A = 很适合速览/轻操作，直接搬；B = 有价值但需裁剪形态；C = 不适合手表。

| 项 | 特性 | 级 | 判定与形态 |
|---|------|----|-----------|
| ① | cron 定时任务列表 | **A** | 纯只读速览："⏰ 日报 · 2h 后 / ⏸ 已暂停"。手表是"定时任务有没有排上"的最自然查看位（手机列表 buried 在详情页 tab 里）。形态：W2 时间线加 CronCard（对齐 TodosCard），最多 4 条 + 溢出行，不做任何操作（暂停/删除去手机）。 |
| ② | 转录 #NNN 任务号跳转 | **C** | 手表 W2 是压缩时间线，没有转录浏览/任务 tab 交叉导航，跳转无落点。#NNN 在手表上不展示（`TodoItem.id` 继续留着不消费，零成本）。 |
| ③ | 上下文水位条 | **A** | "这会话还能跑多久"是马拉松会话期间抬腕最想看的数之一。裁剪形态：W1 `WorkingMetaRow` 追加 `ctx 62%` 文本（或 30×3dp 微条），配色沿用两端统一分级（<60% 绿 / <85% 黄 / ≥85% 红，同 `expo-app/src/fmt.ts`）。只在 WORKING 态显示。 |
| ④ | 多服务器源切换 | **C** | 低频配置操作，新增/编辑服务器需文本输入，只能在手机做。GMS 模式手表本来就跟随手机。手表现状（Settings 单 host/token）保持；至多在设置页显示当前源名，不排期。 |
| ⑤ | 删除撤销（4s 窗口） | **C** | 4s 撤销窗口假设"快速反悔点按"，手表抬腕-看清-点击节奏远超 4s，拉长窗口又改变交互语义。手表已有自己的安全惯用法：W3 `StopConfirm` 二次确认——删除保持现状（DONE/ERROR 才可删 + 确认），不引入撤销条。 |
| ⑥ | 任务完成汇报 | **A** | 手表是异步完成提醒的最佳载体：轻震 + 通知"完成任务 · 会话名（n 项，剩 m）"，点按直达。手机端是悬浮钮+徽标形态，手表裁剪为**纯通知形态**（无悬浮钮——无后台，前台时 W1 本来就能看到 ☑ 进度）。注意 ColorOS 审核禁持续震动：单次 60ms 轻震，复用现有 Done 渠道震动模式。 |
| ⑦ | 子 Agent 状态 | **B** | "卡住了还是在并行干活"有速览价值，但逐条列表不适合小屏。裁剪形态：W1 WorkingBody 在有运行中子 Agent 时加一行聚合计 `⑂×2 并行子任务`，点击无操作；详情（desc/时长）不上面。 |
| ⑧ | 权限模式切换 | **C** | 安全敏感的三态循环切换（default/acceptEdits/plan）在小屏极易误触升级权限，且属低频操作——手机一次点按搞定，不值得冒手表误触风险。备注：`permission_mode` 已随帧下发，将来可在 W1 meta 附带只读显示当前模式（非本清单排期项）。 |
| ⑨ | 会话重命名 | **C** | 纯文本输入操作，手表无输入手段（语音识别无 GMS 不可用）。title 改名结果已随 SESSION_UPDATED 自动到达手表并显示，展示侧零缺口。 |
| ⑩ | 任务面板"近24h已完成封顶15条" | **C** | 这是防手机端"已完成长列表爆量"的口径；手表 TodosCard 本来就不列已完成项（只显示 ☑n/m 计数 + 未完成最多 4 条 + 溢出行），无对应场景，无需搬运。 |
| ⑪ | AskUserQuestion 自由输入 | **B** | 自由输入不搬（键盘不现实、ASR 无 GMS 不可用），维持"仅选项点选作答"。但有一处真实代差要补：手机端 `multi` 多选题可勾选多个再提交，手表 `AskBody` 现在点任一选项立即作答，多选被退化为单选。裁剪方案：多问题顺序推进维持；`multi=true` 的问题改为"点选勾亮 → 底部确认提交"，与手机口径一致。 |

汇总：**A = ①③⑥；B = ⑦⑪；C = ②④⑤⑧⑨⑩**。

## 4. A 类实施批次建议

relay 下发字段全部已具备，三个 A 项均**零 relay 改动**；GMS 网关（`expo-app/src/watch.ts`）原样转发也无需改。按风险分两批交付：

### 批次 A1：纯展示（① + ③，可合并一个功能批）

- ① cron 只读卡
  - `wear-app/.../ui/W2Timeline.kt`：新增 `CronCard`（对齐 `TodosCard` 结构）：`⏰/⏸ 名称 · 下次运行相对时间`，≤4 条 + "…还有 N 项"；仅 `s.cronTasks` 非空时插入。
  - `wear-app/.../ui/Components.kt`：补相对时间格式化（"2h 后 / 明早 8:00"类，基于 `nextRunAt`）。
  - 协议：**已具备**，`Protocol.kt` `parseCronTasks` + `RelayRepository` SNAPSHOT/SESSION_UPDATED 两路径均已携带。
- ③ ctx 水位
  - `wear-app/.../protocol/Protocol.kt`：`SessionState` 增 `contextUsage`/`contextLimit`；`parseSession` 解析 `context_usage`/`context_limit`。
  - `wear-app/.../data/RelayRepository.kt`：`SESSION_UPDATED` 分支合并这两个字段（relay `emitUpdated` 与 `setExternalUsage` 均已随帧下发）。
  - `wear-app/.../ui/W1Card.kt`：`WorkingMetaRow` 追加 `ctx N%`，分级配色同手机阈值（60/85）。
  - GMS 通道：手机快照已含该字段，自动生效。

### 批次 A2：TASK_DONE 通知链路（⑥，单独批——涉通知/振动需真机补验）

- `wear-app/.../protocol/Protocol.kt`：`SessionState` 增 `lastTaskDone`（done/remaining_count/ts）；`parseSession` 解析 `last_task_done`。
- `wear-app/.../data/RelayRepository.kt`：
  - `onEnvelope` 新增 `"TASK_DONE"` 分支：更新对应会话 `lastTaskDone` 并 publish；
  - SNAPSHOT 解析自然携带 `last_task_done`（relay 侧 2h TTL + 仅快照下发，断线恢复语义与手机 #254 相同）。
- `wear-app/.../MainActivity.kt`：对齐现有"状态跃变 `LaunchedEffect(sessions)`"模式，监听 `lastTaskDone.ts` 跃变；**内存去重水位**（reported = 已提醒的最新 ts）挡 replay + SNAPSHOT 双投递——手表无后台、进程生命周期短，无需像手机那样持久化 taskSeen。
- `wear-app/.../notification/Notifier.kt`：复用 `CH_DONE` 渠道（60ms 单次轻震，合规）新增文案形如 `完成任务 · ${title}` / `${done[0]} 等 N 项 · 剩 M`；通知点击沿用现有 sid 深链直达 W1。
- 真机补验点：抬腕灭屏时通知是否点亮屏幕（ColorOS 通知渠道行为）、震动强度档位。

### B 类跟进（攒批，不占 A 类节奏）

- ⑦ 子 Agent 聚合行：`Protocol.kt` 解析 `subagents` → W1 WorkingBody 一行 `⑂×N`（仅统计运行中）。
- ⑪ 多选作答：`W1Card.kt` `AskBody` 对 `multi=true` 问题改勾选+确认提交，编码复用现有 `WatchCommand.Answer`（多选用 "、" 连接，同手机）。

## 5. 维护约定

- 本文件是手表端功能取舍的判定基准：手机端新增特性时，按 §1 场景标准先分级再排期，不默认全量同步。
- 手表协议是 relay 协议的**消费子集**：新字段默认"relay 下发 → 手表选择性解析"，`Protocol.kt` 不解析即等于明确不采用，应可从本文件查到理由。
