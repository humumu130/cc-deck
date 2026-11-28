# session-manager 分域拆解① 施工图：派单域（dispatch/）

> DEV-46 纸面单。arch-review-2026-11-28 §五 R1 / TD-P0-1 四期切分的第一期施工设计。
> **行号锚定 dev tip `ef8d781c`（session-manager.ts 13,793 行）**；方法段界约定＝段起点到下一方法起点。
> 输入：arch-review §2.1/§R1（分域方案）＋ DEV-39 存储收口终态（PR #167，`docs/storage-cutover-w1-2026-11-28.md`：
> 写面单一真相源已成立、`transition()` 已是状态机直写单点、node:sqlite 拍板「现阶段不迁」——
> ① 期无需为驱动更换留接口变量，水合/直写面零触碰）。

## 〇、结论先行

1. **① 期只动一个既有文件**：`relay/src/session-manager.ts`（13,793 → ~10,840 行，净迁出 ~2,950 行）
   ＋新增 `relay/src/dispatch/` 目录 10 个文件。**零测试文件结构改动、零 ci.json 改动、零 index.ts/ws-server/org.ts 改动**。
2. **架构形态：宿主持态 ＋ 模块函数 ＋ 门面转发**（§二）。SessionManager 保留全部字段与全部方法签名，
   方法体改为一行转发到 dispatch/ 模块。生产调用方与测试的 `(mgr as unknown as {...})` 私有面casts全部原地续命。
3. **发现一枚 P0 前置雷**：R1 方案钦定的 behavior-parity 闸（`scripts/check-behavior-parity.sh`，164 件快照网）
   在 DEV-38 迁址后**已断路**——record/check 两模式的执行路径仍指 `relay/scripts/test-*.ts`（已不存在），
   与 DEV-36 台账「#168 迁址漏网类（test:fc 同型）」同族。不先修，① 期每一步都没有验收闸。
4. 迁移按 **Step 0–5 六步**，每步独立合入、独立回滚（revert 单笔 squash）；施工必须排在 **DEV-41/42 集成之后**
   （同文件面：relay src/tests ＋ ci.json quarantine），且 41/42 红基线翻转后 parity 基线**必须重录**（§五）。
5. 成本：施工 4–5 人日 ＋ 审查集成 1 ＋ 装机 smoke 0.5。收益即 arch-review R1 所列：churn 热点分解、
   并发病灶宿主消失一半、review 面恢复人类尺度（派单域是 60 天 214 笔提交的最高频手术面）。

---

## 一、前置件（P0，可独立成单先行，与 41/42 并行零冲突）

### P0-A parity 网断路修复

`scripts/check-behavior-parity.sh`：

- :28（record 模式）与 :49（check 模式）的执行串 `scripts/$(basename "$f")` / `scripts/${tname}.ts`
  仍指旧址 `relay/scripts/test-*.ts`；DEV-38（`0eceeba6`）只改了 :36 的 glob（`relay/tests/test-*.ts`），
  执行路径漏改。现状：record 与 check 双模式对 relay 域逐件 ENOENT，**整套 parity 网实际不可用**。
- 修法：两处 `scripts/` → `tests/`（字符串级，2 处）＋自验 `bash scripts/check-behavior-parity.sh relay`
  能逐件起跑。文件面＝根 scripts/ 一件，与 41/42（relay src/tests＋ci.json）零交叠。

### P0-B parity 基线重录（时机绑定 41/42 集成后）

现存基线 `artifacts/split-baseline/`（git 在册，164 件）录于 **2026-10-20**（`a20e7701` W-SPLIT-S0），
落后五周：11 月全部演进未入账，且 41（丙类 29 键）/42（乙类 17 键）收口会让一批 quarantine 键翻绿
（dispatch 族内现红键：`test:m1-orchestration`/`test:m12-commands`/`test:r1c-notify`/`test:board-mirror`/
`test:boardfix`/`test:m-board`/`test:xmsg-e2e`/`test:dutybackoff`/`test:m-graceful`/`test:gatefix`）。
不重录则 ① 期 parity 全是假红。**重录必须在 42 集成后的 dev tip 上做**，作为 ① 期施工分支的第一笔提交。

---

## 二、目标文件形态（dispatch/ 目录）

### 2.1 目录与模块清单

