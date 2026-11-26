# cc-deck 缺陷台账（夜间深度挖掘 · DEV-20）

> 生成：2026-11-27 凌晨（夜间自主批次 Stage 1）· 挖掘者 deck-fixer-3
> 红线遵守：全程只读挖掘，未改任何生产数据与产品代码；本文件是唯一产出。
>
> **挖掘源覆盖**（按任务书排序，全部实勘）：
> 1. `~/.cc-deck/data/events.ndjson`（18MB，覆盖 10-30 → 11-24 23:46，relay 死亡即止）
> 2. `~/.cc-deck/artifacts/`（1330 件回执，P2/P3 遗留池 grep 挖掘）
> 3. `~/dev/cc-deck/docs/pipeline-audit.md`（v4 全链损失点账本，末次增补 1029）+ docs/operations/feedback-ledger.md
> 4. git log dev 近 60 天（1609 笔，用户实锤/fix 主题聚类）
> 5. PM 会话转录 `~/.claude/projects/-Users-xdd--cc-deck-org/` 与 dev-cc-deck worker 转录（人类原话提取）。**注**：深度转录挖掘的子代理被 bigmodel 内容安全过滤击杀（pipeline-audit L-1024-1 同款损失形态的现场复现）；改用本地字符串过滤手术式提取——近 60 天 PM 转录里「user 角色」消息 95%+ 是机器注入（worker 交付/派单/值守通知），真人原话主要落在 git「用户实锤」提交记录与验收单里，§五 R 表以 git 为主证据源。
> 6. `~/.cc-deck/data/duty-rounds.ndjson`（14.5MB）、`patrol.log`（空）/`~/.cc-deck/patrol-report.md`、`shadow-diff.ndjson`、`embedded-relay.log`、`hook-debug.log`、`disk-watchdog.log`、`link-quality.ndjson`、`harvest-violations.ndjson`、`version-revert-log.ndjson`、`cli-pids.json`、acceptances 目录
>
> **分级口径**：P0=活故障/数据丢失/主链瘫；P1=功能不可用或反复复发的高价值缺陷；P2=体验缺陷/监控盲区；P3=低危/备案。
> **闭环标记**：〔未闭环〕〔已修待回归〕〔已修已验〕〔流程级〕（流程/纪律自身的缺陷）。

---

## 一、P0 区（当前活故障，Stage 1 已另有专项修复单）

### DL-P0-1｜生产 relay 死亡 >48 小时，org/PM/通知/派单全瘫 〔未闭环〕（P0-A 修复单承接）

- **现象**：8787 无监听（本次实勘 `curl /api/health` = 000，lsof 无 LISTEN）；events.ndjson 止于 11-24 23:46；所有 CLI hook 事件上报失败（hook-debug.log 每条 `post fail (r0 0): fetch failed`，持续至今）。
- **证据链（实勘新证据，超出父单已知）**：
  - `version-revert-log.ndjson` 11-24 23:46:44 upgrade test.33→test.34，ps_snapshot 含 `hdiutil detach /Volumes/CC Deck Nova`——**relay 死亡时刻=用户装机换 app 的精确时刻**，app 替换杀 sidecar 后新 app 未把 relay 拉起；
  - 同文件 11-24 19:22 / 22:14 两次 `app-missing`（/Applications 下 app 不存在，WatchPaths 触发）——换装窗口期告警，无人消费；
  - `embedded-relay.log` 死亡当天 8 次裸错 `failed to run git: fatal: not a git repository`，无时间戳无堆栈（子进程 stderr 直继承打印，**该字符串在仓内源码、app bundle、relay-service 部署位三处均 grep 0 命中**——来源不明的子进程，排查方向：route-retry 边的 spawn 或换装期 CLI 子进程）；死亡前 3.5h WATCHDOG 五连 `stall_detected lane=slow`（20:12→23:37，每次停滞 15-19 分钟）；
  - `cli-pids.json` 28 条注册全是死 PID 无清理（29ab705b→15585 等历史会话）。
