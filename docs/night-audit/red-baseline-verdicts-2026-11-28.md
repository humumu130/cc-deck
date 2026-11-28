# 红基线定罪表（2026-11-28，DEV-38 / R5③）

> 执行：deck-fixer-2。基线 dev `24c84bca`（0.7.1-test.37 期），worktree `agent/deck-fixer-2/dev-38`。
> 方法：relay/package.json 全量 193 个 `test:*` 键本机顺序 sweep（node v22.23.4，每键限时
> 300s，杀树防挂起；日志 workdir baseline/ 逐键落盘）。CI 矩阵 65 键取自
> `relay/tests/ci.json`（本批单源化产物）。

## 〇、总数对账

| 口径 | 数 |
|---|---|
| 全量 test:* 键 | 193 |
| 绿 | 142 |
| 红（300s 限时口径） | **51** |
| 其中 CI 矩阵键 | 1（test:bridge，限时假象，见丁-1） |
| 其中矩阵外键（=红基线主体） | 50 |

**与「预存红基线 22 项」的关系**：22 出自晨报 P3 备案池一句话备案（night-report-2026-11-28.md
§P3 备案池，无逐条清单留存），基线为 `a017d22d`。本次 51 = ①基线后三批（DEV-21/22/23/25/30/33
线）又落地大量带源码锚的测试、锚随源演进持续掉队；②历史上从未有过全量逐条台账，22 的计数
口径不可考。本表为**首个全量逐条定罪**，自此红基线有账可查；修复/刷新后从
`relay/tests/ci.json` 的 quarantine 台账迁出。

## 甲、本批已修根（假红修根，2 件）✅

| 键 | 根因 | 修法 | 证据 |
|---|---|---|---|
| test:258-pair-selfheal | eval 沙盒桩缺名崩溃：W-LINKQUALITY/W-PAIRLOOP/W-ACCOUNT 批给 web-console 云 onopen/配对看门狗/poll 传输加了 `linkQ`/`isSelfPairCodeHint`/`acctQuery`/`sendCloudHello` 等新自由引用，测试的 `new Function` 形参表没跟上 → ReferenceError 连锁；另 D6 锚窗 1200 字符容不下 pair_ack 头部新增的两道守卫 if | 补中性桩（语义与原场景一致：非自配对、非本机、空 acct）；锚窗 1200→2000 | 修前：崩溃 `linkQ is not defined`（baseline/test_258-pair-selfheal.log）→ 修后 **62 passed, 0 failed** |
| test:transition | 计数锚冻结：断言 `this.transition(` 恰 25 处，源码合法演进到 29 处（后续批经 transition 的合法写点；「零 status 直写残留」不变量断言仍绿，排除绕行） | 锚 25→29（锚随源刷新） | 修前 60/1 → 修后 **61 passed, 0 failed** |

## 乙、锚漂移/预期过时（假红族，处置=锚刷新单 DEV-42）

源码经后续批演进、测试锚（源码形状/计数/文案快照）未随动。**非当前代码缺陷**，但锚不刷新
则锁力归零（268 的「锚定失败中止」就是锁死实例）。逐条：