```
relay/src/dispatch/
├── host.ts          # DispatchHost 接口：dispatch 模块消费的宿主能力面（类型 only，无运行时）
├── types.ts         # DispatchInput / DispatchResult —— 从 dispatchWorker 行内 20+ 参类型提出
├── backoff.ts       # 429 退避侧账（rate-limit-backoff.json 存取＋读档），纯 fs 无环
├── receipt-check.ts # 回执核销账（pending receipt checks 的存取/调度/boot 恢复），纯 fs＋宿主读
├── continuity.ts    # 续接披露族：对不可续 veteran 的披露块/同锚差异块（C-MODE-B2 模块5/7）
├── selection.ts     # 选席序：路由表熟手→触顶复用→空闲名册→新开；审查三跳路由＋评审席守卫
├── queue.ts         # 内存队列权威操作面：满仓闸/入队/蒸发/排水/清扫/boot 回灌（状态仍在宿主）
├── headless.ts      # 池空窗消费者：claude -p 拉起/收口/收尸/孤儿清（S3 链）
├── settle.ts        # 派单收口族：closeOpenDispatches/悬账收殓/连败升级/交付回调/收口通知/回执行锚
└── worker.ts        # 派单主管道本体：preflight→去重闸→并发帽→选席→注入组装→落账→承接
```

既有平铺件 **`dispatch-queue.ts`（队列持久化格式）、`dispatch-lock.ts`、`dispatch-retry.ts`、`dispatch-run-archive.ts`
原地不动**：它们已被 org.ts:17/:578、worktree-gc.ts:18 与 8 个测试件直接 import，搬动会无收益地扩大文件面
（归位与否留给 ④ 期后的卫生批，见 §七未决②）。

### 2.2 关键架构决策：宿主持态 ＋ 模块函数 ＋ 门面转发

- **字段不搬家**：`dispatchQueueItems`（:857）、`drainReentrant`（:858）、`dispatchSweepTimer`、
  `dispatchSweepBackoff`、`drainfixDeadSuspects` 等全部留在 SessionManager 实例上。
  理由有二：(a) `test-boardtruth.ts:156` 直接 `hack.dispatchQueueItems = [...]` **赋值**、
  `test-ratelimit429.ts:186`/`test-drainfix.ts:63` 直接读字段——状态搬家即断测试；
  (b) 内存队列权威的注释契约（:855「this.dispatchQueueItems 是唯一事实源」）原样保留，零语义风险。
- **模块函数签名统一为 `fn(host: DispatchHost, ...)`**：`host.ts` 只声明 dispatch 模块需要的成员/方法
  （managed 访问、emitChainAudit、pushExternalLog、transition、create/resumeAgent、路由/org 读……）。
  SessionManager `implements DispatchHost`（结构化检票，接口漂移编译期暴露）。
  所需成员的 `private` 放宽为 public 并加 `/** @dispatch-host */` 记号——**以 tsc 报错驱动收敛清单，不预估全集**。
- **门面方法一行转发**：SessionManager 上全部被迁方法保留原签名，体改为
  `return dispatchWorkerImpl(this, input)` 式转发。由此：生产调用方（index.ts:653-682 boot 接线、
  orgCommand→dispatchWorker :8661、onTurnEnd→drain 链）与全部测试调用面**零改造**。
- **环的方向闸**：dispatch/ 模块间只允许 `worker → {selection, continuity, queue, headless, settle, backoff,
  receipt-check}`、`settle → queue`、`headless → queue`；**queue/headless 回调派单一律走
  `host.dispatchWorker(...)`**（宿主门面作环断点，:10199/:12144 两处重入点都改走 host）。
  dispatch/ 对 session-manager.ts 只有 type-only import（host.ts），运行时无环。

---

## 三、迁移映射表（现文件:行 → 新位置）

> 行号锚 `ef8d781c`；「调用方改造点」列＝除文本锚（§四 G-19）外的真实改造，全部为「零」的依据是门面转发。