- **疑似根因**：换装杀进程 + 新 app 侧 sidecar 启动失败（better-sqlite3 ABI 失配见 DL-P1-2 / 未知 git 子进程崩面）+ 无拉起监督闭环（app 不在运行，无人重启）。
- **⚠️ 家族前科（第二现实证）**：test.34 验收单（~/.cc-deck/artifacts/acceptance-test34.md 附①）记着「homewin 上完全退出 CC Deck 再重开：给本机会话发消息能正常发出（**test.33 服务未起问题**是否随重开消失）」——**同一「装机后服务起不来」形态在 test.33 的 Windows 机上已出现过一次**，Mac test.34 是第二现。两台机器、同一 bundle 代（11-23 三批），指向 bundle 自身的启动回归而非单机环境偶发。
- **⚠️ 给 P0-A 修复单的交叉线索（本台账新发现）**：死亡当晚 22:43 部署的新 bundle 含 11-23 三批（DISPATCHFIX/DRAINFIX/ANIMFAST）。其中 **DISPATCHFIX 新增 `maybeSpawnHeadlessConsumer`：池空窗自动 spawn `claude -p` 消费队首 + sweep 周期（≤5min）兜底重触发 + dispatch-queue.json boot 回灌**（docs/handoff-1121/w-dispatchfix.md 验收②）。时序吻合度极高：换装后 relay 重启→boot 回灌队列→headless 拉起在 app Resources cwd（非 git 仓库）→ 裸错 `failed to run git`（该字符串恰是 claude CLI 在非 git cwd 的 git 探测输出，经 stdio 继承落进 relay 日志）→ 与 WATCHDOG slow-lane stall 相互作用。「failed to run git」8 次全部夹在 heartbeat/route-retry 行之间的分布与此假设一致。建议 P0-A 单**优先核查 headless spawner 在换装/boot 场景的行为**。
- **建议任务书要点**：①sidecar 启动失败的结构化日志（杜绝裸错）；②app 换装窗口的 relay 生命周期归属（谁负责拉起）；③启动自检（git 子进程/依赖加载失败→带上下文报错而非裸崩）；④headless spawner 的 cwd/spawn 上限/退避核查。

### DL-P0-2｜注入链全灭：全部功能位「无帧(999m)」，早于 relay 死亡 33h+ 〔未闭环〕（P0-B 修复单承接）

- **现象**：`patrol-report.md` 自 11-23 14:13 起源菜单/细节批/注入P0/EXPO/TASKFLOW/BOARD2/MODE/PARITY/MSETSIG 九功能位全部 `无帧(999m)`，而 relay 当时仍 200——注入链独立故障。
- **关联证据**：events.ndjson `dispatch-reroute: zombie skip … 无进度帧 Nmin 重路由` ×4（11-24）——派单路由层同样观测到「无帧」判定 worker 为僵尸；`watch-feed [idle] 零在册巡查员（哑然）` ×34——巡查员席位空置。
- **疑似根因**：注入/帧上报链在 11-23 14:13 前后断（与 1123 大批部署 DRAINFIX「事件风暴耗电根治」时间吻合——**高度怀疑 DRAINFIX 修耗电时把帧上报一并砍静默**，需 P0-B 单核对 59d815b0 的三刀改动面）。
- **建议任务书要点**：功能位帧上报的最小心跳恢复 + patrol 无帧阈值告警（见 DL-P1-5）。

### DL-P0-3｜PM 值守链实质死亡 14 天：738 轮 duty 全 sleep 〔未闭环〕

- **现象**：duty-rounds.ndjson 近 14 天 738 轮，**736 sleep / 2 continue**（11-13 00:03 起）；NOTIFY_CHAIN_AUDIT `pm-no-target-streak: no_pm_target 连击 N 轮——Nh 静默睡形态告警` ×18（第四现）+ `dispatch-no-duty-pm`（no-leader 模式派单时值守位空）×3。
- **定性**：L-1029-2「PM 死亡无人知」的恶化终态——**且这不是首犯而是「第五现进行中」**：1106 用户实锤「3h 断档 worker_done×5 全 no_pm_target」后立过治本单 seatlive（498f871e，自称「断档第四现治本」，刀4=no_pm_target 连击≥2 轮 streak 告警卡，承诺「3h 静默睡不允许再发生」）——**治本后第 7 天（11-13）起全 sleep 14 天，streak 告警确实发了（chain-audit 18 次）但全部投进只有 relay 活着才可见的面板通道**。night squad（Multica）在 relay 之外自救，但 cc-deck 自身的派单/收割/喂活全停。
- **教训**：seatlive 修的是「检测」，没修「触达」——检测→告警→**人看到**的最后一跳依赖被监控对象自身存活，见 DL-P1-5。
- **建议任务书要点**：no_pm_target 连击 N 轮→手机推送升级（pipeline-audit L-1029-2 根治建议，一直未落）；「PM 位空悬>1h」入 patrol light 必报项。

---

## 二、P1 区

### DL-P1-1｜会话自动恢复死循环不降级：同一会话 3 天 9 连败 〔未闭环〕

- **现象**：SESSION_ERROR `恢复失败: 初始化超时（45s）（该会话首次回合未完成即中断，直接恢复走不通；给会话发一条消息可自动回退新会话续命）`——会话 0f6906c5 于 11-21 17:14 → 11-24 19:17 连败 9 次；配套 system 行：`恢复已连续失败 N 次…自动恢复进入冷却` ×22、`[交付直达] 恢复连续失败 N 次已熔断…本条注入已跳过并入队` ×8。
- **疑似根因**：错误文案自己写明「直接恢复走不通」且存在「发消息降级新会话」路径，但自动恢复器只会在冷却→重试→熔断间循环，**从不主动走降级路径**——对「首回合未完成即中断」形态应直接判死改派，而不是烧 3 天。
- **建议任务书要点**：resume 失败形态分类——「初始化超时（首回合未完成）」形态连败 ≥2 次即自动降级新会话承接（或 retire+告警），不再进入冷却循环。

