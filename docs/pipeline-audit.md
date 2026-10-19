# 任务流转全链路审计（pipeline-audit）

> 2026-10-19 · W-PIPELINE2（W-PIPELINE 重派）· 零代码纯梳理
> 方法：代码走读 + 生产脚本/工具取证 + 前序审计吸收。
> 素材来源：段二三四吸收 `~/.cc-deck/artifacts/w-sched-b.md`（注入通道三层队列 + stop 丢队根因）与 `~/.cc-deck/artifacts/w-sched-c.md`（生产取证今晚 21 单零丢失 + 拉活窗机理）；段一、段五为本批补查（hooks/task 存储/出包链/更新链/通知链/验收链），证据锚均为 file:line 实读。
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
│   ├─ 有空位 → wrapDispatchPrompt → sendMessage（SDK 流）      │
│   └─ 全忙  → dispatch-queue.json FIFO（持久+boot 回灌）       │
│ 台账：dispatch-log.ndjson；回显：SESSION_LOG user_message     │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌─────────────────────── 段三 worker 执行 ──────────────────────┐
│ CLI spawn → worktree（磁盘隔离纪律）→ 写码/测试/等反馈         │
│ 状态：WORKING ⇄ 等反馈；死会话 autoRevive 拉活（30-60s 轮询）  │
│ 监控：events.ndjson + patrol 定时巡检                          │
└──────────────────────────┬───────────────────────────────────┘
                           ↓
┌─────────────────────── 段四 worker → PM ──────────────────────┐
│ 回执文件（artifacts/、/tmp/…/receipts）+ git commit            │
│ deliver 登记（data/deliverables.json + artifacts-index.json）  │
│ PM 感知：事件流 / verify-receipt-claims 机器核验 / 巡检/用户催  │
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
| worker 执行 | worktree 磁盘 + CLI 进程 + 转录 | WORKING ⇄ 等反馈；死→拉活 | events.ndjson + patrol 巡检 ✅ |
| 结果回传 | 回执文件 + deliverables.json + artifacts-index.json + git | 写回执 → PM 感知 → 收割 | verify-receipt-claims.mjs 机器核验 + 巡检 |
| 出包分发 | VERSION + git tag + Actions 产物 + KV/ECS 文件 | bump → tag → CI → 推清单 | check-bundle-sync 闸 + kv-put-verified 回读 ✅ |
| 手机更新 | latest[-test].json（KV+ECS 双镜像）+ 本地 .part | 检查 → 提示 → 下载 → 校验 → 安装 | 端上全静默容错 ⚠️（失败返回 null 不打扰） |
| 通知 | TASK_DONE 落盘事件 / USER_NOTE transient（不落盘） | 发出 → 端上展示 | decision-notify ledger（五类持久）✅ |
| 验收闭环 | data/acceptances/<id>.json + <id>.results.json | 待填 → 提交 → 回流 → 卡 done | 待填汇总随 SNAPSHOT 下发 + 回填通知 |

---

## 1. 段一：用户 → PM

### 1.1 入口三路

| 入口 | 路径 | 存储 |
|---|---|---|
| 本地 CLI 打字 | 用户在 Mac 终端直接敲 → CLI 会话转录 | `~/.claude/projects/-Users-xdd-dev-cc-deck/<sid>.jsonl`（追加写） |
| 手机/网页对话→**外部**会话（本机 PM/worker CLI 都是 hook 桥接的外部会话） | WS `COMMAND_EXT_INPUT` → bridge enqueue → `state.pending_inputs` 数组 → CLI 空闲时合并投递（`"A\rB"` 合并语义，bridge:1289） | pending_inputs（内存数组，无上限） |
| 手机/网页对话→**托管**会话 | WS `COMMAND_MESSAGE` → `s.agent.sendMessage` → SDK 消息流（session-manager:2631/2893 双向路由互斥，错道直接报错） | SDK 内部队列（黑盒） |