| 现位置（session-manager.ts） | 内容 | 去向 | 调用方改造点 |
|---|---|---|---|
| :5469–5493 | `pushOpenDispatch`（每席在途派单账挂入） | settle.ts | 零（门面保留；唯一调用点 :10980 随 worker 迁走后改调模块函数） |
| :5587–5603 | `receiptTailLineOk`（回执尾行合规行锚） | settle.ts 导出 | 零（finishExternal :4309 侧经门面/直import 双可） |
| :5604–5632 | `receiptWithResultLine`（回执「结果：」行契约双档） | settle.ts 导出 | 零（同上，:4309 消费点门面续命） |
| :5633–5689 | `captureExperienceDeclaration`（经验声明捕获） | settle.ts | 零（门面保留） |
| :5690–5982 | `closeOpenDispatches`（收口主管：done/failed、boardTo、interrupted、receipt_missing、onlyGid） | settle.ts | 零（门面保留；宿主内 6+ 调用点 :3245/:4341/:4468/:4741/:5323/:9476 原样） |
| :6104–6185 | `closeHungDispatchRows`（断档悬账收殓） | settle.ts | 零 |
| :6186–6237 | `closeHungRowAsInterrupted`（悬账中断口径收口） | settle.ts | 零 |
| :6238–6261 | `escalateWorkerFailures`（#92 连败升级路由表） | settle.ts | 零 |
| :6262–6341 | `deliverCallbackToPM`（交付直达收件箱） | settle.ts | 零（deliver-callback.ts 平铺件不动） |
| :6342–6381 | `flushUndeliveredCallbacks`（PM 上线补扫） | settle.ts | 零（public，ws-server 消费） |
| :6382–~6473 | `notifyDispatchClosed`（收口通知面，含区间箭头辅助） | settle.ts | 零 |
| :10155–10187 | `preflightDispatchEngine`（M12-5 拉起前静态检查） | worker.ts | 零 |
| :10188–10207 | `maybeTransientRetry`（#G5 瞬态重试，链深恒 1） | worker.ts | 零（**文本锚** test-brm.ts:109 迁址） |
| :10208–10241 | `slugDupGate`（W-DISPATCHFIX S2 同 slug 去重闸） | worker.ts | 零 |
| :10242–~11105 | `dispatchWorker`（派单主管道 ~860 行；行内 20+ 参类型→ types.ts） | worker.ts | 零（public 门面；`Parameters<SessionManager["dispatchWorker"]>` 三处内部引用 :10188/:11669/:12144 随迁改 `DispatchInput`） |
| :11108–11121 | `buildContinuityDisclosure`（C-MODE-B2 模块5 续接断链披露） | continuity.ts | 零 |
| :11122–11144 | `bestUnavailableVeteran`（对不可续 veteran 选取） | continuity.ts | 零 |
| :11145–11151 | `lastDoneDispatchIdOf`（同锚上单 id） | continuity.ts | 零 |
| :11152–11176 | `tryReviveVeteran`（复拉优先于新开，模块10） | continuity.ts | 零 |
| :11177–11225 | `buildSinceLastBlock`（模块7 同锚重派差异块） | continuity.ts | 零（**文本锚面**见 test-cmode-batch2 预检） |
| :11226–11294 | `routeReviewers`（审查三跳路由：互审→团队席→全局池） | selection.ts | 零 |
| :11295–11308 | `isReviewerSeat`（评审席判定） | selection.ts | 零 |
| :11309–11317 | `reviewOnlyBlock`（评审席只读守卫文案） | selection.ts | 零 |
| :11318–11339 | `pickVeteranDetail`（熟手明细核） | selection.ts | 零 |
| :11340–11421 | `pickVeteranEligible`（熟手资格轮＋装配探测回落） | selection.ts | 零 |
| :11422–11434 | `groupHasLiveWorker` | selection.ts | 零 |
| :11435–11451 | `worktreeBusySkip`（worktree 占用跳过） | selection.ts | 零 |
| :11452–11460 | `routeLivenessSkip`（路由活度跳过） | selection.ts | 零 |
| :11461–11517 | `pickIdleRosterWorker`（空闲名册轮） | selection.ts | 零 |
| :11647–11649 | `headlessInFlight`（在飞计数） | headless.ts | 零 |
| :11650–11793 | `maybeSpawnHeadlessConsumer`（池空窗拉起 claude -p，S3） | headless.ts | 零 |
| :11794–11828 | `closeHeadlessDispatch` | headless.ts | 零 |
| :11829–11841 | `readHeadlessRc` | headless.ts | 零 |
| :11842–11880 | `closeDeadHeadlessRow` | headless.ts | 零 |
| :11881–11918 | `sweepHeadlessRows`（headless 收尸清扫） | headless.ts | 零 |
| :11919–11933 | `headlessOrphanBySlug` | headless.ts | 零 |
| :11934–11952 | `escalateHeadlessFailure` | headless.ts | 零 |
| :11953–11981 | `gcTerminalWorktreeLocks`（终态 worktree 锁 GC） | queue.ts（锁面邻接） | 零 |
| :11982–11985 | `rlBackoffPath` | backoff.ts | 零 |
| :11986–11997 | `persistRateLimitBackoff`（R1 B1-b 侧账写穿） | backoff.ts | 零 |
| :11998–12015 | `loadRateLimitBackoff` | backoff.ts | 零 |
| :12016–12023 | `backoffUntilOf` | backoff.ts | 零 |
| :12024–12027 | `dispatchQueueSize` | queue.ts | 零（public） |
| :12028–12077 | `enqueueCapDispatch`（编制帽排队＋真活性分叉 S1） | queue.ts | 零 |
| :12078–12097 | `evictQueuedDispatch`（终态单蒸发） | queue.ts | 零 |
| :12098–12114 | `clearEvictedSlugLocks` | queue.ts | 零 |
| :12115–12192 | `drainDispatchQueue`（六触发点排水＋drainReentrant 断环） | queue.ts | 零（内部 `this.dispatchWorker` :12144 改 `host.dispatchWorker`） |
| :12193–12305 | `sweepDispatchQueueOnce`（gid 键控逐组排＋无 gid 桶顺带） | queue.ts | 零（**文本锚** test-drainfix.ts:292 迁址） |
| :12306–12322 | `startDispatchSweep`（30min 清扫 timer 起） | queue.ts | 零（index.ts:679 经门面） |
| :12391–12393 | `pendingReceiptChecksPath` | receipt-check.ts | 零 |
| :12394–12400 | `loadPendingReceiptChecks` | receipt-check.ts | 零 |
| :12401–12405 | `savePendingReceiptChecks` | receipt-check.ts | 零 |
| :12406–12467 | `runReceiptCheck`（W-CARDLIFE-R3 回执尾行核验） | receipt-check.ts | 零 |
| :12468–12479 | `scheduleReceiptCheck` | receipt-check.ts | 零 |
| :12480–12496 | `recoverPendingReceiptChecks`（boot 恢复） | receipt-check.ts | 零（index.ts:682 经门面） |
| :12497–12502 | `queueDepth` | queue.ts | 零 |
| :12503–12518 | `reloadDispatchQueue`（boot 回灌对账） | queue.ts | 零（index.ts:671 经门面；**文本锚** test-ratelimit429.ts:158 迁址） |