### DL-P1-2｜app 内嵌 better-sqlite3 ABI 失配，sqlite 读面生产不可用 〔未闭环〕

- **现象**：embedded-relay.log 11-24 11:52 起 `[read-mode] org 源 checkpoint 推进失败（confirms.json…）: StoragePort.open: better-sqlite3 不可用（ERR_DLOPEN_FAILED…NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127）`——**app Resources 内的 node_modules/better-sqlite3 编译目标与内嵌 node 运行时不匹配**。
- **定性**：1029 悬置的「拍板② sqlite 生产部署」的直接恶果：sqlite 从未真正部署成功，运行时恒降级 json 档；checkpoint 推进失败还导致 confirms 重扫（日志自认「下轮导入按重扫幂等处理」=性能税）。
- **建议任务书要点**：出包链加原生模块 ABI 闸（build-plugin/CI 校验 NODE_MODULE_VERSION 与打包目标一致）；或拍板②正式落地（部署时机/重编译路径）。

### DL-P1-3｜验收单机制死亡：23 张 pending 仅 1 张回流，最老挂 29 天 〔未闭环〕

- **现象**：`~/.cc-deck/data/acceptances/` 23 张 pending 单（最老 10-29 test.74），全目录仅 1 份 `.results.json`（a988dfd5）。1029 物理归档过 28 张死账后一个月，又攒了 23 张。
- **定性**：L-1029-1「验收单无生命周期终点=值守永久骚扰」未修的持续实证。用户实践=实时反馈不回填（memory 口径），验收单作为机制与用户行为已根本错配——要么按 1029 建议加 TTL/口头裁决代关，要么正式退役该机制改走实时反馈+git tag 档案。
- **关联**：duty feed 候选被 pending receipts 滚爆（1029 实证 79 项）是同一根因的下游症状。

### DL-P1-4｜板账一致性家族病：多写口无 journal、三账缺角、派单→板卡联动断裂 〔未闭环〕

- **现象与谱系**（同一根因族——板文件多写口无事务，一致性靠事后对账）：
  - CARDTERM「审查单返修单卡终态缺口」**第六现**（7c460771，11-12，32 张滞卡清洗）；
  - ORPHANCARD-R1 返修 P0 空转/P1 误翻守卫（11-09）；
  - LANEFLIP 看板甬道精确切换治本（11-10，续跑卡滞 8h 对账残余）；
  - L-1029-8 派单→板卡状态联动断裂（**follow-up 查修单至今未见落地**：29 晚 15+ 单全停 backlog，手工归位）；
  - DISPATCHFIX 派单链状态一致性「三现+fix1/fix2」（1f6038cf，11-23，三轮复核过闸）〔已修待回归〕；
  - events.ndjson 实证：`pm-wake recon(patrol-full) 三账缺角：任务面有单但台账/板均无：#N×5` ×4、`board-recon-loop` ×13、`cardlife-receipt-gate 收口 done 但回执未合规` ×3。
- **疑似根因**：pipeline-audit §12/§13 已写透——板文件四写口全量覆盖写无 journal（W-SSOT-C 架构级风险）；「P2 板 delta journal」建议挂了一个月未立项。DISPATCHFIX 回执（docs/handoff-1121/w-dispatchfix.md）定性为「编排层把 status 声明当活证据」，真活性单源 realLivenessOfSid 已落数据面。
- **DISPATCHFIX 遗留未做**（回执「遗留」节明示）：①**批E 端上渲染挂接**——web-console 成员灯/板面消费 `liveness` 字段未做（数据面到位、UI 零消费=用户看不见）；②预存基线红 3 件（cardlifer2 43/44、boardreconr3 22/1、import-dispatch-lesson 套件崩溃——与 1029 备案的「基线预红测试债」同源未清）。
- **⚠️ 防线干跑实锤（artifacts 深挖勘定）**：`DEFAULT_TIER.boardrecon="observe"`（relay/src/auto-tiers.ts:50），生产 `~/.cc-deck/config.json` 无 `autoBoardrecon` 键——**对账「治本」上线即干跑，僵尸强翻/告警双面只记 wouldDo 不执行**（artifacts/review-w-boardtruth5-1109.md 明示「五现第六现隐患…PM 收割时三选一拍板」，至今未拍）。这是 R4 家族反复复发的直接解释之一：防线建了没通电。
- **建议任务书要点**：delta journal 落地（写前留痕+可回放）；moveEntryByDispatch 裸设置器收编业务闸；L-1029-8 的翻态链缺口专项排查；批E liveness 消费挂接；基线债清零。

### DL-P1-5｜巡逻（patrol）只见不报：全红 3.5 天零人工告警 〔未闭环〕

