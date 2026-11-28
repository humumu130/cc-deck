# v8 编排层语义设计：派完即睡＋回报唤醒

> DEV-59 · 2026-11-28 · deck-research（调研席纸面单，S2-W4）· 竞品调研 D-T2/F2 落地设计
> 输入三路：①`docs/product-review/competitor-review-2026-11-28.md` §6.A F2＋§8 T2（orca orchestration 语义——派完即睡/worker_done 恰好一次带双 ID/failed 与 succeeded 分家）；②wakeup 链现状（PR #171 DEV-43 基建 / #175 DEV-51 竞争修 / #176 DEV-54 装配解耦，均已在 dev）；③v8 团队矩阵（`docs/v8-team-matrix.html` v3.1）＋任务生命周期（`docs/design/task-lifecycle.md`——五态板＋task_ref 四处同键）＋W-DISPATCHFIX 真活性单源＋defect-ledger DL-P0-3（值守空转实锤）。
> 边界：**纯纸面**。DEV-56 换装验证期基线冻结，本文档不动任何代码；动刀等设计过审后按 §6 分期拆单。

## 0. 问题与一句话结论

**现状**：Leader/PM 的「值守」= 轮询答到。DL-P0-3 实锤：14 天 738 轮 duty，736 轮答 sleep——每轮一个完整 agent 回合，买到的只是「我还活着」的信号；而真正的风险（PM 实质死亡）反而检测到了却触达不了（告警投进只有 relay 活着才可见的面板）。同时 wakeup 基建三件已入 dev（规则表＋谓词器＋expires 兜底＋云桥直推），但外发腿只有「事实→手机」，没有「事实→会话」。

**设计核心一句话**：把「睡眠」从**会话行为**（每轮回答 sleep，烧一个回合）变成 **relay 状态**（零回合驻留）；把「唤醒」从**轮询**（定时问有没有活）变成**事实触发**（规则成立才叫）。Leader 派完即睡；worker 收工即报（双线已有）；relay 拿着期望账替双方守夜；规则过期必触达、拉不活必升级。

```
现状（轮询值守）                v8（派完即睡＋回报唤醒）
──────────────                ─────────────────────
PM: 每 N 分钟醒→看→答 sleep     PM: 派完→睡（零回合）
     ↑__________cron 循环           等回报/规则 fire → 醒 → 收割/再派 → 再睡
worker: 干活→收工                 worker: 干活→收工→报（hook+收口双线）→退休
守夜人 = PM 自己（会死）          守夜人 = relay＋patrol＋云桥（永不睡、零 token）
```

## 1. 设计原则（六条，从根因簇与竞品语义推导）

| # | 原则 | 出处/依据 |
|---|---|---|
| P1 | **睡眠是 relay 态，不是会话行为**——睡不烧回合 | DL-P0-3 的成本形态就是「答 sleep 也要一回合」 |
| P2 | **唤醒靠事实，不靠轮询**——armable 规则＋expires 兜底 | multica `--until-*`（平台替你验事实）与 orca 事件驱动的共同点；轮询降级为安全网（退避续办），不做主链 |
| P3 | **期望必须有账**——每笔在途派单 ⇒ 一条 armed 规则（含过期窗） | 「派完即睡」合法当且仅当期望全覆盖；否则睡=失联 |
| P4 | **回报恰好一次、带双 ID**——task_ref（板卡）＋dispatch_id（派单） | orca worker_done 语义；cc-deck task_ref 四处同键已是等价物（task-lifecycle.md §5b） |
| P5 | **唤醒分级**——叫会话（wake）/进列表（notify）/推手机（escalate）三档 | D-T2 触达分级的编排面子集：「什么才配打断谁」 |
| P6 | **不确定态必触达**——过期≠静默死 | DEV-43 已立的语义，全链继承：规则过期、唤醒失败、目标失联三形态都有声 |

## 2. 生命周期语义：「派完即睡」态

### 2.1 睡眠维度与深度分级

