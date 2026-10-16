# cc-deck 团队工作模式系统性优化设计（W-PMOPT2）

> 2026-10-17 ｜ 状态：设计稿待 Leader 审 ｜ 基线 fb53623（test.32 线）｜ 纯设计零代码

## 一、现状盘点（代码实证）

### 四机制在/缺

| 机制 | 现状 | 证据锚 | 缺口 |
|---|---|---|---|
| **值守喂活（duty/pmwake）** | ✅ 在，两级门 | `CCR_PM_DUTY` env 门（session-manager.ts:666）+plugin_config.duty 产品门；`feedPM(turn_end/worker_done)` 事件驱动喂 PM 回合；duty-rounds.ndjson 审计；leader-duty.ts 纯函数五类候选（receipt/dispatch/todo/stale_doing/worker_done） | 只「喂活」不「派单」——duty 判 actionable 后注入值守 prompt，派单动作仍在 PM 会话内人工 |
| **巡检（patrol）** | ✅ 在（launchd 30min） | `~/Library/LaunchAgents/online.humumu.ccdeck.patrol.plist`→`~/.cc-deck/bin/patrol.sh`：worker 帧新鲜度/relay/磁盘/对账，异常 /api/notify | **worker sid 硬编码九个**（换编制即失效）；不扫 dispatch 悬挂行；不扫任务队列深度 |
| **派单看门狗** | ✅ 部分 | `closeHungDispatchRows()`（重启兜底补记）+`drainDispatchQueue()`（组内空闲 FIFO 排水——enqueueCapDispatch 触顶排队自动接续） | 只管「已派出单」的悬挂/排水；**backlog 卡→自动派 worker 不存在**（用户目标①核心缺口） |
| **热部署** | ⚠️ 闸全自动/拷贝手动 | check-bundle-sync.sh（bundle 两两一致+同参重建+版本闸）+check-deploy-complete.sh（五面闸） | 三处拷贝（仓库/cc-plugins 副本/Nova Resources）每批手 cp+手 shasum（W-WEBKITFIX 实录） |

### 全链路六环节×自动化水位

```
①任务创建 → ②派单 → ③执行 → ④交付 → ⑤收割 → ⑥出包/热部署
 人工入单     PM 手派    worker 跑   回执deliver  Leader手动   手cp+闸自动
 ─────────── 自动化缺口 ──────────────────────────────────────
 ①pending卡无人认领即沉睡（等 PM 醒）      ②触顶外无自动路由
 ④dispatch-log 有行无追踪视图/无超时告警    ⑤⑥机械段（拷贝/SHA）全手动
```

## 二、能力边界（可基于现有能力做的）

- **relay 命令面**：COMMAND_ORG_ACTION 全套（project-create/dispatch 走 org CLI 等价）——auto-dispatcher 可直接调 `dispatchWorker()`（同进程内）零新协议
- **org/projects.json**：headcount（编制清单）——patrol 动态化读它即去硬编码
- **dispatch-log.ndjson**：append-only 审计账本（id 收敛末行）——lifecycle 追踪的**单一事实源**（不新建账本，SSOT 原则）
- **/api/notify**：告警通道现成（confirm 级推手机）
- **板（boards）**：backlog 卡+状态机（moveEntryByDispatch）——auto-dispatcher 的输入面

## 三、四目标设计

### ① 任务自动路由（auto-dispatcher）

**机制**：relay 内 duty tick 扩展（复用值守节拍，不新起定时器）：每轮 `evaluateLeaderActionableWork` 已扫 todo/stale_doing——**加第六类候选 `backlog_candidate`**：组板 backlog 卡 × 组内空闲 worker（headcount 减 running）×tier 白名单（正经立项才自动派，随手办/轻立项留人工）→ 产出「建议派单」注入 PM 值守 prompt（**P2 保守版**）；**P3 拍板后升级直派**（dispatchWorker 直调+审计行 auto=true+每轮上限 2 单+冷却 10min 防风暴）。

**保守原则**：角色匹配（卡前缀 [角色名] 解析已有 taskOwnerResolve 同款）>空闲判定（WORKING 数<headcount_cap）>触顶自动 enqueueCapDispatch（已在）兜底排队。

### ② 主动巡检升级（patrol v2）

- **去 sid 硬编码**：读 org/projects.json headcount 动态列 worker（换编制自愈）
- **加三扫**：dispatch-log 悬挂行（dispatched>2h 无后续行）；dispatchQueueItems 深度（>10 告警）；板 backlog 卡龄（最老>24h 提示 PM 醒）
- **产出升级**：patrol-report.md 结构化段+异常 /api/notify（已有）

### ③ 交付追踪（lifecycle）