**明确不迁（出域判定，防范围蔓延）**：

| 现位置 | 内容 | 留守理由 |
|---|---|---|
| :11518–11646 | 活性读服务簇（activeManagedCount/realLivenessOfSid/displayLivenessOf/cachedFrameAge/realActiveManagedCount/realGroupLiveWorkers） | 跨域只读投影：orgAction 组视图 :8048-8056、板投影 :9321/:9341、值守域（②期）共用——放 dispatch/ 会造 duty→dispatch 依赖。②期可提 `liveness.ts` 独立件 |
| :5541–5586 | `closeSupersededChainPRs` | PR 链收割域（W-BOARDTRUTH）；唯一调用点 :8366 在 orgCommand，非派单链；test-boardtruth.ts:126-127 文本锚钉在 session-manager |
| :5494–5540 | `workerBoardEvent`（黑板事件） | 板卡域；接线点在 agentCallbacks :3816 等 6 处 |
| :12323–12390 | `persistRestartLedger`/`loadRestartLedgerOnBoot` | W-RESTARTDESIGN 重启窗账＝resume 熔断域（③期 watchdogs/ 的账面），写穿点全在 resume/看门狗链 |
| :10127–10154 | `onExperienceGcRound` | 经验域 |

净迁出 ≈ **2,950 行 / 57 个方法**；session-manager.ts 13,793 → ~10,840 行。

---

## 四、behavior-parity 闸清单（后续施工单的验收基准；reviewer 按此护航）

> 每条＝行为锚（必须锁死的 observable 行为）＋现有测试锚。缺锚处给补测方案。
> 总闸：**Step 2 起每步 `scripts/check-behavior-parity.sh relay` 与基线 diff＝实质零**
> （FLAKY 清单外通过/失败集合不变）＋ CI 矩阵 66 键绿＋`tsc --noEmit` 绿。

