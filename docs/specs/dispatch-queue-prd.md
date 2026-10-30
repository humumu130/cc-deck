# PRD：派发队列（Dispatch Queue）——额度窗口友好的批量编排（v0.1 草案）

> 1029 用户提议：「提前规划、输出任务书，等批量派发处理，很能解决 token 的五小时额度限制，做成一个功能」
> 实战验证：1029 午后手工跑通（14 单队列+被停 worker 中断快照+条件批），本 PRD 将其产品化。

## 1. 问题与场景

**额度窗口限制**：LLM 订阅按 5h 窗口限流。白天高峰额度珍贵（用户在用、PM 在跑），worker 池火力全开容易撞墙；夜间低谷额度闲置。

**今日手工形态**：PM 手写任务书文件 → 手工记 PROGRESS.md（中断快照）→ 手工 README（派发序/条件批）→ 用户口令触发逐单 leader-dispatch。痛点：手工记账易丢（用户两次纠正「不要丢失进度」）、无闸前验（夜间才发现任务书缺节）、无自动触发。

## 2. 目标与非目标

**目标**：
1. **队列一等公民**：任务书成为系统对象（org 域新实体），带状态机与闸前验
2. **三触发模式**：手动放行 / 定时窗口（cron 自动火力）/ 额度联动（探针恢复即派）
3. **中断保护自动化**：worker 停止时自动快照续作信息（今日 PROGRESS.md 的机器化）
4. **依赖与条件批**：任务书间依赖+外部条件（拍板/前置合入），派发引擎拓扑排序

**非目标**：不动 leader-dispatch 机械手（队列派发=调它）；不做额度计费/配额管理（只做「探针+预算粗估」）；worker 侧不改。

## 3. 对象模型与状态机

```
QueueItem {
  id, title, slug, brief（任务书全文）,
  status: draft → ready → queued → dispatched → (done|failed|held)
  gate: 入队时跑 leader-dispatch 同款三铁律闸（缺节/无行号锚即拦在 draft——夜间派发零返工）
  depends_on: [item_id]（拓扑序）
  condition: {type: user_confirm|merge_of|manual, note}（条件批——等拍板/等合入）
  priority: P0-P2（同批内排序）
  token_estimate: 粗估（选填，额度预算用——duty 域已有此字段概念）
  batch: 分组标签（如「第一批·续作」「第二批·新批」）
  snapshot?: {worktree, commits, uncommitted_files, resume_note}（中断快照——停止时自动填）
}
```

**存储**：起步=org 文件域（`~/.cc-deck/org/queue.json`，同 boards 惯例）；cutover 熟后入 SQLite queue 表。

## 4. 命令面（org CLI 新子命令族）

```
org queue write <title> --slug <s> --file <brief.md> [--batch B] [--prio P]   # 入队+过闸（闸不过=draft 留修改）
org queue list [--status S] [--batch B]                                        # 队列视图
org queue edit <id> / rm <id> / hold <id> <条件> / unhold <id>
org queue release [--batch B] [--parallel N]                                   # 放行：按拓扑序+优先级派发（调 leader-dispatch）
org queue snapshot-all                                                          # 全场停止+自动快照（额度紧急刹车）
org queue plan --cron "30 0 * * *" [--batch B]                                 # 定时放行计划（见 §5b）
```

**PM 会话免开**：队列命令任何会话/面板可操作（不依赖 PM 在线——放行动作=relay 侧执行器直接调 dispatchWorker，PM 只是任务书作者）。

## 5. 三触发模式

a. **手动**：`org queue release`（今日「夜间派发」口令的机器化）——按依赖拓扑+优先级+批次序，并行度 N（默认 4 席）。
b. **定时窗口**：relay 侧 cron（patrol 家族挂点）——如每日 00:30 自动 release 第一批；**预授权挂接**（P81 体系：定时批挂预授权确认卡，用户睡前点一次=整夜自动派发合法化）。
c. **额度联动**（Q3）：额度探针（glm usage 查询链已有）——窗口恢复阈值触发 release；带 token_estimate 预算（「余量 Y 只派前 K 单」）。

## 6. 中断保护（自动快照）

- 触发：`org queue snapshot-all`（手动刹车）或**额度探针撞墙自动触发**（Q3）
- 动作：逐在途 worker ①ccops stop ②worktree 快照（git log+status+diff --stat）③生成 resume_note 注入对应 QueueItem.snapshot ④队列状态回退 queued
- 恢复：release 时带 snapshot 的项自动续作（任务书+snapshot 拼给新 worker——今日 PROGRESS.md 精确中断点的机器生成版）

## 7. UI 面（Q3）

web-console 团队域新「队列」tab：卡片列表（状态色/batch 分组/依赖箭头）+ 一键放行 + 定时计划设置 + 快照查看。手机端同（跨端同构提醒军规）。

## 8. 分期

| 批 | 内容 | 量级 |
|---|---|---|
| Q1 最小闭环 | QueueItem 文件域+org queue write/list/release 三命令+入队闸+release 调 leader-dispatch+状态回写 | S-M |
| Q2 编排增强 | 依赖拓扑+条件批+snapshot-all 自动快照+定时窗口（预授权挂接） | M |
| Q3 智能与 UI | 额度探针联动+预算粗估+面板队列 tab+自动刹车 | M |

## 9. 开放问题

1. 队列与既有 dispatch-queue.json（编制触顶排队·下游）的关系定名（建议：上游改名 plan-queue / 下游保留 dispatch-queue，避免双 queue 混淆）——待用户拍
2. 定时自动派发无人值守的授权边界（P81 预授权的适用面扩到「批量派发」要不要单独档）——待用户拍
3. token_estimate 谁填（PM 手估/按任务书长度启发式/历史同类均值）——Q3 时定

## 10. 验收点（Q1 切片）

1. 入队过闸：缺节任务书被拦 draft 且提示精确（复用 leader-dispatch 闸文案）
2. release：按序派发+状态回写 dispatched+派单台账/板卡联动与手工派完全一致
3. 中断-恢复全链：snapshot-all 停场→快照自动生成→release 续作 worker 拿到精确中断点
4. 今日手工队列（night-queue-1029 的 14 单）可一键导入验证（`org queue import <dir>`——加一个批量导入命令）