用户消息的必达保障（w-sched-b Q5）：托管链 `s.unacked.push({id,text,ts,hold})`（session-manager:2706/2757）——CLI 消费回显（ackId 对账）出队，流死经 resume `flushResumeBacklog` 补投（4983-4996）。**用户消息有重放账，这是 #7 必达语义**。

### 1.2 分诊：行为层 + 机器层

**行为层（无机器闸）**：CLAUDE.md「会话任务调度准则」的消息分诊四分类（新任务入单/补充更新/纯问答不入单/30 秒顺手做掉）是纯提示词约束——没有任何机器面校验「用户消息 → 任务条目」的转化率。口头说了没入单在这一层发生。

**机器层（任务存在之后生效，hooks）**：
- **UserPromptSubmit hook**（`~/.claude/hooks/task-context.mjs`）：每条用户消息注入当前可执行待办摘要（≤8 条，豁免 `[搁置]`/`[常驻]`/parked），辅助 PM 分诊不漏已有单。
- **Stop hook**（`task-stop.mjs`）：会话收工时若存在可执行待办（pending/in_progress）→ `decision: block` 拦截；60 秒内第二次停止放行（确需收工）；**远程活跃豁免**——`~/.cc-deck/data/events.ndjson` mtime 近 3 分钟内有更新即不拦截（防远程空转轮次推送 "No response requested."）；CLI 自带护栏：连续 8 次 block 强制结束。
- 任务清单读取：`task-lib.mjs` **权威存储优先**（`~/.claude/tasks/<sid>/<n>.json`，与 relay task-store.ts 同源 #206），无目录回退转录重放（TodoWrite 全量快照 + TaskCreate/TaskUpdate 增量 + tool_result 回填真实 taskId）。

### 1.3 任务入单的存储与下游同步

```
TaskCreate → ~/.claude/tasks/<cli_sid>/<n>.json   （单文件单任务：id/subject/description/
                                                    activeForm/status/blocks/blockedBy）
    ├→ hooks（task-lib）读 → 注入/拦截
    └→ relay pollTaskStore 轮询 + onTodos → setTodos 咽喉（session-manager:~1800）
         ├→ 手机「任务」tab（同源同值）
         └→ Leader 会话 mergeBoardMirror 单向看板镜像（W-TASKFLOW：只读不回写，
            会话清单侧改动不回写看板，测试件锁死）
```

### 1.4 丢失面（段一）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| A1 | **口头需求未入单**——分诊纯行为约束，无「消息必须落任务」的机器闸，PM 漏判无告警 | CLAUDE.md 准则（提示词层） | 未修（结构性，只能靠 hook 注入提醒降低概率） |
| A2 | **CLI 工具集缺 todo 工具**→转录无任务调用，两 hook 静默放行 | task-lib.mjs:9 注释自认；GLM-* 直传会裁 todo 工具（memory claude-glm-model-alias） | 已绕（GLM 走 claude-* 别名解锁全量工具），机制面无闸 |
| A3 | **转录落盘滞后**——Stop 时刻末次任务更新偶未落盘，hook 容忍轻微滞后（官方无稳定磁盘接口，转录曾是唯一渠道） | task-lib.mjs:7 | 已缓解（权威存储 readTaskStore 优先后影响收窄到无目录会话） |
| A4 | **会话死亡任务滞留**——任务店 per-session（`~/.claude/tasks/` 已积 180 个会话目录），跨会话不自动携带；Stop 60 秒二次放行=允许带任务收工；跨会话唯一通道是 memory 固化（行为纪律，忘固=丢） | task-stop.mjs:46 + 目录实查 | 部分（`[搁置]`/`[常驻]` 豁免+固化纪律是软兜底；无机器兜底） |
| A5 | **远程活跃误判放行**——events.ndjson 3 分钟内被**任何**会话触碰（哪怕与收工无关的活动）→ Stop hook 跳过拦截，带单静默收工 | task-stop.mjs:38（mtime 判据粗糙） | 未修 |
| A6 | **手机消息入队后 CLI 死亡**——外部链 pending_inputs 数组在 relay 侧保留但 CLI 进程死=同灭，靠看门狗滞留跳过/超时清扫（托管链流死后 sendMessage=注入黑洞，adapter:382 自认） | w-sched-b Q2/P5 | 未修（P5 建议 stop/进程死亡钩子清 pending+通知） |