**坐标澄清**：`SessionStatus`（WORKING/WAITING/ERROR/DONE）是**回合状态**（这一 turn 怎么样）；睡眠是正交的**驻留维度**（这个会话占不占资源、等不等唤醒）。W-DISPATCHFIX 已立真活性单源（`realLivenessOfSid`：进程 kill-0＋帧龄复合三态）——睡眠维度直接消费它，不另起判据。

| 深度 | 名称 | 形态 | 成本 | 进入 | 退出 |
|---|---|---|---|---|---|
| S0 | 醒 awake | 回合在跑/等待输入（WAITING=等用户，不算睡） | 全额 | — | — |
| S1 | 打盹 drowse | 回合已结束、进程在、relay **不注入** | 零回合、占席位 | §2.2 判据 | 任一唤醒源 |
| S2 | 挂起 parked | 进程退（#49 空提示词 parked 形态），不占并发帽 | 零 | S1 无覆盖期望持续 30min（对齐席位间隙 `CCR_SEAT_TURN_GAP_MIN` 语义）；组挂起 `org_parked` 批量 | resume 按需拉起（既有底座） |
| S3 | 退休 retired | 会话归档只读，路由表留档案 | 零 | worker 收口＋熟手池收纳 | 复活边（读档重建，v8 M3） |

**与现状的关键差异**：S1 现在事实上不存在——PM 回合结束后的「驻留」靠下一轮 duty 注入维持（于是有了 738 轮 sleep 账单）。本设计给 S1 的定义就是「不注入」：relay 侧标记＋期望账覆盖，会话侧什么都不用做、什么都不用答。

### 2.2 进入条件（谁、何时、判据）

**Leader（PM/值守位）——「派完即睡」主语义**。三条全满足 → S1：

1. **候选清空**：`evaluateLeaderActionableWork` 四值 reason 非 actionable（纯函数已有，`relay/src/leader-duty.ts`）；
2. **覆盖完备**：名下在途派单每笔都有 armed 期望规则（§3 M3——期望账=armed 规则集）；
3. **无 pending_user_confirms**：等用户拍板＝真挂起，走通知面升级，不空转（duty-selfloop 既有语义保留）。

S1→S2：无覆盖期望持续 30min → retire 进程只留账（复用 resume/auto-revive 底座）。**豁免**：用户消息任何端直达＝手动唤醒，豁免冷却/退避（「用户消息越冷却拉起」既有路径保留）。

**Worker——「回执即睡」**：收口（`closeOpenDispatches`：receipt 闭＋板卡翻态＋台账一行）→ 直达 S2（真活性单源会如实显示 dead/between-turns，W-DISPATCHFIX 后并发帽不再被死会话吃满）；熟手池可选 S3。组挂起 → `org_parked` 批量 S2（既有）。

**探员（Leader 子 agent）**：用完即弃 S3（v8 §4 咨询档既有语义）。

**永不睡的三件**：relay（事实检查者，零 token）、patrol/sentinel/launchd 三件（防线，DEV-43 已通电）、云桥（触达通道）。**睡眠模型的可信前提＝守夜人不睡**——三件的独立存活已由 DEV-43 架构保证（patrol-standalone 独立进程＋哨兵 plist＋云桥直推不经 relay 路由）。

### 2.3 唤醒源矩阵

| 源 | 语义 | 目标 | 承载 | 现状/缺口 |
|---|---|---|---|---|
| W1 回报事件 | worker 收工（Stop 钩子第一方＋relay 收口权威，双线） | Leader | `feedPM` 事件腿 | **已有**（W-DELIVERCB 线一线二＋60s seen 账）——保留为快路径 |
| W2 条件事实 | 板卡 submitted/done、组内卡全终态、通知积压、（M3）PR checks/额度 | Leader 或用户 | WakeupService 规则 | 基建有（DEV-43）；**缺 wake-session 外发腿**（现只推手机）＋entry_id 精确谓词 |
| W3 定时 | cron/at/队列放行窗口/额度恢复 | Leader 或执行器 | timer 谓词 | 缺（dispatch-queue PRD 三触发待收编，M3） |
| W4 手动 | 用户任何端发消息/点按 | 任一会话 | 既有 resume/user-message | **已有**，豁免冷却 |
| W5 兜底/失败 | 规则 expires、pm_unwakeable、no-target streak、PM 帧龄超阈 | 用户（手机） | 云桥直推＋通知账 | **已有**（DEV-43 alert 通道＋dutyLostWatch 60s 拍）——只叫人不叫会话 |

