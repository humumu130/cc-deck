# cc-deck 夜间批次晨报（2026-11-28 07:10）

> 批次窗口：11-27 00:00 → 07:10 本地（无人值守授权）。总控 DEV-17，编制 leader home-mac + fixer×3 + reviewer×1。
> 逐时流水见 DEV-17「夜巡记录」串（00:47 / 01:27 / 02:12 / 05:57 / 巡检处置 / 02:12 / 02:41 / 03:02 / 03:43 / 03:50 / 05:12 / 05:56 / 06:45），本文只收总账。

## 一、子单终态盘点

| 单 | 内容 | 终态 | 要点（根因→修复→证据→集成） |
|---|---|---|---|
| DEV-18 | P0-A relay 死亡根修 | done | 死因定谳=换装杀 sidecar + 新 app 未拉起（版本指纹链实锤）；换装自杀治根（swap-nova fork+setsid 脱组）+ SIGTERM 告别行 + gh pr -R 根治裸错 → `bad51580`。生产 relay 00:47 复活（见 §三） |
| DEV-19 | P0-B 注入链全灭 | done | 探针误报治本（patrol 改读 hook 健康账）+ hook 断流自愈（失败账/日志轮转/退避 timer 修死路）+ patrol-standalone 独立哨（osascript 外发）→ `da776cd3`，test:hookfail 40 断言 |
| DEV-20 | 缺陷清单深挖 | done | 38 条去重分级台账 + 15 反复反馈主题（§五）→ `79b51e55`，全程只读 |
| DEV-21 | 批 A relay 侧+链路基建 | **in_review 待装机验收** | DL-P1-1/1-4/1-5/1-6/1-9 + 机器闸族 + DL-P2-6；返修一轮（dev 合入+CI 传播自愈）→ #162 squash `55cc1892`，CI 66/66；hook node 兜底 leader 直落 `e7ab6e11` |
| DEV-22 | 批 B app/端上+流程账本 | done | DL-P1-7 五写手收编 / ABI 出包三重闸 / 引擎异构冒烟 / feedback+pipeline 复账 / 磁盘消费账 / CLI 硬化 → #164 squash `30523d45`，收割门 CI 全绿 |
| DEV-23 | 未知缺陷主动排查 | done | 暖读 fail-open 闸三口对齐（#161 `f0301828`）+ deliver-session 同毫秒平局守卫（leader 直修 `9b311fa9`）；返修一轮过闸 |
| DEV-25 | sqlite ABI 错配（治标） | done | CI node 20→22 同源 + mac 三重 ABI 回归闸 → #158 squash `42ea07ab`；本机 node 22 实测 dlopen 42 往返 |
| DEV-29 | UI 走查与美化批 | **in_review 待装机验收** | 用户点名界面丑/布局不协调：P1×4 治布局 + P2×2 阶梯收敛 + ui-ledger 台账立账 → #163 squash `ff259558`；双主题截图审查席 L2 亲看 |
| DEV-30 | UI 遗留清账批 | **in_review 待装机验收** | 字号阶梯 95 处收敛（半像素清零）+ 台账 P2×8/P3×6 销项 + N1 缺闭括号顺手修 + SESSION_MERGE 时序治根（③④ leader 追认，流程偏差入账）→ #165 squash `6a55a482`，回炉一轮（B1② 88→81 恒等回落），CI 66/66 |
| DEV-31 | relay 侧清尾批 | **in_progress（fixer-3 在途）** | DEV-22 改派 3 件（codebuddy 文案 / engine-auth qwen 组合 / touchIfChanged 单点）+ smoke:engines 3✗ 归零；22:48 起跑，基线 `6a55a482` |
| DEV-24 | S3 终审与全量回归 | backlog 停车 | 提升判据已定：DEV-31 闭环且早于 09:00Z(01:00Z) 则自动提升；否则留拍板（§六） |

夜间窗口内另落入 dev 的非本批立项笔：`2a223a5e`（1127 用户实锤·状态栏子任务行）、`6e2678a2`（#159 通知死钮）、`45e282c8`（#160 源离线说谎）、`ac517c83`（bump 0.7.1-test.35）。

## 二、集成状态（dev，基线 faab0928=test.34）

**15 笔全量**（每事项一笔，均过审查闸+CI 门）：`79b51e55` 台账 → `da776cd3` DEV-19 → `bad51580` DEV-18 → `2a223a5e` 实锤小修 → `6e2678a2` #159 → `45e282c8` #160 → `ac517c83` bump test.35 → `42ea07ab` #158 DEV-25 → `f0301828` #161 DEV-23 → `9b311fa9` 平局守卫 → `ff259558` #163 DEV-29 → `30523d45` #164 DEV-22 → `55cc1892` #162 DEV-21 → `e7ab6e11` hook 兜底 → `6a55a482` #165 DEV-30。**合计 90 文件 +7218/−2019**。无未集成的已审分支；PR #162/#164/#165 按「留证不 merge」口径开放（squash 已入 dev，树一致）。

