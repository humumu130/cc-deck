# W-DISPATCHFIX 回执：派单链状态一致性根治（1120 三现治本）

- 分支：fix/dispatchfix（worktree /private/tmp/cc-deck-w-dispatchfix，基于 dev@69ce1905）
- 提交：f0fd02e6（单笔 squash 形态，PR draft 待审；含 ①CI 三落点注册——relay.yml matrix+anchored 两处补 test:dispatchfix（T11CIFIX 同型断点预防）②slug 全链穿——workerBoardEvent 黑板行（ack/start/milestone 是收敛末行常态）也透传 slug，中途回开重复窗封死）
- PR：https://github.com/humumu130/cc-deck/pull/149（draft，gh 直连开）
- 任务书：~/.cc-deck/artifacts/brief-dispatchfix.md（七验收点）

## 根因

三现（1118 WORKING 假态一整天 / 1119 在审假挂 80min 盲区 / 1120 三笔 queued 池空窗死等+同 slug 119min 死锁）同族：**编排层把 status 声明当活证据**。

- 现一根因：dispatch 链 502 拉起失败后状态面无翻转机制，板面帧况吃 status 声明。
- 现二根因：worker 会话死（进程没了）不产生任何事件——心跳是 relay 侧定时器（与子进程健康无关），status 滞留 WORKING，板面「在审」挂到人工发现。
- 现三根因：`activeManagedCount`（全局帽）与 `groupHasLiveWorker`（编制闸）的「忙=活」判据都是 status 口径——凌晨收工死透的 worker 滞留 WORKING 照样「占位」，帽被死会话吃满 → 新单全 queued「等待空位」，实际队列零消费者死等；且 slug 歁单的 .cc-deck-lock 只在 notifyDispatchClosed 收口边清，绕过该口的收口让锁悬置到 2h 过期（119min 死等即此窗）。

## 改动清单（行号为 63914dcc 时点）

**relay/src/session-manager.ts**（主体 +433/-26）：
- 真活性单源：`realLivenessOfSid`（:11274 进程 kill-0+帧龄复合三态；between-turns=回合间隙守位 SEATALIVE 刀1 语义）+ `displayLivenessOf`（:11301 显示级——WORKING/WAITING 声明在忙的会话 pid 死不缓冲到 30min，5min 显示窗显停摆）+ `cachedFrameAge`（:11333 帧龄尾扫 5s TTL 缓存防 IO 放大）+ `realActiveManagedCount`（:11353 全局帽真相面）/`realGroupLiveWorkers`（:11371 编制闸真相面）
- 验收①：全局帽排队分支（:9992-10022）真态分叉 pool-empty/seats-busy + `queue_reason`/`active_workers` 入响应与 queued 行 receipt；enqueueCapDispatch（:11397-11433）同款（组口径）；orgAction 两处 dispatch ACK 透传（:7612/:7648 区）
- 验收②：`maybeSpawnHeadlessConsumer`（:11406）——池空窗自动拉起 claude -p 消费队首：spawn 成功才出队（失败单原地留队零丢失）、running 行 headless:true+event dispatch-headless、板卡 claimed、stdin 注入任务书（argv 限规避）、exit rc=0→done/非零→failed+2min 退避（`closeHeadlessDispatch` :11491 收口翻板卡+notifyDispatchClosed 复用全链）、拉起失败 `escalateHeadlessFailure`（:11530 upsertNotification attention+notifyLeaderSystem=/api/notify 语义等价单口）、并发闸=真活+在途 headless ≥ CCR_WORKER_CONCURRENCY_CAP 不拉（W-RATELIMIT429 帽+#89 活性闸语义——池空判定即活性闸）、单飞+`CCR_NO_HEADLESS_SPAWN` 隔离缝+`CCR_HEADLESS_CLAUDE` 测试覆盖位（带存在性预检）；sweep 周期拍兜底（:11829 排水后队列仍非空+真活 0 → 重触发，覆盖「已排队后池才死透」与重启回灌形态）
- 验收③：snapshot() 带 liveness（:1113）、heartbeat() 每拍捎带（:12868）、org status open 并入 queued 行+worker_liveness+workers_real_active/workers_status_active（:7806）、project-detail pool[].liveness+receipts[].worker_liveness（claimed×dead=失联）（:9085/:9110）
- 验收④：`slugDupGate`（:9953）——两调用点（全局帽分支入队前 :10000 + 主流程 trigger_key 闸后 :10156），dispatched/queued/running 行落 slug（:10527/:10546/:10706），命中响亮拒收（failed 记因行+duplicate_of+dispatch-slug-dup 审计）
- 验收⑤：`gcTerminalWorktreeLocks`（:11552）sweep 周期挂（:11835）——终态单锁自动清+脏树守卫（worktreeDirty 同款留守）；`evictQueuedDispatch`/drain 终态弃单 → `clearEvictedSlugLocks`（:11348）哨兵锁随撤