**SSOT 口径：dispatch-log.ndjson 就是账**——不新建追踪库。加两面：
- **超时哨兵**（relay 侧，随 duty tick）：dispatched/running 行龄超阈值（可配，缺省 2h/6h）→/api/notify+PM 值守候选
- **lifecycle 视图**（web 端，P3）：团队域活动页已有回执流（W-ACTIVITY3 compact）——补「单卡生命周期行」（dispatched→running→done/failed 时间轴，同 id 收敛）——纯前端消费 dispatch-log，零 relay 改动

### ④ 热部署自动化（harvest-deploy.sh）

**边界声明**：收割决策（squash 回 dev）与发版拍板**留人工**（用户拍板纪律：dev 只收验证过的一笔）——自动化只吃**机械段**：
```
scripts/harvest-deploy.sh <commit-or-worktree>
  1. 从 worktree 取 index-005.html（参数化文件集）
  2. 拷三处：仓库 / cc-plugins 副本 / Nova Resources
  3. shasum 三处一致断言（不一致 exit 1）
  4. 跑 check-bundle-sync.sh（bundle 闸随路验）
  5. 追加 ~/.cc-deck/data/deploy-log.ndjson（ts/sha/files）
```
一条命令替代四步手操（W-WEBKITFIX 手拷实录即此脚本的需求书）。

## 四、人工边界（不可自动化内核——对齐 SSOT 审查 R1-R11）

1. **squash 回 dev 的验证判定**（真机验收 ✓ 才收）——auto-dispatcher 直派的是「派」，不是「收」
2. **发版拍板**（test→snap→release 三段节奏）
3. **验收标准预置**（每单验收点人写——工具不代写通过标准）
4. **超范围事项的扩权判定**（worker 纪律第 5 条同源）

## 五、分期计划

| 期 | 内容 | 改动面 | 风险 |
|---|---|---|---|
| **P1（快赢，~1 批）** | ④harvest-deploy.sh；②patrol 去 sid 硬编码+dispatch 悬挂扫描 | 纯脚本+patrol.sh | 零产品码——最低风险 |
| **P2（relay 小改，~1 批）** | ①第六类候选保守版（建议注入不直派）；③超时哨兵 | leader-duty.ts 纯函数+session-manager 挂点 | 纯函数有既有测试范式（test-leader-duty.ts） |
| **P3（产品面，~2 批）** | ①直派模式（拍板后开 env 门）；③lifecycle web 视图；②队列深度告警 | relay+web | 直派需用户拍板（自动动作进入主权面） |

**拍板点清单（提 Leader）**：①P3 直派开关（自动派单是否要——保守版建议注入可能已够）②超时阈值缺省值 ③patrol 报告是否推团队域可见（现仅手机 notify+本地文件）。

## 六、架构图

```
┌─ 用户/Leader ──────────────── 人工边界：验收✓/squash 决策/发版拍板 ─┐
│                                                                    │
│  ①入单(确认卡/org CLI)                                             │
│       ↓                                                            │
│  [板 backlog] ←──── ②patrol v2 扫卡龄(24h) ──┐                     │
│       ↓ ⑥auto-dispatcher(P2 建议注入/P3 直派) │                     │
│  [dispatchWorker] ←空闲×角色×tier 白名单──────┤                     │
│       ↓ 触顶→enqueueCapDispatch 排水(已在)    │                     │
│  [worker 执行] ←── ③patrol 帧新鲜度(动态编制)─┤                     │
│       ↓ turn_end/worker_done                  │                     │
│  [feedPM 值守喂活(已在)] ── 五类候选+超时哨兵(P2)┤                    │
│       ↓                                       │                     │
│  [回执 deliver → artifacts] ── ④dispatch-log(账本/SSOT)             │
│       ↓                                       ── lifecycle 视图(P3) │
│  [Leader 收割 squash] ── harvest-deploy.sh(P1 机械段)               │
│       ↓ 拷三处+SHA+bundle 闸（一条命令）                             │
│  [出包/tag/CI]                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

## 七、既有纪律的对齐

- **SSOT**：dispatch-log 单账（③零新库）；板单写面（auto-dispatcher 走 moveEntryByDispatch 单口）
- **热部署禁令**（多会话并行期）：harvest-deploy.sh 内嵌 check-bundle-sync 前置——禁令期不跑（脚本不绕纪律，只省机械步）
- **审计**：auto-dispatcher 每动作 dispatch-log 行带 `auto: true` 键（读侧收敛兼容）；patrol v2 报告 append-only
- **保守缺省**：P2/P3 全部 env/产品门缺省关（dutyEnabled 同款范式——零波及既有行为）