| 键 | 首失败锚 | 判定细目 |
|---|---|---|
| test:268-cloud-watchdog | 锚定 cloudSetConn 函数体（失败即中止，15/1） | cloudSetConn 体被后续批改形，锚落空中止 |
| test:282-targeted-render | S5b' rk 缺席回落旧整树路径保留 | 渲染管线重构后回落路径形态变（51/1，其余全绿） |
| test:005-servers | A3 离线死条目直接删 / C7 initSettingsLiveData else 分支 / D1 sdel 段块边界 | index.html/settings-domain 形状锚 ×5（63/5），W-V8R/CONNV4 批改形 |
| test:005-engauth-web | C1 provLive catalog map / C5 auth_hint / F3 b2Toast 时长参 | 控制台引擎登录面形状锚 ×6（21/6） |
| test:005-route-fix | A1 applySnapshot 签名带 evSource（**0 pass / 11 fail 全灭**） | W-ROUTEFIX 后快照/路由代码整体演进，全套锚失效 |
| test:005-blankset | B1② color-mix 静态兜底裸奔 81 条 / B1③ box-shadow none 兜底缺 8 | **⚠ 半真欠账**：ui-ledger 已记「基线 81→交付 88 净增 7」——CSS 兜底债真实存在，锚测试守的是真欠账 → 处置并入 DEV-41 的 CSS 兜底修复项（非纯刷新） |
| test:dutybackoff | R1b managed onLog 体内挂 maybeConsumeDutyReceipt（源码锚） | onLog 结构改形（36/1，行为面全绿） |
| test:xmsg | v7 迁移在册（迁移注册表锚；64/65） | 迁移注册表演进未带锚 |
| test:boardlife | ②converge 复核态保护锚在（planlane 批） | planlane 改形后锚移位 |
| test:m-graceful | 锚 relay SIGTERM 活单诊断在位 | 诊断代码改形 |
| test:bootts | A1 web onSessionUpdated 缺载不伪造 / A3 setExternalStatus at 参 | web 帧消费面形状锚 ×2（21/2） |
| test:cbs | U1a 远程 win32 盘符示例文案 + `teamAnchorBrowseable` 桩缺名崩溃 | 文案锚漂 + 同 258 类桩缺名（两混） |
| test:duty-boundary | S6 leader-duty.ts 零 import/require（纯函数纪律锚 ×2） | 纯函数文件被加了 import（纪律回归或合法演进——刷新批定性） |
| test:role-templates | 内置 4 岗在库 / 21 行计数 / 坏 JSON 兜底 ×4 | 模板库演进 vs 冻结清单 |
| test:version-sentinel | P2-3b 真回退（test.99→test.98）仍判 revert | 版本序判定与用例期望漂移 |
| test:gatefix | G1① receiptPath ~ 字面量归一 / G4 零误报 | 回执路径归一行为演进 vs 冻结期望 |
| test:halfconn | `downTextOfSid` 未定义（expo 源 eval 桩缺名） | expo-app 侧同 258 类；件在 expo-app/scripts/ |

> **乙族处置结果（DEV-42，2026-11-28）**：17 键全数修绿（含 approve-card 的 expo 豁免锚——
> approval-timeout 批后 stale 置灰机制整体退役，锚升级为「审批卡永不过期」总锚）。逐键锚随源
> 刷新（桩缺名类 cbs/halfconn/268 补中性桩；计数/文案/形状类按新形态重锚；version-sentinel
> P2-3b 从绝对版本对改相对锻造防再漂）。**duty-boundary 定性：合法演进**——W-DUTYBACKOFF 刀3
> 的 duty-reviewed.json orgDir 侧持久化引入 node:fs/node:path/org.js 三 import，spec 三面隔离
> （零 SQLite 表/零 EventType/零 EventBus 出口）原样保持，纯度锁从「整文件零 import」收细为
> 「import 白名单＋评估函数区零 fs 触点」。迁移去向：15 键晋 matrix（自包含锚测试）；2 键入
> watch（version-sentinel=macOS 面键 CI Linux 不可跑；approve-card=③段 tmux E2E 环境性未验）。
> 顺带收编矩阵外裸奔 5 键（cardtags/awaituser/animfast/visualfix/session-slim——leader 勘定转入，
> 全数修绿后 npm 注册入 matrix；session-slim 崩溃定性=桩缺名非进程缺陷，未单开修复单）。
> 分支 `agent/deck-fixer-2/dev-42`，回执见 DEV-42 单。

## 丙、行为断言红·缺陷候选（处置=定性修复单 DEV-41）

行为级断言（假工厂/沙盒真跑）红——**非锚、非环境**，需逐族定性（真缺陷 or 有意变更未跟测）。
按子系统分族：