---

## 2. 段二：PM → 派单系统（吸收 w-sched-b）

### 2.1 链路

```
org dispatch（COMMAND_ORG_ACTION / /api/org）
  ├─ 编制有空位 → dispatchWorker 认领 → wrapDispatchPrompt
  │   （session-manager:7189：tier+经验块+岗位块+规则块拼接）
  │     ├─ 新建 session：create → SDK spawn → 首回合 prompt（不排队，create 即回合）
  │     └─ 复用既有 session → s.agent.sendMessage(prompt)（:4996）
  │           → pushUserMessage → SDK 消息流【relay 层无队列，排队语义全在 SDK 黑盒】
  └─ 编制触顶全忙 → dispatch-queue.json FIFO
        （内存权威+写穿持久+boot 回灌；drainReentrant 防重入；无容量上限）
外部 CLI worker 链（bridge）：enqueue → state.pending_inputs
  （covered 去重 + CLI enqueue 回执晋升出队 #43 + 看门狗滞留跳过已进队）
```

### 2.2 丢失面（w-sched-b 问题清单，原文归档）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| B1 (P1) | **系统注入（dispatch/看门狗）不走 unacked 重放账**——流死静默丢，与用户消息双标（:7919 注释自称「直发+unacked 入账」但实现只有裸 sendMessage，注释与实现背离） | :4996/:7921 无 push | **未修，根修点**（建议：dispatch 路径补 unacked 入账，复用 #7 账面+flushResumeBacklog 补投） |
| B2 (P2) | **stop 后 SDK 队列内容命运黑盒**——COMMAND_STOP → denyAllPending+q.interrupt()，SDK 内部排队消息随流丢弃（用户实锤「stop 后排队消息全部丢失」托管侧根因） | adapter:1101 | 未修（P1 落地后可 stop 前回流 org FIFO 重派） |
| B3 (P3) | **三层队列均无容量上限/溢出策略**——org FIFO 无 cap、pending_inputs 无 cap、SDK 黑盒不可见 | 代码无 cap 常量 | 未修（建议 org FIFO cap 50 转通知） |
| B4 (P4) | **注入回显是乐观推 SDK 非 CLI 消费**——SESSION_LOG user_message 即发即记，PM 侧「已发」可能未消费；消费级证据面已存在（ackId 出队/enqueue 回执） | adapter sendMessage 立即 onLog | 未修（建议 dispatch 状态卡区分「已注入/已消费」两态） |
| B5 (P5) | **外部链 stop 后 pending_inputs 残留**（进程已死，数组不删） | bridge kill 路径不清 pending | 未修 |

### 2.3 生产实证（w-sched-c，2026-10-19 前夜 12h 窗）

**今晚 21 单零丢失零不处理**：dispatch→台账 running 0-2s（21/21 配对）；dispatch→prompt 注入**全部 0.0s**（21/21，user_message 带 task_ref 精确对时）；prompt→CLI 首响应 13-323s（中位 ~65s）。受控复现单全链 35.6s 零卡点。
**「收了不处理 SESSION_DONE」=拉活窗观感**：dispatch→prompt 即达（0.0s）→目标 worker 回合已 DONE→prompt 挂输入队列→等 autoRevive 拉活（轮询周期 30-60s 级）→CLI 新回合消费。窗长=轮询剩余相位+CLI 启动+模型首 token。
**排队丢失 0 实证但有两点风险备案**：①历史前科在案（W-INJECT 批修过账本回退 miss 窗口事件永久丢失——relay 重启窗 in-flight 帧黑洞，已修）；②窗口内 relay 未重启，该风险面未被测试。

---

## 3. 段三：worker 执行（吸收 w-sched-b/c + 补查）

### 3.1 链路与状态