| # | 行为锚 | 测试锚 / 补测方案 |
|---|---|---|
| G-1 | 派单前置链：幽灵锚拒（可读报错）/锚是文件三态区分 | test-dispatch（F-04 段 :148/:156） |
| G-2 | 已解散组派单拒（R1 P1-B，teamStateOf 单源） | test-dispatch（改档/结项拒族）＋ test-teamdissolve |
| G-3 | 板卡认领依赖 gate：依赖非全 done 拒派（#087 beads） | test-beads |
| G-4 | preflight 引擎静态检查：失败零 spawn 零台账、M12-5 字段透传、登录被拦记「重派意图」 | test-boardv2（preflightDispatchEngine 面）；**补测**：preflight 拒也落审计（P81-5）如无既有断言则在 test-dispatch 追一条 |
| G-5 | P81 求值闸＋kill-switch off 回退契约（岗位映射拒/放行两态） | test-p9-killswitch、test-p81-wiring |
| G-6 | 全局并发帽：在编真活≥帽排队、queue_replay 豁免删除、200 满仓拒、W-RATELIMIT429 全链 | test-ratelimit429 |
| G-7 | 排队语义修真（S1）：seats-busy vs pool-empty 分叉回执＋active_workers 透传 | test-dispatchfix S1 |
| G-8 | 同 slug 去重闸（S2）：queued/claimed 在途拒＋duplicate_of 幂等回执＋帽分支入队前掐死 | test-dispatchfix S2、test-dispatch（duplicate_of 断言族） |
| G-9 | 池空窗 headless（S3）：claude -p 拉起→running(headless)→done 全台账链＋板卡翻态＋日志落盘＋收尸 | test-dispatchfix S3 |
| G-10 | 瞬态重试（#G5）：TRANSIENT_FAILURES 分类、retry_of 门控链深恒 1、延迟重入同 id 收敛 | test-brm（A1，**含 :109 文本锚**） |
| G-11 | 429 退避侧账：persist/boot 恢复/backoffUntilOf 读档（R1 B1-b） | test-ratelimit429（R1-b 段） |
| G-12 | 排水：六触发点全覆盖、gid 键控逐组排＋无 gid 桶顺带、drainReentrant 断环、终态单蒸发＋slug 锁清理 | test-drainfix 全套、test-boardtruth（boardtruth-queue-evict 闸）、test-delivercb B 段 |
| G-13 | boot 回灌：reloadDispatchQueue 对账、内存权威/盘持久化互备、restart-ledger 交互不破 | test-m-graceful、test-restart-ledger、test-graceful-exit（注意：三件中 m-graceful 现为 quarantine 乙类锚漂移——42 刷新转绿后方可作闸） |
| G-14 | 收口语义：done/failed 双态、boardTo done/backlog、interrupted 中断口径（P1-c 不直达 PM）、receipt_missing 透传、all/onlyGid 边界 | test-delivercb（T7/T9 全族）、test-notify2、test-cardterm |
| G-15 | 悬账收殓：closeHungDispatchRows 断档兜底 failed＋写实回执 | test-drainfix（TA 段）、test-dispatchfix、test-m12-commands（quarantine，42 后启用） |
| G-16 | 连败升级＋交付回调：escalateWorkerFailures 路由表升档；deliverCallbackToPM 直达＋PM 离线 flushUndeliveredCallbacks 补扫 | test-notify2、test-delivercb、test-reviewseat |
| G-17 | 选席序不变：路由表熟手 resume 亲和→触顶复用（失败不降级新会话）→空闲名册→新开；装配探测 X0 回落席报错拒（不静默）；exclude_sessions 全路径同享；target_sid 定席失败响亮拒不静默换席 | test-dispatch（X0/D13 段）、test-revexcl（:25 **文本锚**）、test-prreview、test-dispvis（pickIdleRosterWorker 面） |
| G-18 | 续接披露（C-MODE-B2 模块5/7/8/10）：对不可续披露块、同锚差异块、taskRef 尾区、复拉优先 | test-cmode-batch2 |
| G-19 | **文本锚迁址闭环（本批特有闸）**：已知六处必须同 commit 迁址且断言语义不变——test-brm.ts:109、test-drainfix.ts:292、test-m-observ.ts:133（archiveDispatchPrompt 接线）、test-revexcl.ts:25、test-ratelimit429.ts:158、test-drainfix.ts:290（index.ts 锚，验证不受扰）。**预检协议**（每步搬移前强制）：`grep -rn 'src", "session-manager\|src/session-manager' relay/tests/*.ts` 列出读源件 → 对本步迁出的每个符号 `grep -rn '<符号名>' relay/tests/*.ts` → 命中 `.includes(`/正则断言即入迁址清单 | 六处锚本身＝验收物；预检输出贴施工单 |
| G-20 | 私有面casts续命：`(mgr as unknown as { dispatchQueueItems }).…` 直读直写、`(mgr as unknown as { closeOpenDispatches }).…` 直调、`mgr.sweepDispatchQueueOnce()` 直驱——字段留守＋门面保留后必须原样通过 | test-boardtruth:154-156、test-ratelimit429:186-193、test-drainfix:63/:135-227、test-delivercb:268-348 |
| G-21 | 收口板联动：D2 done/failed 板退回待办、D6 断档补记悬账收敛 | test-dispatch（D2/D6 段） |
| G-22 | PM 席位联检：dispatch 终态钩子 closeoutJointCheck 联动（1104 根治件③） | test-pmseat |
| G-23 | 台账与库的一致性不回退：dispatched/queued 行落库时序（write-dispatch 导入面）与 DEV-39 终态兼容——搬移不改任何 appendDispatch/writeDispatchToDb 调用点 | test-brm（C 段）＋ /health storage 四键在生产 smoke 中保持 db/off/db |
| G-24 | 装机 smoke：Step 5 后换装 test 通道——boot 行/队列回灌/一次真派单收口/`/health` 绿；换装纪律照 DEV-39（SIGTERM 优雅停→Nova 复活→bak 备份） | 装机回归单口径（DEV-33 同款） |