| 族 | 键 | 首失败行为 |
|---|---|---|
| 板生命周期/收口 | test:boardfix、test:m1-orchestration、test:m-board、test:board-mirror | 收口卡翻 submitted（boardlife 交付候选）实 claimed/undefined；task_ref ① 派单头注入缺失 ④ 收口搬卡断链；活单在制数据层拒收缺失 |
| 导入/存储 | test:m1-foundation、test:import-org、test:import-session-task、test:sqlite-task、test:m1-import-parity、test:read-mode | **m1-foundation 中途崩：`StoragePort.begin: 未打开——open 前置`**（sqlite.ts:155，26/50 后 use-after-close 形态）；导入族批量「实际 0 行/2 行」（期望 13/20）；对账零差异面失守 |
| 快照/端投影 | test:snapshot-parity | LAN↔phone 字段集 diff=[acct_bound,design_docs,pm_duty,relay_devices]；单会话帽 50 实 62；截断标记 0（×6） |
| 通知/值守 | test:notify-overhaul、test:r1c-notify、test:x0、test:pm-duty-product、test:pmresume | reconcile 快路径漏 syncCounts；badge 类 ×5 缺；N11④/N14 悬账补记断链；no-leader 值守接管 ×4；worker done 即唤醒链断；逃生阀=0 不拉 |
| 会话/活流 | test:watchdog、test:alive、test:ui-followup、test:ws | A2 消息进活流断；孤儿卡收养在册缺 + **mtime 偏差 -1,795,838,237,587ms（单位/纪元混算形态）**；U1 空闲不跳根修 v3（updated_at 四现族）；resume 补发混入 seq≤1 帧 |
| 命令/权限 | test:m12-commands、test:m13-delta、test:m13-web-delta、test:permission-compat、test:wildonboard | C9 段链状态机 ×6；轻立项建组 fixture 建不成（m13/permission-compat 前置连坐 ×6）；在岗=最近活跃 external 空 |
| 跨端注入/云 | test:xmsg-e2e、test:005-cloud | dispatch-remote 注入 rejected:no-duty-target（×8，XMSG E2E: 8 FAILURES）；route miss 后 8s 窗 resume 补发未到（×2）。⚠ xmsg-e2e 返修补记：交付 SHA `e02d7b74` 上该键曾因 peer 桩未随迁以 ERR_MODULE_NOT_FOUND×3 假破（审查 P1-1 实锤），peer 随迁后复跑签名/exit 与本表逐字回归（EXIT:1、8 FAILURES、首败 A outbox 终态 rejected:no-duty-target） |
| 引擎收编 | test:codex-adoption、test:engine-rollouts | rollout 增量扫描收编 Codex/Trae 会话断 |

## 丁、环境性/时限性（隔离台账，不进矩阵）

> **丙族处置结果（DEV-41，2026-11-28）**：8 族 29 键＋005-blankset 全数修绿（30/30 终
> sweep 全 EXIT 0，tsc --noEmit 绿），已从 `relay/tests/ci.json` quarantine 迁出（余 18 键
> =乙族锚刷新 DEV-42＋丁族环境隔离，未动）。定性总账：**真缺陷 2 件**——①云通道
> SNAPSHOT 缺 4 个 #117 parity 字段（acct_bound/pm_duty/relay_devices/design_docs——
> cloud-client.ts 补齐，后两者经 ws-server globalThis 挂口同源）；②005-blankset CSS
> 兜底真欠账（base.css 补 81 条 color-mix 静态兜底＋8 条 box-shadow none 兜底）。其余
> 27 键均为「**有意变更未跟测**」：bootfast3 导入后台化/async 化（存储族 flush 栅栏＋
> await 化）、W-CARDLIFE-R2/R3 回执闸（板族补回执夹具）、W-PMSEAT 值守任命卡化
> （x0/xmsg/wild-onboard 走 claim+approve 新流）、#275S 沙盒闸（alive/codex/rollouts
> fixture 挪非沙盒路径）、W-BOARDV2 seat-scan 行（m12 段链计数滤黑板行）、appendOnly
> checkpoint 增量续读（import-session-task 重构 E/F 段）、W-NOTIFYPOLISH 视觉改版
> （notify-overhaul 锚随新形）、SQLITE-FLIP 缺省档渗入（005-cloud/ws 钉 json 沙盒五键）。
> 分支 `agent/deck-fixer-2/dev-41`，回执见 DEV-41 单。