- CLI 进程拉起（SDK spawn / 外部链 CLI 自启）→ worktree 磁盘隔离（纪律层：并行会话强制 worktree，防混合工作区坏包）→ 写码/测试/等反馈循环。
- 状态机：pending → WORKING ⇄ 等反馈（AskUser/权限 pending）→ DONE/STOP。活动经 SESSION_ACTIVITY 事件流上报。
- 死会话：autoRevive 拉活（轮询 30-60s 相位，W-SCHED-C 机理）；kickstart 自拉由壳负责（patrol.ts:5 注释明确分工）。

### 3.2 丢失面（段三）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| C1 | **worker 卡死无机器超时**——执行中卡住靠 Leader 行为纪律巡检（铁律 1：40 分钟无动作查事件流），无逐 worker 机器看门狗 | CLAUDE.md 铁律（行为层） | 未修（行为兜底） |
| C2 | **session 挂了等拉活**——DONE 态收到注入后挂队等 autoRevive，窗长中位 65s、长尾 323s；窗内「发了像没发」 | w-sched-c §二 | 未修（建议：dispatch 注入 DONE 态 worker 即时触发拉活，「派单即醒」） |
| C3 | **上下文吃紧**——紧急收尾协议收口+拆接续 worker 是行为纪律；机器面无水位自动收口 | CLAUDE.md 铁律 1 | 未修（行为兜底） |
| C4 | **混合工作区坏包**——多会话共享主 checkout 磁盘时构建扫进别人未提交代码（0927 事故根源）；机器闸=check-bundle-sync.sh 部署前必跑 | CLAUDE.md worktree 铁律 + 脚本 | 已修（机器闸+纪律双层） |

---

## 4. 段四：worker → PM（吸收 w-sched-b/c + 补查）

### 4.1 回传通道

- **回执文件**：约定路径回执（`~/.cc-deck/artifacts/w-*.md` 或 `/tmp/<批>/receipts/fix.md`），末行固定格式「结果：…｜改动文件：…」。
- **deliver 登记**：`~/.cc-deck/bin/deliver <路径>` → POST /api/deliver → `data/deliverables.json`（重启回放挂回）+ artifacts-index.json 账本升级（W-ART）。
- **git commit**：分支提交（`[随手办]`/规范信息），Leader squash 收编。
- **PM 感知三路**：事件流（DISPATCH_DONE transient，session-manager:5060；SESSION_DONE）/ 机器核验（`scripts/verify-receipt-claims.mjs` 回执声明核验 + check-deploy-complete.sh 部署完整性五面闸）/ 行为层巡检与用户催办。

### 4.2 丢失面（段四）

| # | 丢失点 | 证据 | 状态 |
|---|---|---|---|
| D1 | **worker 交付了 PM 不知道**——收口事件（DISPATCH_DONE）是 transient，PM 会话若正忙/离线，感知退化为巡检轮询或用户催 | session-manager:5060 | 部分（行为铁律 1 主动跟进兜底） |
| D2 | **看板卡与回执劈叉**——裸设置器（moveEntryByDispatch）可碾过业务闸，搬卡入口未全过内核时卡态与实际交付脱节 | 团队经验条目（状态机第四写口审查法） | 待核（审查方法论已立，专项修复未见立案） |
| D3 | **回执虚报**——声明「已验证」实际未做；机器核验器 verify-receipt-claims.mjs 已建（核验分级硬规则配套） | CLAUDE.md 铁律 8 + 脚本 | 已修（机器闸；真机行为仍需人核，L3/L4 项 headless 断言≠真机） |
| D4 | **relay 重启窗事件黑洞**——账本回退 miss 窗口事件永久丢失（真产品 bug） | W-INJECT 批已修 | 已修（账本回退修 miss 窗口） |

---

## 5. 段五：PM → 用户（本批补查重点）

### 5.1 出包分发链（test 包为例）