**relay/src/org.ts**：DispatchEntry 增 `slug?`/`headless?`（:670 区）+`findInFlightBySlug`（:847 收敛视图在途查重）
**relay/src/org-schema.ts**：dispatch 表 schema 增 slug/headless 两字段（写严格闸配套）+DISPATCH_EVENTS 增 dispatch-headless（:51）
**relay/src/dispatch-lock.ts**：`clearSlugWorktreeLock`（:186 slug 定位清锁——只清 slug 匹配且归属本单/无 id 哨兵的锁）
**relay/src/types.ts**：SessionState.`liveness?`（:274 区）+SessionHeartbeatPayload.liveness（:437）+CHAIN_AUDIT_ACTIONS 四枚新词（:1644 区）
**relay/src/ws-server.ts**：/api/state 增 workers_real_active（:1313——leader-dispatch 派单前预判数据源；本文件只动此 dispatch 区，与批D device-admin 区无重叠 hunk）
**cc-plugins/plugins/cc-deck/bin/leader-dispatch**：响应解析增 queue_reason/active_workers（:463 区）；queued 分支三分叉文案（池空窗⚠️自动拉起告知/席位忙/旧 relay 降级）+RESULT 行带 queue_reason（:529 区）
**relay/scripts/test-dispatchfix.ts**（新，48 断言）+ **spike-dispatchfix-smoke.ts**（新，真 claude -p 冒烟）+ test-ratelimit429.ts（B 组 fixture 补真活性帧证据 :126——半注入会话无帧会被真判死触发 headless，帽排队断言面失真）
**relay/package.json**：注册 test:dispatchfix

## 自测证据

- tsc --noEmit：0 错
- test:dispatchfix **48/48 全绿**（S1 语义分叉 seats-busy/pool-empty+active_workers 断言；S2 slug 去重 claimed/queued/帽分支三面+零重复记账；S3 mock bin 拉起全链 queued→running(headless)→done+板卡翻态+日志落盘+失败不丢单；S4 锁 GC 终态清/脏树留守/在途不动/哨兵随驱逐；S5 sweep 兜底；S6 快照/心跳帧 alive→dead(5min)→复活自愈；S7 org 面失联态）
- **真 claude -p 冒烟 PASS**（spike-dispatchfix-smoke.ts 实跑）：池空窗排队→headless 拉起 pid=92319→真 CLI 消费→rc=0 done 收口→日志 83 字节含模型输出→进程自退即停
- 回归零连坐：dispatch 315/0、drainfix 36/0、ratelimit429 33/0、org 42/0、leader-dispatch 80/0、boardv2 60/0、boardtruth7 5/0
- 预存基线红（非本批，已实证）：cardlifer2 43/44（memory 备案的 R4⑪ 基线）、boardreconr3 22/1（B5 期望的提示文案已被 W-CARDTERM 7c460771 移除，src 全文无此串）、import-dispatch-lesson 崩溃（干净树同款复现）
- 环境清场：测试拉起的 claude -p 全部击毙确认零残留（含 ratelimit429 首跑意外拉起的两枚+冒烟崩溃跑孤儿一枚）