> **教训补录（P1-1 返修，2026-11-28）**：迁移面归因不分矩阵内外——**quarantine 键同样须穷尽迁移面归因**。test:xmsg-e2e 在交付 SHA 上因 `xmsg-e2e-peer.ts`（无 test-/probe- 前缀，迁移 glob 漏网）未随迁，三 peer 全 ERR_MODULE_NOT_FOUND 崩在「A devfile 未出现」，其丙族真签名（no-duty-target×8）被断链掩盖——CI 不跑 quarantine 键，断链静默，DEV-41 接手会先撞断链误判缺陷面。与丁-1 bridge 同族同因（fake-injector 同型第二处）；**规则固化：迁测试目录必须带走其同目录相对引用的全部桩件（test-*/probe-* 前缀 glob 之外还有按名 spawn/import 的伴生件）**。

| 键 | 判定 | 依据 |
|---|---|---|
| test:bridge | **迁移断链（本批引入，当场修复）**——修正 record：初判「本机时敏红」错误。真根因=R7 迁移把 test-bridge.ts 移入 tests/ 而共享桩 `fake-injector.mjs` 留在 scripts/，`new URL("./fake-injector.mjs")` 同目录相对解析断链（本机长跑 45e2 红=模块先载路径后迁的竞态形态；CI PR #168 首跑 34s 红=bolt 断链）。**修法：fake-injector.mjs 随迁 tests/（9 处消费面 test-bridge/test-xmsg-e2e/test-clidead/test-tauritrust 全部同目录相对引用）**。修后全量复跑 **PASS 304.5s EXIT:0**；矩阵 65/65 本机全绿 |
| test:retired-live | **长周期设计态**（依赖 30min 巡检周期的真 relay 观测件） | 1200s 预算仍停在心跳轮询（日志：relay up+造账完成后心跳循环等待 retired 活跃周期）；矩阵本不含它 |
| test:approve-card | tmux E2E 需本机 tmux 会话环境（环境性）+ expo 豁免锚（锚类） | `FAIL: tmux E2E[allow]` |
| test:sessions / test:ws 等需真 CLI 键 | 设计态排除（CI 无 CLI/凭据必挂）——test:ws 本次同时带行为红（seq≤1）已归丙族 | relay.yml 矩阵注释；ci.json quarantine 登记 |

## 戊、长跑复判（1200s 预算）

- **test:bridge**：初判时敏红被 PR #168 CI 首跑（34s 快败于 busy injection direct with enter）证伪——真根因 fake-injector.mjs 迁移断链（见丁-1 修正 record），随迁修复后全量复跑 **PASS 304.5s**。教训：矩阵键本机红必须穷尽迁移面归因再下「时敏」结论。
- **test:retired-live**：1200s 预算 TIMEOUT（进程组杀）——日志显示真 relay 起在 :18899、造账完成后停在心跳轮询（`[retired-live] 心跳 groups=1 retired=2` 循环），等待的 retired 活跃周期依赖 30min 全巡 cadence（patrol 30min 全巡 + 5min 轻探针）。**定性：长周期设计态件（观测窗 ≥ 巡检周期），非缺陷证据**；矩阵本不含它，隔离台账记时限性。

## 己、处置台账落点

- `relay/tests/ci.json` → `quarantine` 节：上述全部红键逐条登记（分类+出处），修复/刷新
  验绿后从台账迁出（矩阵键另需经 leader 审）。
- DEV-41（缺陷定性修复批）：丙类 8 族 + 005-blankset 的 CSS 兜底真欠账。
- DEV-42（锚/预期刷新批）：乙类 17 件 + approve-card 的 expo 豁免锚。
- 「CI 红=必有人管」落点：矩阵 65 键全绿（本机实测 64 绿 + bridge 时限假象）；矩阵外红键
  全量在册（quarantine 台账），新增红键无台账即裸奔——后续加测试须同步登记（ci.json
  $comment 约定）。