矩阵里唯一的新腿是 **W2 的 wake-session 半边**；W1/W4/W5 现状已齐；W3 是 M3 收编件。

### 2.4 不变量（过审后可转测试锚）

| # | 不变量 |
|---|---|
| I1 | 覆盖完备：在途派单（open FIFO 非空）⇒ ∃ armed 规则锚定该 task_ref |
| I2 | 睡眠零回合：S1 态不接受轮询性注入；duty feed 对 S1 只在 W1/W2/W3/W4 边沿注入 |
| I3 | 唤醒幂等：同一事实的多路信号（线一线二/规则 fire＋事件）先到先投＋seen 账，不双投 |
| I4 | 过期必触达：规则转 expired 必有一声（DEV-43 已实现，升格为全链军规） |
| I5 | 自触发保护：会话自己的动作不构成对自己的唤醒（multica 语义；现 PM turn_end 喂 PM 已按候选判——升格为不变量） |
| I6 | 睡眠不阻塞手动：任何深度下用户消息直达（S2 resume / S3 复活边） |

## 3. 回报唤醒协议（睡→醒→回报→再睡的消息契约）

### 3.1 四个消息

**M1 派单（Leader→worker；既有＋一增）**：`[task_ref:t-xxx]` prompt 头（既有四处同键）＋任务书。**新增期望声明段**：回执要求（结果行/产物路径）＋超窗预告（「X 时间内未回报，系统将唤醒 Leader 处置」）——写给 worker 的心智锚，机制不依赖它（机制在 M3 规则侧）。

**M2 回报（worker→relay→Leader；既有双线定版）**：

- 线二（快）：CLI Stop 钩子 POST `/api/turn-report`——第一方信号，收工即报，比 relay 解析早一个窗（`session-manager.ts` handleTurnReport）；
- 线一（权威）：`closeOpenDispatches` 收口边——receipt 前置 `[task_ref:]`、板卡翻态、台账一行；
- **载荷定版**：`{sid, task_ref, dispatch_id, outcome: done|failed|blocked|question, 摘要行, 产物路径?}`；
- **outcome 四值分家**（orca failed/succeeded 语义的扩展）：`done`＝完成了（哪怕有 bug，发现写正文）；`failed`＝没法完成（零产出闸既有）；`blocked`＝外部依赖未就绪（gate/depends_on 映射）；`question`＝要 Leader/用户答（escalation 指名）。**blocked/question 是现缺的两值**——补上后「等外部」「要人」不再伪装成 failed；
- 幂等：60s seen 账＋先到先投（既有）；relay 收口是权威线，钩子缺席零影响（既有兜底语义）。

**M3 期望规则（relay→relay；新）**：

- **arm-on-dispatch**：`dispatchWorker` 建卡即 arm——谓词 `board_entry_status{status: submitted|done, textIncludes: task_ref}`（M1 期用现成语义零谓词扩展；M2 换 entry_id 精确键），`expiresInMs`＝预计工期×K（K 建议 3，对齐 patrol-escalate 时敏余量口径）＋`triggerAfterMs`＝最小工期（防「创建即满足」自反噪声——DEV-43 字段语义已有）；
- **cancel-on-receipt**：收口边撤销对应规则（#175 P2-1「先落盘再外发」序保证撤销与 fire 的竞争安全——fire 已落盘则不撤，走 I3 幂等去重）；
- fire → M4；
- **期望账＝armed 规则集本身**（`data/wakeup-rules.json` 已持久化＋tmp+rename 原子写——relay 重启期望不丢，这是「睡眠敢睡」的存储前提，已具备）。