## 三、生产面现状

- **relay 活体**：/health `ok`（relay/console005 = test.35，consoleLegacy = test.35-nova），org 锚重建、云桥 23 台设备回连；embedded-relay.log 持续有活跃事件（dead-sweep/orphan-adopt 正常工作）。
- **sqlite 降级态仍在**：`better-sqlite3 不可用（NODE_MODULE_VERSION 115↔127）` 今日仍在触发（读面自动降级 json，非阻断）。**治本=换装重出包**：#158 已把 CI 对齐 node 22 + 三重 ABI 回归闸，test.35 出包即消——发版流程（/release）交用户。
- app 装机指纹 version-sentinel 仍报 test.34-nova（换装未发生），与 relay test.35 并存属预期中间态。

## 四、真机待验清单（L3/L4，需用户装机）

1. **装机回归轮 test.35+**（台账 §六 明示的关键下一步）：R 系已修批全量回归——空闲跳序 R1、图钉 R3、六芒星 R6、hook 误判死 R11、板面新鲜度 R12、半连接 R13；R14 手机通知按钮需真机埋点回数（<300ms 目标）。
2. **UI 双主题实看**（#163+#165）：布局不协调治理、字号/密度档缩放（87 处直值收敛后首次随档）、N1 返回钮复原；审查席已 L2 亲看 52 张证据图，用户实看收尾。
3. DL-P2-6 派发队列装机回归；boardrecon 通电拍板（DL-P1-4）；swap-nova 真机换装演练（CI 绿，真机未演）；patrol 升级通道 osascript 实弹（DL-P1-5）；PM 保活席静置 60s 零跳序（R1 收口条件）；P2-9 真机 1x/2x 抽验。

## 五、缺陷台账（docs/night-audit/defect-ledger.md）

**38 条**：主台账 24（P0×3 / P1×9 / P2×6 / P3×4）+ artifacts 补录 14。Stage 1 立账时未闭环 27；**本夜处置映射**：

- **P0 全 3 条有落笔**：DL-P0-1 根修+复活（`bad51580`）；DL-P0-2 根修（`da776cd3`）；DL-P0-3 检测+外发已修（批 A patrol-escalate + patrol-standalone 哨），PM 席保活留装机观察。
- **P1 8/9 落地**（DL-P1-2 治标入 CI、治本=出包；DL-P1-8 残件在 DEV-31 在途；DL-P1-3 验收单机制未动——见 §六）。
- **P2 5/6 + 1 备案**（DL-P2-4 越权收割备案；DL-P2-5 机器闸族已落、存量面留）。

**反复反馈未闭环专项（R1-R15，用户点名）**：8 个主题复发 ≥3 次。本夜动到根的：R1 空闲跳序（#164 五写手收编 + #165 SESSION_MERGE 剥键——写手注册面单点化，正是台账指出的共性病灶）、R5 引擎接入（#164 冒烟 + DEV-31 清尾中）、R10 PM 断档（检测+触达两跳都补了件，装机验）、R15 装机后服务未起（DEV-18 根修+换装安全化）。**R2 消息导航条/R7 连接页连续剧等以「已修待回归」居多——不装机回归就永远不知道修没修好**（feedback-ledger 18 行烂尾教训，台账原话）。

## 六、未决与拍板项

**在途**：DEV-31（fixer-3，预计 08:10-08:40 收口；巡检规则保留至 09:55 自动到期，闭环流水照常走审查→收割）。

**留用户拍板**：
1. **DEV-24（S3 终审回归）去留**：判据已编入巡检指令（DEV-31 闭环早于 09:00Z 自动提升，含 P3-3 disk-watchdog TMPDIR 前置小修）；不满足则人工定。
2. **sqlite 治本换装**：test.35 出包（CI 已 node 22 对齐）→ 走 /release。
3. relay-sentinel 复活哨安装（`bad51580` 注明拍板项）；disk-watchdog launchd 常驻部署（plist 已备未加载）。
4. bundle 产物债（DEV-24 注记：出包批先 build 刷新 + check-bundle-sync）；leader-harvest A-10 生产 bin 生化；台账 A-5/A-11 决策项。
5. DL-P1-3 验收单机制（23 张 pending 仅 1 回流）未立案——建议下批。

**P3 备案池**（不阻塞）：DEV-21 P3×2（chain-audit 死锚 / swap-nova 文案）；DEV-30 观感三项（l02 徽章 / l04 内缩 / s0 层级+深色下拉待查）+ N2/N3；P2-7 chip 专项、P3-1 密度半项；24 处有意保留直值与 17px 显示级归档；test-updated-at-guard 注册 CI 矩阵（65→66 同抬锚）；预存红基线 22 项（非本批引入，基线复跑逐条一致）。

---
*报告落盘 docs/night-audit/night-report-2026-11-28.md（未提交，入树与否随用户）；证据链：DEV-17 夜巡串 + 各单回执 + ui-ledger/defect-ledger。*