## 验收点对照（任务书七条）

1. ✅ queued 响应区分池空窗（active_workers=0）vs 席位忙（>0）；leader-dispatch 输出同口径透传（旧 relay 无键降级，向后兼容）
2. ✅ 池空窗自动 headless 拉起（claude -p 形态+日志落盘 data/headless-workers/+失败升级 PM 通知）；并发闸守全局帽（CCR_WORKER_CONCURRENCY_CAP+#89 活性闸语义）
3. ✅ 板面活性真态：SNAPSHOT/心跳帧 liveness（进程存在性+帧龄=jsonl 活动代理，5min 显示窗）+org status/detail 失联态——**端上渲染（灯色/成员列消费 liveness 字段）留批E web-console 面挂接**（数据面本批到位，字段名与语义已定版）
4. ✅ 同 slug 已 queued/claimed 再 dispatch → 响亮拒收+duplicate_of（板面零重复记账）
5. ✅ 锁 GC：终态 failed/done → sweep 周期（≤5min）自动清（脏树守卫留守）；超时 → 既有 2h 过期；119min 死等形态退役
6. ✅ 测试三件：tsx 直测 48/0+真 claude -p 冒烟 PASS+org 族回归零红（预存基线除外）
7. ✅ 本回执+draft PR+审查占位（下方）

## 审查占位（常规 2 路，待 PM 派）

- [ ] 审查A（正确性面）：占位——建议重点：真活性判定的误杀面（pid 回收窗口/外部 CLI 回合间隙 vs WORKING 假态的边界）、headless 退出收口的板卡翻态与 converge 链交互、slug 闸与幂等续派（同 slug 重派正当形态是否被误拦——闸只拦在途三态，终态后可重派 ✓）
- [ ] 审查B（攻防/反方面）：占位——建议重点：headless 拉起的滥用面（坏单连环拉起的退避是否足够、prompt 注入 stdin 的转义零问题、--dangerously-skip-permissions 权限口径与 #232 派单=授权的对齐）、锁 GC 与 TREEGC 守卫的死角、queued 行并入 org status open 对既有消费方的兼容

## 遗留

- **端上渲染挂接**（批E）：web-console 成员灯/板面消费 `liveness` 字段（心跳帧+SNAPSHOT 双源；dead=停摆色）——建议消费点 team-domain.js:107 区成员灯判据并入 isRealWorking 同层
- **部署提醒**：relay 源改动需重建 bundle 才进生产（内嵌 relay）；leader-dispatch 脚本仓内源已改，线上 ~/.cc-deck/bin 同步随批（两面前后序无约束——脚本向后兼容）
- headless 消费者为 claude 引擎单专用（非 claude 引擎池空窗→升级 PM 人工分诊，不静默）；headless 会话不经 relay SDK 编制（transcript 由外部会话扫描自然可见）
- maybeSpawnHeadlessConsumer 每 enqueue/sweep 至多拉一个消费者（单飞），多单积压按消费节奏接续（下一拍 sweep ≤5min）
- 环境备忘：worktree 内 node_modules 为主仓 symlink（relay/根/cloud-bridge 三枚），合并后无残留（.gitignore 覆盖）

结果：七验收点全落地（queued 真态分叉+池空窗 headless 拉起+活性穿透+slug 去重+锁 GC），48 断言+真 claude -p 冒烟+回归零连坐，draft PR 已开待两路审查｜改动文件：relay/src/session-manager.ts, relay/src/org.ts, relay/src/org-schema.ts, relay/src/dispatch-lock.ts, relay/src/types.ts, relay/src/ws-server.ts, cc-plugins/plugins/cc-deck/bin/leader-dispatch, relay/package.json, relay/scripts/test-dispatchfix.ts（新）, relay/scripts/spike-dispatchfix-smoke.ts（新）, relay/scripts/test-ratelimit429.ts