- **现象**：patrol-report.md 11-23 14:13 起九功能位全红（999m）+ 11-25 00:12 起 relay:000，持续到 11-27 本次实勘——**没有任何升级动作触达用户**（relay 活着的 33h 里也没报）。watch-feed `[idle] 零在册巡查员（哑然）` ×34。
- **定性**：patrol 的产出只写进 report 文件和面板通知，而面板通知依赖 relay 存活——**监控与被监控同进程同生死**（pipeline-audit §11 P1 已备案「relay 挂=层 1/2 全灭」，层 3/4 的 turn-spool 只覆盖 CLI 回合，不覆盖 patrol 自身）。
- **建议任务书要点**：patrol 异常分级外发（持续 N 小时全红→走独立于 relay 的通道：macOS 本地通知/手机推送直连云桥）；或最低限度写一个用户可见的文件+桌面通知。

### DL-P1-6｜云桥链路慢性抖动：heartbeat timeout 节律性断连 + 设备路由反复 miss 〔未闭环〕

- **现象**：embedded-relay.log 11-24 全天 `heartbeat timeout (pong missing >24s)` 每 15-20 分钟一次（14:23/14:39/14:43/14:48/15:04/15:37…）；设备 `wb-c896f2f3699b9e94` 全天 route miss→parked→route retry→unparked 循环 ≥6 轮。link-quality.ndjson 尾部 drop(ws-close)/reconnect 交替，单次断连 downtime 最高 4.8s。
- **定性**：手机端「老是要 reconnect」观感（09-22 handoff bug-phone-inbound-render 原话）的服务侧底层仍在——桥接层 24s pong 判死阈值 vs 云端实际延迟的错配，反复 terminate-reconnect。每次重连都触发 auto-resume 设备列表，与 DL-P1-1 的恢复循环互为放大器。
- **建议任务书要点**：heartbeat 判死阈值自适应（连续 N 次才断）；route miss 设备的三振出局后的冷却而非立即 retry。

### DL-P1-7｜「空闲跳序」四现 saga：updated_at 多写手家族病 〔已修待回归〕（★反复反馈未闭环标志案例）

- **现象谱系**（用户 11-23→11-24 连续四轮实锤「空闲的会话卡反复跳到顶部」）：
  1. 首现修：c5b65148（test.28 五刀，同值 status 不洗 updated_at）；
  2. 二现修：158184c9（todos/stats/pending 三写手同值守卫）；
  3. 三现修：426629d9（客户端 onHeartbeat 每拍洗 updated_at——PM 常驻保活心跳不断）；
  4. 四现修：0f29bc7a（WORKING 恒洗退役：revive-on-hydrate 每拍同值重报 WORKING）。
- **定性**：一个根因（updated_at 被「同值写手」洗）藏了至少 6 个写手，四轮才逐个拔掉。**同类回归的结构性防线仍缺**：没有「同值写 updated_at 必须跳过」的统一单点守卫（每次修的都是新发现的写手，不是写手注册面）。第四次修复同时修了图钉误触 P0。
- **建议任务书要点**：立「updated_at 写手清单+单点守卫函数」——所有写 updated_at 的路径必须过同一 `touchIfChanged()`；加回归断言「空闲会话 60s 内 updated_at 不变」。

### DL-P1-8｜引擎异构接入报错家族（qwen/codebuddy/codex） 〔已修待回归〕（★反复反馈）

- **谱系**：ENGREST-FIX（11-10，qwen/trae config 注入/探测对版）、ENGCB-FIX（11-09，codebuddy 模型词表幽灵键+acceptEdits 硬拒）、ENGSEC（11-10，安全层返修）、enginefix（11-24，codebuddy 模型分档回落+qwen 非交互 auth 前置收紧）、codex 正文占位（593d4f32，11-24 用户实锤「Codex 回复」四字占位不上正文）。
- **共性根因**：各引擎 CLI 行为漂移（模型词表/auth 语义/消息 schema）没有对版测试网——每次用户换引擎就炸一次，修一批好一批，下个引擎版本再炸。
- **artifacts 深挖补充（最新两笔未闭环）**：①codebuddy 词表漂移——`CODEBUDDY_MODELS` 白名单仍是 hy4free/hy3 系而 API 400 实况回带 hy4flash-free/hy4flash 系，清单外串**静默降级**为默认、唯一可察点 relay console.log（artifacts/w-review-enginefix-b-pr-15.md P2-1；agent-codebuddy.ts:46-53 原样）；②qwen 探针缺 vertex-ai 两组合（GOOGLE_API_KEY+GOOGLE_MODEL / GOOGLE_CLOUD_PROJECT+GOOGLE_MODEL，engine-auth.ts 零命中，w-review-enginefix-a-pr-15.md P2-1）。
- **建议任务书要点**：engine-adapters-smoke-checklist（docs/operations/ 已有清单）机器化为 CI 冒烟；rollout 消息 schema 兼容表驱动测试；词表外降级必须走会话时间线可见提示。

### DL-P1-9｜测试隔离洞：worker 会话跑测试可直接写生产 sqlite 库 〔未闭环〕（1122 事故预防面未落地）