**M4 唤醒（relay→Leader；新半边）**：

- 注入体＝**唤醒卡**：原因（哪条规则/哪个回报）＋dutySnapshot 候选 digest——结构化可再生（W-INJFIX 既有：注入失败不进重放账，下一边沿重推导重注入）；external PM 走 `bridge.extInput`、托管走 `resumeAgent`（既有双路径，feedPM 已分叉）；
- **分级路由**（P5）：事实成立 → wake Leader；事实成立但 Leader 拉不活（pm_unwakeable 连击）→ W5 升级用户；规则 expires → notify＋escalate 但**不过期叫醒**——过期是「等完了」不是「出事了」；「expires 后仍无人工处置」归 patrol 族接管；
- **频控**：同一目标唤醒注入 ≥60s 间隔（通知面频控既有——扩到注入面）；多事实同窗聚合为一次唤醒（digest 合并，对齐 multica「合并单条推」纪律）。

### 3.2 闭环时序走查（正常＋异常）

**正常**：派（M1＋M3 arm）→ Leader 回合结束 → 判 §2.2 三条 → S1 睡（零回合）→ worker 干活 → 收工 Stop（M2 线二）→ relay 收口（M2 线一：receipt＋板卡＋cancel 规则）→ W1 边沿 feedPM（M4 注入唤醒卡）→ Leader 醒来收割/派下一批/或再判睡 → … → 全部收口且无新期望 → S1 → 无覆盖期望 30min → S2。

**异常一（worker 挂死无回报）**：规则 `expiresIn` 到 → 兜底 fire → 唤醒卡「t-xxx 超窗未回报」→ Leader 处置（重派/stop/探员验尸——orca「不确定态必附恢复动作」语义）。
**异常二（Leader 自己拉不活）**：pm_unwakeable 连击 ≥2 → W5 手机推送（既有 no-target streak 告警族，云桥直推腿已实弹）。
**异常三（relay 重启）**：规则表落盘 → 期望不丢 → 起服后首拍重评；收口边已闭的单在重启窗内错过的回报由对账看门/板账对账兜底（既有）。

## 4. 与现有 wakeup 基建映射（DEV-43＋#175/#176 对照）

### 4.1 直接承载（零改动继承）

| 件 | 语义 | 本设计消费点 |
|---|---|---|
| 规则表 `wakeup-rules.json`＋armed/fired/expired 状态机（`relay/src/wakeup.ts`） | 期望账存储 | §3 M3——重启不丢＝敢睡前提 |
| one-shot＋`triggerAfterMs`＋`expiresAt` 兜底必触达 | 防自反噪声＋过期有声 | I4＋M3 arm 参数 |
| 先落盘再外发（#175 P2-1，评估段零 await） | 竞争安全 | cancel/fire 竞争去重 |
| `/api/wakeup` CRUD＋`CCR_WAKEUP` 唯一开关＋#176 装配解耦 | 运维面 | 应急停语义保留（M1 验收④的回滚依赖） |
| 云桥直推腿（alert 通道） | W5 escalate | 分级路由第三档 |
| `wakeup-report.md` 审计＋`checks` 计数 | 可观测 | 期望账视图数据源（「谓词活着但一直不满足」可见） |

### 4.2 需扩（五件，按分期排）

| # | 扩展 | 落点 | 量级 | 分期 |
|---|---|---|---|---|
| E1 | **wake-session 外发腿**：WakeupRule 增 wake 目标（pm/user/both），service fire 回调接 feedPM | `wakeup.ts`＋`index.ts` 装配 | S | M1 |
| E2 | 谓词族：board_entry 按 entry_id 精确键（替 textIncludes 弱锚）；children_done（组内全终态）；（M3）timer、pr_checks、usage 额度 | `wakeup.ts`＋`wakeup-api.ts` 词表闸 | S-M | M2/M3 |
| E3 | 期望联动：dispatchWorker arm 挂点＋closeOpenDispatches cancel 挂点 | `session-manager.ts` | S | M1 |
| E4 | 防风暴：唤醒注入频控、自触发保护升格、runaway 上限（multica loop 三连暂停对齐：同目标 1h 唤醒 ≤N，超限转 W5） | feedPM＋`wakeup.ts` | S | M2 |
| E5 | outcome 四值：收口解析补 blocked/question＋对应路由（blocked→挂 gate/重排；question→escalation 指名） | session-manager 收口族 | M | M2 |