```
VERSION（唯一事实源，七落点由 version.mjs --write 派生）
  → scripts/release-test.sh 七步机械链（2026-10-11 手工顺序三次犯错后的锁死）：
    ① bump ② --write ③ build-plugin 重建 bundle ④ check-bundle-sync 守卫（不绿绝不 tag）
    ⑤ tag v<X.Y.Z>-test.N-nova ⑥ push 分支+tag ⑦ CI 构建中
  → CI：android.yml（ubuntu runner，versionName 烙 tag 后缀）/ desktop.yml（windows
    runner，NSIS + tauri updater 签名 latest.json）
  → Actions 产物（upload-artifact；snap 不建 Release 不上传清单）
  → 手工推 KV 三件：kv-put-verified.sh（put 后强制回读 md5 比对 + zip 类 unzip -t；
    api.cloudflare.com 被墙时 curl 走本地代理打 REST 等价上传）
    ⚠️ 包与清单是**两次独立手工动作**——只传包不传清单=手机不更新（无机器闸）
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

### 5.3 通知链

| 通道 | 机制 | 持久性 |
|---|---|---|
| 绿框 TASK_DONE | `/api/notify`（LAN token 鉴权，ws-server:1254）→ `notifyDone`（session-manager:1755）→ bus.emit **落盘** + last_task_done | 落盘，可回放 |
| 黄框 [待确认] | `/api/notify mode=confirm` → `notifyConfirm`：目标会话 todos 追加 pending 条目 + emitTransient USER_NOTE | todo 落盘兜底；**USER_NOTE 是 transient（seq:0 不落盘不补发）——离线端丢，靠 todo 兜底** |
| 决策通知 ledger | decision-notify.ts 五类（org-confirm/waiting/dispatch/acceptance/system），revision + sourceContext 快照 | 持久化，离线重载不丢 |
| 巡检异常 | patrol.ts → notifyDone 同通道推送（投递目标兜底链：WORKING external → external → 首个） | 同 TASK_DONE |

`/api/notify` 目标兜底链终点是 `sessions[0]`，**无任何在线会话时 503「无可投递会话」——发版广播类通知就此丢失且无重试**。

### 5.4 验收单闭环链

```
bin/acceptance <验收单.md>
  → 宽容解析四段结构 → data/acceptances/<id>.json
    （cwd=出单会话归因键 #138 + sheet_key per-sheet 密钥 #28）
  → 双链：LAN http://<en0 IP>:8787/acceptance/<id>（IP 动态探测）
        + 云 https://cc.humumu.online/view/acceptance-<id>.html#<key>
    （顺序闸：密钥先传成功才传页面/吐云链接——防「页面在云上但谁都提交不了」
     的半残单；上传失败降级 LAN only 不阻塞）
  → 用户填：LAN 直提 POST /api/acceptance，或公司网 → CF Worker → KV
  → relay 每 60s 拉回 KV 提交数组（rows 签名去重，同一套校验落盘）
    → saveResult：<id>.results.json（history 帽 50 条 #25-P4）
    → 回填通知（ws-server:58）：按 cwd 归因 matchSessionByCwd → 会话通知；
      cwd 匹配不到/会话已收摊=静默（设计如此）
    → settleAcceptanceResult（session-manager:5460）：全 ✓ 唯一触发看板卡 done；
      归因 NULL 档零写/unknown 禁操作/卡态不回转（done 是终态）