- **现象**：1122 夜生产库 `~/.cc-deck/data/cc-deck.sqlite3` 被多进程轮流「重灌」（artifacts/INCIDENT-1122-prod-db-pollution.md：「约 200 个套件没钉读档、其中 60+ 会构造 SessionManager 或写 org 台账」）。
- **闭环核查**：污染数据本身已复原（dispatch 2934 行、0 行测试垃圾）；但**复发通道原样在**——320 个测试脚本仅 165 个钉 `CCR_DATA_DIR`，全局 fail-fast 硬闸不存在，事故报告承诺的「本批我可直接落」未落（test-dispatchfix.ts 至今 0 处该变量），`sqlite-quarantine-1122/` 备份目录未建，生产库 `-wal` mtime 至今仍动。
- **建议任务书要点**：测试引导文件统一钉 `CCR_DATA_DIR` 到沙盒 + 未钉档即 fail-fast 的硬闸（如 relay/scripts/test-lib 注入检查）。

---

## 三、P2 区

### DL-P2-1｜feedback-ledger「唯一闭环账本」建而不用 〔流程级〕（★本台账最重的流程发现）

- **现象**：docs/operations/feedback-ledger.md 2026-10-11 立账，自带硬规则「任何一行停在已修待验超过一个发版周期=主动追问，不许沉默搁置」。**实际状态：全账只有 test.11 一批 18 行，且 18 行全部停在「已修待验/真机待验」从未回填**；此后 ~122 个 test 版本、用户实锤反馈几十轮（见 §五 主题表），**零入账**。
- **定性**：专为防「反复反馈未闭环」建的账本，本身成了最大的未闭环件。用户「很多反馈反复出现没修好」的直接制度性原因：没有一张账把「谁报过什么→修到哪→验没验」钉住。**量级实勘**：立账（10-11）至今 git 上共打出 **~122 个 test 版本**（0.7.0-test.12→99 + 0.7.1-test.1→34，日均约 3 版），全部零入账。
- **建议任务书要点**：本台账（defect-ledger）回填进 feedback-ledger 并接管其军规；或两账合一，出包批强制过「feedback-ledger 行数对账」闸。

### DL-P2-2｜pipeline-audit 损失点账本 11 月断更 〔流程级〕

- **现象**：docs/pipeline-audit.md 末次增补 1029（L-1029-8）。11 月发生的 DISPATCHFIX 三现、DRAINFIX 事件风暴、ANIMFAST 耗电、1104 pmseat 三进程碰撞、1111 全员急停、11-13 起 duty 全 sleep、11-23 注入链灭、11-24 relay 死——**全部未入账**。CLAUDE.md 铁律 0 要求「断点与修复记入 pipeline-audit.md 损失点表」。
- **建议**：随 Stage 2 批补 11 月增补节（本台账可直接改写灌入）。

### DL-P2-3｜磁盘水位告警无人消费 + 已知磁盘泄漏未根治 〔未闭环〕

- **现象**：disk-watchdog.log 自 11-25 22:40 起持续 `WARN: data volume 85%`（每 5 分钟，间歇持续到 11-26）。memory 已固化根因：Claude Code 每 CLI 会话留 288MB update-prefetch 永不清理（单日 668 个=68GB）。
- **建议**：85% 告警升级外发（同 DL-P1-5 通道问题）；prefetch 清理 cron 化。

### DL-P2-4｜收割越权尝试反复出现（守卫有效但根因未查） 〔备案〕

- **现象**：harvest-violations.ndjson 8 次 pre-push 拦截 `/private/tmp/cc-deck-rel98` → dev 直推（11-05 前后 6 连 + mac15-probe 1 + 11-06 1）。守卫（收割权在 PM）工作正常，但**没有任何后续追查记录**——谁在 tmp 工作树反复推 dev、为什么，未立案。
- **建议**：低优先备案；若再现，按 dispatch_id/session 归因追查。

### DL-P2-5｜pipeline-audit 开放风险面存量（未修项清单，截至 1029 版） 〔未闭环〕

以下为 pipeline-audit 已备案但至今未修的损失点（本批未逐条复核代码现状，Stage 2 按单核对）：
- **A5** Stop hook mtime 判据粗糙（任何会话 3 分钟内活动即放行带单收工）；
- **A6** 手机消息入队后 CLI 死亡→pending 同灭（注入黑洞）；
- **B2** stop 后 SDK 队列黑盒（「stop 后排队消息全部丢失」用户实锤的托管侧根因，仅部分缓解）；
- **C1** worker 卡死无机器超时（纯行为纪律）；**C3** 上下文吃紧无水位自动收口；
- **D1** DISPATCH_DONE transient 丢失面（PM 正忙即丢，喂活兜底依赖 PM 存活——与 DL-P0-3 叠加即全丢）；
- **F5** transient 通知离线不补发；**F6** 发版广播单点丢失；**F8** 装机-验收断点靠人；
- **L-1024-2/L-1026-6** revive/降级恢复盲 fork 活进程（双分身族，任务 #257 状态待核）；**L-1026-1/4** 零产出 DONE 闸缺（压缩恢复循环吞单两例）；**L-1024-4** 建卡查重闸缺位；**L-1024-3** 派单无定向追加通道；**L-1029-5/6** 429 额度治理（含未接单 #55 RATELIMIT429）；
- **F2** 阿里云镜像 404（等用户放行）；**F3** LAN IP 文档口径；**P2** chain-audit→KV 同步未挂载。