### 4.3 明确不做（防过度借鉴）

- **不做 multica 服务端 board**：cc-deck 的 relay＝本地事实源；云桥只承载触达不承载事实检查（与「单机定位＋自建桥」路线一致，调研 D1/N9 口径）。
- **不做 orca 进程级 worker registry 全家桶**：真活性单源已覆盖同一需求（W-DISPATCHFIX 已落）。
- **不做 t3 式事件溯源内核**（调研 N4 已不借）：只取「事实成立才唤醒」语义。
- **PM 侧外部轮询 cron（multica wakeup 型值守）退役而非改造**：本设计落地后巡检类外部 cron 收敛为 relay 条件规则＋patrol 族——「用系统自己的唤醒替外部轮询」是本设计的完整含义。

## 5. v8 团队矩阵影响（半页）

**编制心智三变**：

1. **Leader：值守者 → 调度员**。v8 已定 Leader 逻辑常驻（固定 sid＋org cwd＋按需拉起），本语义补上其未成文的下半句——「派完后＝睡，等回报」。两本账中的派单台账新增「期望」视角（＝armed 规则视图）：Leader 读档恢复时不仅知道「派过什么」，还知道「每笔在等什么事实、几时过期」——compact/换壳后的接手指令更完整。
2. **Worker：被盯着干 → 收工即报、报完即走**。回报是 hook＋relay 收口的事（worker 零负担，「收工即交付」W-DELIVERCB 已立）；收口即 S2 退休进熟手池，并发帽真活性化（W-DISPATCHFIX 后死会话不再占帽）——矩阵对比表里的「闲置成本」痛点变成结构零。
3. **用户：等待可视化升级**。「哪些在睡、在等什么」成为一屏可读的期望账（板卡＋wakeup 规则同屏）；睡眠态进状态词汇表（挂 T4：S1/S2 的 glyph 与「等你」琥珀区分——**睡是正常态，不该染警报色**）。

**经济学**：值守 token 成本 → 0（738 轮 sleep 的账单形态结构性消失）；额度急停（1111 全员急停经验）从「删 cron＋杀进程」变成「全员 S2」——恢复＝唤醒，编制记忆不丢。

**风险两条**：①唤醒链延迟（谓词拍 30s＋注入窗）——可接受：轮询的粗粒度换来零空转，且 W1 事件腿本就实时；②期望账漂移（规则悬挂 armed 永不满足）——expires 兜底已保底有触达，`checks` 计数让「谓词活着但一直不满足」可观测。

## 6. 分期落地路径（M1-M3，每期独立可验收）

### M1「PM 不再答 sleep」——最小闭环（S，1-2 天）

范围：E1（wake 腿）＋E3（arm/cancel 联动，谓词用现有 `textIncludes: task_ref` 锚——零谓词扩展）＋duty 注入面收敛（S1 不再接受轮询性注入；PM 侧外部巡检 cron 退役改条件规则）。

验收四条（全部可独立复核）：
1. 派 N 单过夜，Leader 回合数 ≈ 回报事件数——`duty-rounds.ndjson` 无新增 sleep 轮（DL-P0-3 账单形态归零）；
2. 每笔在途派单在 `wakeup-rules.json` 有对应 armed 规则（I1 对账探针）；
3. worker 挂死演练：规则 expires 兜底触达＋唤醒卡到达 Leader（双杀演练口径同 DEV-43 实弹验收）；
4. `CCR_WAKEUP=0` 时全链退化为现状（语义开关可回滚）。

### M2「回报协议定版＋worker 睡眠」（M，3-5 天）