```

生命周期语义（#195 用户定）：`submitted`=提交过一次（哪怕留空行）——待填卡消失条件从「全行判完」改为「提交过」（实际填单常留未测空行，全行判完永不达成→卡永久滞留，用户实锤 12 张单仅 2 张消，已修）。

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

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| F1 | **KV 清单漏推无闸**：包与 latest-test.json 是两次独立手工推送，只传包不传清单=手机不更新——test.25→test.36 实证发生（手机 test.36 走的别的路径才更新到），1017 人工补到 test.37，机制面仍是手工 | ccdeck-1017-test37-state | 出包链尾加「清单版本==tag 版本」机器核验（公网回读比对），纳入 check-deploy-complete 闸族 |
| F2 | **阿里云镜像 latest-test.json 404**：双镜像第二源失效，KV 主域兜住；补镜像需 aliyun-run.mjs 远端执行，被生产读取权限闸拦，等用户放行 | 同上 | 用户放行后补镜像；或在 updates.ts 失明告警 |
| F3 | **LAN IP 漂移**：.105→.103，全局 CLAUDE.md 验收单双发口径里的固定 .105 已过时（bin/acceptance 动态探测 en0 单张单没问题，漂的是文档口径） | 同上 | 文档口径改「以出单工具回吐链接为准」 |
| F4 | **kv-put-verified.sh zip 回读「损坏」误报**（md5 全对仍报），脚本 bug 未立案 | 同上 | 立案修脚本 |
| F5 | **transient 通知离线不补发**：USER_NOTE（seq:0）离线端丢失，todo 兜底是弱兜底（需用户主动开会话才见） | session-manager notifyConfirm | 评估决策通知 ledger 面统一收编 |
| F6 | **发版广播单点丢失**：/api/notify 无在线端 503 即丢，无重试无队列 | ws-server handleNotify | 发版通知改走 decision ledger 或落盘事件 |
| F7 | **embedded-relay.log 排障盲区**：08:53 后零带时间戳行，inject/submit 面全无日志（W-SCHED-C 发现） | w-sched-c §五.3 | 查日志链（stdout 缓冲/级别）+补 dispatch 注入结构化日志行 |
| F8 | **装机-验收断点靠人**：出包→用户装→填单全链无机器跟踪（delivery-tracker.sh 半自动），「出包了但用户没装/装了没验收」只能等用户发话 | scripts/delivery-tracker.sh | 待拍板（验收回流已有 cwd 归因闭环，装机侧无遥测——隐私边界需用户定） |

---

## 6. 监控覆盖矩阵（现状总览）

| 面 | 机器监控 | 缺口 |
|---|---|---|
| 用户消息到达 | unacked 重放账（托管）+ ackId 对账 + events.ndjson | 系统注入无账（B1） |
| 任务清单 | hooks 双闸 + pollTaskStore + 看板镜像 + 手机 tab 同源 | 入单转化率无监控（A1） |
| 派单 | dispatch-log.ndjson 台账（12h 87 条可查） | 回显乐观态（B4）；拉活窗不可见（C2 建议「等待拉活」角标） |
| worker 执行 | events.ndjson + patrol 定时巡检（CCR_PATROL=0 应急停） | 逐 worker 卡死无机器超时（C1） |
| 结果回传 | verify-receipt-claims + delivery-tracker + artifacts-index | 看板卡断链待核（D2） |
| 出包分发 | check-bundle-sync + kv-put-verified 回读 + check-deploy-complete 五面闸 | 清单与包配对无闸（F1） |
| 手机更新 | 端上全静默容错（设计：失败不打扰） | 失败即失明，服务端不知道用户更新失败 |
| 通知 | decision ledger 五类持久 | transient 类不补发（F5）；无在线端广播丢（F6） |
| 验收 | 待填汇总随 SNAPSHOT + 60s 云回流 + cwd 归因回填 + 卡 done 联动 | 归因失败静默（设计取舍）；装机遥测无（F8） |

## 7. 建议优先级（交 Leader 拍板）

1. **B1（P1）dispatch/系统注入补 unacked 账**——一处小改，同时缓解 B2（stop 前回流重派），段二三四唯一实锤丢失根因。
2. **F1 清单-包配对闸**——出包链唯一的「修了没到用户」级缺口，实锤发生过（test.25→36）。
3. **C2 拉活事件化 + 排队可见性角标**——「派单即醒」+「已派单·等待拉活」，观感根治（w-sched-c 建议 1/2）。
4. F5/F6 通知补发与广播兜底、F7 日志缺口、F2 镜像补齐——可观测性与冗余面，随批搭车。
5. A4/A5 Stop hook 判据精化（mtime→按会话归属）、F4 脚本误报——低危随手修。