### DL-P2-6｜派发队列自锁（dogfooding 悖论） 〔备案，DISPATCHFIX/DRAINFIX 已修待回归〕

- **现象**：events.ndjson `派单排队：W-DRAINFIX 派发队列排水死锁治本（编制空周期兜底）（编制 N/N 触顶且全忙，队列位置 N）`——**修排水死锁的单本身被排水死锁卡在队列里**；W-FZONE 批同理（一直派三/手动 drain 二轮）。11-23 DISPATCHFIX+DRAINFIX 双批落地治此，标待回归。

---

## 四、P3 区（低危/备案）

- **DL-P3-1** 孤儿扫描只读可见：「该 CLI 启动早于插件或未加载 hook，事件无法上报」（events ×2）——已知限制，备案。
- **DL-P3-2** 工作目录无效回落提示「/～/dev/fanzi 不是有效目录」（events ×2）——路径输入容错 UX 小疵。
- **DL-P3-3** events.ndjson 体积单调涨（19MB/月节奏）无轮转（pipeline-audit §12 已备案低危）。
- **DL-P3-4** better-sqlite3 失配的重复日志刷屏（同一错误 2 行连发×多轮，无节流）。

---

## 四A、artifacts 遗留池深挖补录（1330 件回执勘定，2026-11-27）

> 挖掘法：grep P2/P3/遗留/待拍板/备案标记 → 逐条追后续回执 → 当前代码树核证是否真落。已并入上文主条目的不重复列（DL-P1-4 防线干跑、DL-P1-8 词表漂移、DL-P0-1 test.33 前科）。**另确认 8 项高危已真闭环**（cardterm P1×3、sqlitefix P0 投毒、dutybackoff P1、boardpolish P0、aggred P0、notify-overhaul P1×2、enginefix 闸值、reviewseat CI 误诊）——闭环机制本身有效。

### 未闭环（P2 池，9 条）

| # | 条目 | 证据 | 核证 |
|---|---|---|---|
| A-1 | **评审席（review_only）无生产派单入口**——池组派单落下 bypassPermissions worker、零纪律段，评审池被污染 | review-reviewseat-r3-A-1105.md P2-1 | repo 与 ~/.cc-deck/bin/leader-dispatch 均无 review_only/target_sid 透传 |
| A-2 | **僵尸告警标记先于证据评估**——ZOMBIE_NOTE_MARK → continue 无条件先行，晚到证据（worker 补交回执）永不被强翻 | review-w-boardtruth5-1109.md P2-1 | board-recon.ts:376 原样 |
| A-3 | **WIP 回执提前尾行可强翻在跑任务**——receiptSlugs 纯尾字判据（「结果：+改动文件：」），无台账终态/mtime 交叉校验 | 同上 P2-2 | patrol.ts 构建段原样 |
| A-4 | **sync-leader-cli `--force` 无备份直接覆盖**——误用即永久丢部署位热改唯一副本；心跳探针发出后无消费检查面 | 同上 P2-3/P2-4 | 未修（工具硬化项） |
| A-5 | enginemobile 跨端词表不统一——PM 拍板哪套词为准悬置+装机截图未回填 | review-w-enginemobile-a-1106.md | 决策项 |
| A-6 | linkquality 遗留：web-cloud 真机 E2E + P2-4/P2-5 入单未消（PR#20 与 dev CONFLICTING 需并集收割） | review-w-linkquality-r1-1105.md | 无闭环回执 |
| A-7 | 存量 worker worktree 无 pre-push hook 批量补装（越权收割拦截按 clone 生效，存量件裸奔） | w-org-defects.md 返工②遗留 | 部署面未做（CC_ORG_ROLE env 注入这条已闭环） |
| A-8 | mobile-perf 批：代码 P1×2 已修，**test.81 真机四指标验收未回填** | review-w-mperf-1102.md P1-2 | 代码核证已修、无 acceptance-test81 |
| A-9 | connv4 连接链 L2 真机验收五项+配对码源行一项悬置（六轮返修审全过但装机回执缺） | w-connv4f-r1.md | 待装机 |

### 未闭环（P3 池，5 条）