---

## 五、迁移顺序与回滚点

### 步序（每步＝独立分支提交→deck-reviewer 审查闸→leader 集成）

| 步 | 内容 | 判据（过闸） | 回滚 |
|---|---|---|---|
| 0 | P0-A parity 网路径修复；**41/42 集成后**在施工分支首笔重录基线（P0-B，`--record` 全 relay 域） | parity relay 域逐件可跑；record 产物入分支 | revert 单笔；基线可重录 |
| 1 | `dispatch/{host,types}.ts` 落地；SessionManager `implements DispatchHost`；private→public 放宽（tsc 驱动）；`Parameters<…>` 三处改 `DispatchInput`。**零方法搬移** | tsc＋矩阵 66 绿＋parity 0 diff | revert |
| 2 | 纯函数族四件：backoff / receipt-check / continuity / selection 搬移＋门面一行转发；文本锚预检（本步已知命中：test-revexcl:25 若 selection 段含 excludeSet 消费则此步迁，否则随 5） | 同上＋预检清单贴单 | revert |
| 3 | queue ＋ headless（含 gcTerminalWorktreeLocks）；drain 重入点 :12144 改 host 回调（:10199 随第 5 步 worker.ts）；锚迁址 test-drainfix:292、test-ratelimit429:158 | 同上＋G-7/8/9/11/12/13/20 全绿 | revert |
| 4 | settle 簇（closeOpenDispatches 等收口族）；锚预检（test-delivercb/notify2/cardterm 全为行为锚，casts 走 G-20） | 同上＋G-14/15/16/21/22 全绿 | revert |
| 5 | worker.ts 大件（dispatchWorker/preflight/slugDupGate/maybeTransientRetry）；锚迁址 test-brm:109、test-m-observ:133、（test-revexcl:25 若未在 2 迁）；本地 bundle 构建＋换装 smoke（G-24） | 同上＋G-1~6/10/17/18 全绿＋bundle/abi 闸绿 | revert＋换装回退（bak 复位，DEV-39 §四同款三通道） |

**顺序依据**：1 打地基（接口/类型）→ 2 无状态件零风险热身→ 3/4 被依赖方先行（worker 依赖它们）→ 5 最大件最后单独一批，审查面独占。
**回滚总判据**：任一步 CI 矩阵出**新**红、parity 实质 diff、或装机 smoke 任一断言失败 → revert 该步 squash（各步互不搭桥，revert 不连锁）。

### 与 DEV-41/42 集成基线的衔接点