范围：E2（entry_id/children_done 谓词）＋E4（防风暴）＋E5（outcome 四值）＋worker 收口即 S2/熟手池＋UI 面（期望账视图＋睡眠 glyph 词汇表挂接 T4）。

验收：收工→退休→熟手池恢复全链；blocked/question 不再伪装 failed；唤醒频控锚（同目标 1h ≤N）；板卡与规则同屏对账零缺角。

### M3「定时＋外部事实＋队列收编」（M，3-7 天）

范围：timer 谓词（收编 dispatch-queue PRD 的定时窗口/额度联动两触发——队列放行＝唤醒执行器，PRD §5b/c 并入）；pr_checks 谓词（调研 F3/T3：gh 直连＋代理，CI 红/merge 冲突唤醒对应派单）；组挂起批量睡联动（org_parked × 规则冻结）。

验收：队列单按窗自动放行不经 PM 手；PR 事实变化唤醒对应 worker/Leader；挂起组恢复后期望账原样解冻。

**依赖与顺序**：M1 依赖 test.38 换装完成（wakeup 链三件＋端面 bridge_alert 处理器随包生效——DEV-56 在途）；M2 依赖 M1 过闸；M3 的 pr_checks 依赖 gh 集成面。**与 DEV-52（fire/expire 必达重试对齐 patrol，现 backlog）同域——M2 的 E4 防风暴应吸收其口径，建议合批提级。**

## 7. 开放问题（留审，不挡 M1）

1. **睡眠深度由谁裁**：建议 relay 裁（Leader 只表达「派完了」意图）——会话自报深度有谎报面（status 声明≠活证据，W-DISPATCHFIX 根因族）。
2. **external PM 与托管 PM 的唤醒延迟差**（extInput 排队跟随 vs resumeAgent 直注）——M1 验收时实测分档披露。
3. **期望账与 dispatch-queue 下游队列（编制触顶排队）的定名与关系**——dispatch-queue PRD 开放问题 #1 同源，M3 收编时一并拍。
4. **wakeup-rules.json 升 sqlite 时机**——随存储收口批（DEV-43 注释已预留口径），不因本设计提前。

---

## 附：证据索引

- wakeup 基建：`relay/src/wakeup.ts`（规则状态机/谓词器/P2-1 先落盘再外发）、`relay/src/wakeup-api.ts`（词表闸防幽灵键）、`relay/src/index.ts:848-877`（装配块，#176 解耦后 CCR_WAKEUP 唯一开关）、`relay/src/ws-server.ts:1139-1180`（/api/wakeup CRUD）；PR #171（DEV-43）/#175（DEV-51）/#176（DEV-54）。
- 回报双线：`relay/src/session-manager.ts` handleTurnReport（CLI Stop 第一方外报＋60s seen 账）、W-DELIVERCB 线一线二先到先投；`docs/design/task-lifecycle.md` §5b（task_ref 四处同键）。
- 值守喂活：`session-manager.ts` feedPM（单一入口）/`evaluateLeaderActionableWork`（四值 reason）/dutyLostWatch（PM 帧龄失联拍）/pm_unwakeable streak 告警族；`docs/night-audit/defect-ledger.md` DL-P0-3（738 轮 736 sleep 实锤）。
- 生命周期底座：`docs/design/task-lifecycle.md`（五态＋gate＋depends_on＋对账看门）、`docs/v8-team-matrix.html`（v3.1：逻辑常驻/两本账/三态项目组/M1-M3）、#49 parked 形态、org_parked 两层联动（types.ts）。
- 真活性：W-DISPATCHFIX 回执（`docs/handoff-1121/w-dispatchfix.md`——realLivenessOfSid 进程 kill-0＋帧龄三态、并发帽真活性化）。
- 竞品语义源：`docs/product-review/competitor-review-2026-11-28.md` §2.1（multica 唤醒体系/runaway 保护）、§3.1（orca 事件驱动/worker_done 恰好一次/failed-succeeded 分家）、§4.1（t3 PR Watch）、§6.A F2、§8 T2。