| # | 条目 | 证据 |
|---|---|---|
| A-10 | prreview 工具尾巴：review-ledger begin/end 错位无守卫、--merge 幂等去重缺、brief 模板无反方视角指令 | review-w-prreview-b-1104.md P2×3/P3×3 |
| A-11 | 评审单 resume 不重评权限——老 worker 席可带 edit-auto/bypass 执行审查单（登记待决） | review-reviewseat-r3-A-1105.md P2-3 |
| A-12 | dispatch 域 append 全量重放 550~600ms（appendOnly 扩展另单） | review-w-sqlitefix-r1-1105.md |
| A-13 | enginefix 文案族：「内置 20 个」vs 实列 17 个矛盾等 ×2 | w-review-enginefix-b-pr-15.md P3-1/P3-2（agent-codebuddy.ts:118 原样） |
| A-14 | 设置域整域三段式 IA 改造待拍板（大件悬置） | w-v8-visual-restore.md 待拍板节 |

**待装机回归清单汇总**（并入 §六 回归轮）：A-8 test.81 真机四指标、A-9 connv4 五项+配对码、boardfresh BOARDS_DIGEST 真链（w-boardfresh.md 遗留节）、mobnotifylag 真机埋点回数（R14）、test.34 验收单全项（含 test.33 服务未起附①）。

---

## 五、反复反馈未闭环主题表（用户实锤聚类，git log + 转录交叉）

| # | 主题 | 轮次/跨度 | 修复笔（git） | 现状 |
|---|---|---|---|---|
| R1 | 空闲会话卡跳顶 | **4 现**（11-23→11-24 两天内） | c5b65148→158184c9→426629d9→0f29bc7a | 已修待回归（DL-P1-7） |
| R2 | 消息导航条（悬浮/采样/时间戳位置） | **≥6 轮**（11-15→11-23） | 52a22c46→54a1f295→8dbd0f01→0d135569→844d27f7→147587b8→17f86bc3（时间戳「三轮截图实锤」） | 末轮 11-23，待用户确认 |
| R3 | 图钉（置顶）交互 | **3 轮**（11-22→11-24，含一次 P0 误触=点卡即置顶） | 39e01ac7→c5b65148→0f29bc7a① | 已修待回归 |
| R4 | 看板/卡终态一致性 | **≥6 现**（10-29→11-23） | LANEFLIP→ORPHANCARD→CARDTERM(第六现)→DISPATCHFIX(三现+fix1/fix2) | DISPATCHFIX 过闸待回归（DL-P1-4） |
| R5 | 引擎接入报错（qwen/codebuddy/codex/trae） | **≥5 批**（11-09→11-24） | ENGCB→ENGREST→ENGSEC→enginefix→codex 正文 | 末批 11-24（DL-P1-8） |
| R6 | 桌面状态行/活性灯 | **2 轮**（11-09 DOCKFIX→11-24 六芒星闪动回归=修 bug 引入回归） | bd9a738f→18224c30 | 18224c30 镜像补落 920bd4e0，待回归 |
| R7 | 连接页/源列表/账号多源 | **长篇连续剧**（11-16→11-22，connv3→CONNFIX→ACCTMULTI P0→CONNV4A-F 六批） | 096d12de→981a7e1e→df98dcb9(P0)→1b4fa5b9…e37c167e | CONNV4F 11-22 过闸；ACCTMULTI 为 P0 根除 |
| R8 | 耗电/事件风暴 | **2 批**（11-23） | 59d815b0(DRAINFIX relay 事件风暴)+b45249ca(ANIMFAST 常驻动画) | 过闸待回归；**疑与 DL-P0-2 注入链灭相关** |
| R9 | 手机端消息滞后/重连观感 | 09-22 立案→底层抖动仍在 | handoff bug-phone-inbound-render；后续多轮移动端批 | 服务侧慢性面未根治（DL-P1-6） |
| R10 | 值守 PM 断档/no_pm_target | **四现治本（1106 seatlive 498f871e）→ 11-13 起第五现进行中（14 天全 sleep）** | seatlive 四刀+pm appoint 治理 fba60fb9 | 检测已修、触达未修（DL-P0-3/DL-P1-5） |
| R11 | hook 失联乒乓误判死 | 第三对+第四对（1104，21h 误判死形态） | b55c3d58（判死守卫+乒乓滞回） | 已修待回归 |
| R12 | 板面说谎/数据新鲜度 | **第三现**（1104） | a5ea1fff（boardFreshAt 三写点+BOARDS_DIGEST 对账） | 已修待回归；与 R4 同域不同层 |
| R13 | 源绑定半连接（#38 族） | **四现**（1104） | 3f22f6e0（自愈重同步+徽标诚实） | 已修待回归；与 R7 连接页连续剧同域 |
| R14 | 手机通知按钮卡顿 | 1106 用户实锤（桌面同构 bbdebdfe） | 250b1e68（分帧+让路+真机埋点目标<300ms） | 已修待真机埋点回数 |
| R15 | 「装机后服务未起」家族 | **两现**（test.33 homewin / test.34 Mac=本次 relay 死亡） | 尚无修复 | P0-A 承接（DL-P0-1） |

---

## 六、统计与 Stage 2 拆单建议