1. **时序**：施工分支必须 fork 自 **42 收口后的 dev tip**。41/42 与本批同文件面（relay src/tests＋ci.json quarantine 节），并行必撞。
2. **红基线翻转**：丙 29＋乙 17 键转绿后，parity 基线重录是第 0 步硬前置（否则全是假红）；quarantine 中锚漂移类（gatefix/m-graceful/dutybackoff）42 刷新后如仍红，按新签名比对，不作为本批闸。
3. **矩阵纪律**：① 期**不新增测试键**（锚全靠既有 18 个 dispatch 族矩阵键＋parity 网）；若 reviewer 要求补测，新键走 41/42 同款 ci.json 单源注册纪律（matrix-guard 双向差集会拦漏注册）。
4. **41 的修复面感知**：丙类 8 族 29 键若触及 dispatch 族断言（如 m1-orchestration 收口联动双写断），Step 4/5 的 parity 比对以 41 修复后的绿色签名为基线，不以本图写作时的签名。

---

## 六、二三期展望（不展开）

**②期 duty/（值守喂活＋org Leader 常驻，约 4–5 人日）**：:719 喂活参数、:5116 Leader 常驻化、:6474 喂活闭环、
:7001 W-DUTYWIRE 唤醒链、duty-feed/leader-duty 邻接段迁 `duty/`，与 ① 期同款 host-seam 手法。关键接缝：
值守域消费 ① 期留守的活性读服务簇（§三出域表），PM 席位联检（closeoutJointCheck）经 dispatch/settle 的
宿主回调挂接——①期定下的「模块间回调一律走 host」规矩直接复用。**③期 watchdogs/（约 4–5 人日）**：
:614 SDK 看门狗参数、:5983 resume 熔断＋restart-ledger（① 期已明确出域留此）、:13208 context 看门狗、
:13330 会话流看门狗——注意 resume 熔断与 dispatchWorker 的「熔断冷却中不硬拉熟手」交互（:10780 附近），
届时经 host 接口对齐，不直连。④期安全层（:3319）＋activity 舱（:3859）各自成件后，session-manager
降到会话域本体（adopt/生命周期/外部会话桥接），R4 共享域包（@ccdeck/domain）的边界届时才看得清——
`dispatch/types.ts` 的 DispatchInput 是第一块被外部消费的契约候选，①期把它提出去就是在为 R4 铺地基。

---

## 七、风险与未决

1. **文本锚清单非完备**（中）：本图点名的六处是 grep 已知命中；305 个测试件读源锚是惯例写法，
   预检协议（G-19）是硬闸不是可选项。残余风险＝ zone 切片式锚（indexOf 截段，如 test-seatgate:76 的
   gateZone）在迁移后截段错位——预检时对「读源＋区间切片」双特征件逐一人工过。
2. **可见性放宽面**（低）：~20 个 private 成员 public 化是 review 噪音源；以 `/** @dispatch-host */` 记号
   约束可检索性，④期后可回收收紧。
3. **dispatchWorker 深层私有调用**（中）：体内对 this.create/this.resumeAgent/this.transition 等的调用
   决定 host 接口实际宽度，Step 1 的 tsc 驱动收敛可能比预估宽 10–15 个成员——不影响形态，影响 Step 1 工时 ±0.5。
4. **bundle 面**（低）：新目录相对 import 全部 `.js` 后缀（Node16 resolution）；esbuild 单文件 bundle 内联，
   abi-gate/check-bundle-sync 不感知目录结构，Step 5 构建验证一步到位。
5. **未决①**：parity 全量 relay 域重录时长（~140 件含 test-bridge 4–8min）——可先 FLAKY 豁免慢件再录，
   豁免清单进第 0 步提交说明。
6. **未决②**：四个平铺 dispatch-*.ts 是否归位 dispatch/——建议 ④ 期后卫生批再议（收益纯审美，文件面成本 8 个测试件 import 改写）。
7. **未决③**：`DispatchInput` 是否同步进 types.ts 公共契约面（R4 接壤）——建议 ① 期先落 dispatch/types.ts，
   R4 立项时再决定提升路径，避免提前抽象。

---
*deck-arch · 2026-11-28 · 锚 dev `ef8d781c`；输入 arch-review-2026-11-28 §R1＋DEV-39 台账（PR #167）。
本件为纸面施工图，未动任何生产代码。*