**总数 38 条**：主台账 24 条（P0×3 / P1×9 / P2×6 / P3×4，流程级 2 条计入 P2）+ artifacts 补录 14 条（P2×9 / P3×5），另有待装机回归清单 5 项（交叉引用不另计）。闭环态分布：**未闭环 27 / 已修待回归（含待装机）6 / 备案 5**。其中：
- **反复反馈未闭环（★）**：R1-R15 十五个主题，对应 DL-P1-7、DL-P1-8、DL-P1-4 等家族病——共性是「修现象不修写手注册面/不加结构性守卫」，每轮修掉一个点、留下同类复发面。**复发次数 ≥3 的主题有 8 个**（R1 空闲跳序×4、R2 导航条×6、R4 卡终态×6、R5 引擎×5、R10 PM 断档×5、R12 板面说谎×3、R13 半连接×4、R15 服务未起×2 进行中）。
- **两大系统性根因簇（本台账核心结论）**：①**防线建了没通电**——boardrecon observe 干跑（DL-P1-4）、patrol 全红不升级（DL-P1-5）、seatlive streak 告警投死通道（DL-P0-3）、feedback-ledger 建而不用（DL-P2-1）——检测/账本/告警件大量存在，但缺「通电验证」（部署拍板、升级外发、回填闭环）这一跳；②**修现象不修注册面**——空闲跳序四刀每刀拔一个写手、引擎每批修一个词表——缺统一守卫/对版测试网。
- **已修待回归**：DISPATCHFIX、DRAINFIX、ANIMFAST、空闲跳序四现刀、图钉、六芒星、enginefix、codex 正文、CONNV4F + artifacts 待装机清单（A-8/A-9/boardfresh/mobnotifylag/test.34 单）——Stage 2 需先跑一轮装机回归（test.35+）再判定闭环，**不回归验证就永远不知道修没修好**（feedback-ledger 18 行烂尾教训）。
- **未闭环硬欠账**：P0 三件（另有专项单）、恢复死循环（DL-P1-1）、sqlite ABI（DL-P1-2）、验收单机制（DL-P1-3）、测试隔离洞（DL-P1-9）。

**Stage 2 并行拆单建议（两个批，冲突面最小切分）**：

- **批 A「relay 侧+链路基建」**（改动面：relay/src + patrol + 少量脚本）：DL-P1-1 恢复降级、DL-P1-4 板 journal+裸设置器收编+boardrecon 通电拍板、DL-P1-5 patrol 外发升级、DL-P1-6 云桥阈值、DL-P1-9 测试隔离硬闸、A-2/A-3（board-recon/patrol 判据两刀）、DL-P2-5 中的 A6/B2/C1/D1/F5/F6 机器闸族、DL-P2-6 回归。依赖 P0-A/P0-B 两单先行（同改 relay 面，须串行衔接）。
- **批 B「app/端上面+流程账本」**（改动面：desktop-tauri/web-console/expo/docs，不碰 relay/src）：DL-P1-2 sqlite ABI 出包闸、DL-P1-7 updated_at 单点守卫+回归断言、DL-P1-8 引擎冒烟 CI+词表补齐、DL-P2-1 feedback-ledger 复账、DL-P2-2 pipeline-audit 11 月补账、DL-P2-3 磁盘清理脚本、A-4 工具硬化、A-10/A-13 小修池。
- 两批共同前置：**装机回归轮**（验证 11-23/24 已修批 + artifacts 待装机清单）先行半天，避免在未验证基线上叠改；DL-P1-3 验收单 TTL 改 acceptance.ts（relay 面）若做须挪批 A。

---

## 附：本台账的证据文件索引（供 Stage 2 派单引用）

| 证据 | 路径 | 关键锚点 |
|---|---|---|
| relay 死亡链 | `~/.cc-deck/data/version-revert-log.ndjson` 尾 3 行 + `embedded-relay.log` 尾 60 行 | 23:46 hdiutil / git 裸错×8 / stall×5 |
| duty 死态 | `~/.cc-deck/data/duty-rounds.ndjson` | 近 14d 736 sleep / 2 continue |
| 注入链灭 | `~/.cc-deck/patrol-report.md` | 11-23 14:13 起全功能位无帧 |
| 恢复死循环 | `~/.cc-deck/data/events.ndjson` | SESSION_ERROR 0f6906c5 ×9 + 冷却×22 + 熔断×8 |
| sqlite ABI | `~/.cc-deck/data/embedded-relay.log` | 11-24 11:52 ERR_DLOPEN_FAILED 115↔127 |
| 三账缺角 | `~/.cc-deck/data/events.ndjson` | pm-wake recon ×4 / board-recon-loop ×13 |
| 验收单死账 | `~/.cc-deck/data/acceptances/` | 23 pending / 1 results |
| 越权收割 | `~/.cc-deck/data/harvest-violations.ndjson` | 8 次拦截 |
| 用户实锤谱系 | git log dev（本文 §五 各笔 SHA） | — |
| 损失点存量 | `docs/pipeline-audit.md`（v4） | §5.5/§13 各开放项 |
