# V2 双读截止计划（M11-H2，Leader 锚单）

> 状态：**v1.1（2026-10-06 默认档已翻转）**——用户拍板（「开干吧」）执行单 SQLITE-FLIP 落地：`CCR_STORAGE_READ_MODE` 缺省值 `json`→`sqlite`（read-mode.ts），回滚=显式 `CCR_STORAGE_READ_MODE=json` 钉回旧档。v1.0（2026-10-06 收口）——§2 地基证据已回填（H1=`a6e7f9f`、D1FIX=`9249242`），M1-1 收口件。后续修订走提交历史，§4 闸门判据的变更须用户知悉。
> 依据：v2-dev-plan.md M11-H2 行；v2-system-design.md :200（新 durable state 统一经 StoragePort）/:224（D10 单写者命令面）；read-mode.ts 头注（G1 dd882db 落库口径）。
> 本单性质：**只写计划与备案，不执行任何切换**。计划表原文：「写明发布配置截止版本=M1-2 结束，并完成迁移文档备案；保留冷备份；不在本单执行切换」。

## 1. 现状坐标（M1-1 收口时点）

- **三档读模式已落地**（read-mode.ts，`CCR_STORAGE_READ_MODE`）：`sqlite`（**缺省，2026-10-06 翻转**，表投影直读，ensureStore 惰性单例读前灌库）/ `json`（回滚档：SQLite 零参与库文件不建，显式 env 钉入）/ `shadow`（返回值与 json 档逐字节一致，旁路对比差异落 `<dataDir>/shadow-diff.ndjson` 整文件重写幂等口径，2000ms/域节流+单域 200 行限额）。无效值 boot fail-fast。
- **接线面**：projects.ts 三读函数（readProjectsFile/readConfirms/listLessons）+org.ts readDispatchLog（dispatch 域唯一读原点）。写函数零触碰。
- **生产口径**：`CCR_STORAGE_READ_MODE` **零生产消费**（grep 实证：仅 read-mode.ts 源+三测试件引用）——生产 relay 跑 json 档（等价于 v1 读路径原样），SQLite 侧只在测试与 shadow 验证期激活。这是有意保守：M1-1 不改任何生产读行为。
- **等价性证据链**：G2 六域 parity（group/task/dispatch/notification/acceptance/artifact 数量+键集+抽样三级+板语义回归锁）21 断言绿（f388b38）；已知有损映射面（trust_light/parked_at/archived_at/dispatch.target 投影缺口）在 read-mode.ts 头注备案，shadow 档如实报告。

## 2. 地基证据（H1/D1FIX 落库回填，2026-10-06）

- [x] **H1 全生命周期故障注入套件 commit=`a6e7f9f`**（`relay/scripts/test-m1-foundation.ts`，七轴 49 断言，两轮 env 五清逐字节一致）：建库冷启动（17 表+六域行数金值+checkpoint 全写）/迁移幂等（applied=[]+sqlite_master 全等）/断点续跑/重启幂等/断电原子性（a/b 两处）/loss 全生命周期（三路径元组集全等）/六域投影重建（组列表/派单流/任务板语义锁/通知/验收单/输出物+全库零悬空 FK）。
- [x] **断电原子性覆盖面（两处，FaultPort 只 wrap port 实例注入，生产源件零触碰）**：① events 批事务——批 3 首行引爆→整批回滚无半批态+checkpoint 停批 2 尾（offset=8/12）→close 模拟进程死亡→重开 ensureStore 续跑；② acceptance 域清重灌——改源后第 2 张 sheet INSERT 引爆→DELETE 域清+半程 INSERT+loss 清+checkpoint 写**全在同一回滚事务**（旧快照 2 单 3 项 1 判定完好、账 created_at 未刷、旧五元组原样）→恢复后重灌采新源。
- [x] **续跑终态与全量导入逐字节等价断言**：15 表全行 `SELECT * ORDER BY rowid` 快照=金值（轴③，fixture 副本 preserveTimestamps:true——task 行 ts 列=源文件 mtime 的前提）。
- [x] **附：D1 发现-修复闭环（`9249242`）**——H1 套件发现 accDir checkpoint 双域互踩（session-task 排除 \*.results.json vs acceptance 域含四件套，同 path 五元组互失效→每轮 ensureStore 恒双域重写=重启幂等被破坏+loss 账 created_at 失真）。裁定分键修复（`#tasks-view` 域视图后缀，不统一口径三点理由备案于常量定义处）。修复后套件断言翻转回绿：d1Touched 差集口径零位移+`d1After.length>0` 护栏（57/57+49/49）。此缺陷链正是闸门判据 1 要防的「暗重写面」——重启白扫白写会让 shadow 验证期数据失真，已在地基期消除。

## 3. 版本化演进线（谁在哪个阶段动什么）

| 阶段 | 写者 | 读者 | 旧 JSON 地位 | 触发单 |
|---|---|---|---|---|
| **M1-1（今，收口中）** | 全旧路径（JSON 直写） | json 档（=旧路径原样） | 真相源 | G1/G2/H1/H2 |
| **M1-2 施工期** | 渐进收命令面单写入口（M12-1..7：orgCommand→orgAction 单漏斗，D10） | json 档不变 | 真相源→双源过渡（导入器跟随重扫） | M12 系列 |
| **M1-2 收口（截止点，已完成）** | 命令面单漏斗收口（底层仍 JSON 直写——StoragePort 写切换属 M1-3；2026-10-06 M12-8 验收校准措辞） | **评估翻转默认档**（见 §4 闸门） | 真相源（写侧）；读侧 SQLite 账实相符已由 M12-8 真链路证实（三域投影+shadow 对账+导入幂等） | M12-8 |
| **M1-3** | **写者切换：StoragePort 写面落地**（命令面漏斗底层由 JSON 直写切 StoragePort） | 三端读 SQLite 投影（M13-3/4） | 冷档案（回退唯一来源；写切换完成后达成「零新写」） | M13 系列 |

**截止版本声明**：`CCR_STORAGE_READ_MODE` 缺省值保持 `json` 直到 **M1-2 收口 commit**；翻转缺省为 `sqlite` 的动作不早于 M12-8 验收通过、不晚于 M13-8 发布闸门前，由用户拍板执行（生产变更铁律）。翻转前 shadow 档为推荐观察档。
**✅ 已翻转（2026-10-06，执行单 SQLITE-FLIP，用户拍板「开干吧」）**：前置=CUT-1 六闸全绿+第六闸读税双清（READMODE-FIX `#136` ensureStore portCache 陈旧账修 + STAT-SHORTCUT `#139` stat 短路/COUNT 下推，快进读税 30.1→7.2ms/次，且 fixture 病态勘误后生产真实读税远低于估计）。缺省=`sqlite`；测试锚段0 缺省断言+回滚锚（显式 json 仍解析 json）同批落；金标准自证（临时还原缺省=json ⇒ 缺省断言精确红 49/50，恢复 ⇒ 50/50）。

## 4. 切换闸门（cutover checklist，全绿才呈用户拍板）

1. **shadow 长清零**：生产同构负载下 `shadow-diff.ndjson` 连续 ≥7 天仅含已备案有损映射面行（无 missing/count/value 新增类）。
2. **parity 全绿**：G2 六域 parity+H1 七轴在切换前 commit 上重跑全绿。
3. **写者收口**：M12-8 真链路验收通过（task.create→dispatch→执行→回执→验收→lesson 全链 SQLite 账实相符——前半已证，`15172db`）；「旧 JSON 零新写」的完整达成=StoragePort 写切换（M1-3），翻转拍板前须补验。
4. **冷备份就位**（§5）。
5. **回退演练**：演练环境执行一次 §6 回退路径并记录耗时与数据零丢失证明。✅ **CUT-1（2026-10-06，`npm run rehearse:rollback`）**：mkdtemp 全链四域零丢失断言全过（group/confirm/lesson/dispatch 键集+抽样全等，含 decided 终态面）+§6 第 4 步缺口发现能力实证（shadow-diff 抓被删 confirm 单）；复跑 3 次稳定（worker）+Leader 亲跑复现 PASS。附发现：dispatch 投影 `target`+`session_id` 恒空串（既有备案 target 外新发现有损面；**微裁 2026-10-06**：记档为 M1-3 写切换批次已知待办——StoragePort 写侧接线时随补，不单独立项）。
6. **性能不回退**：sqlite 档读路径在真实数据量级（当前生产 events 规模）下不慢于 json 档基线（bench 口径：四读函数×1000 次取样）。✅ **终裁 A+B（2026-10-06 用户拍板「按建议」：收口放行+判据补绝对差无感阈值）**：m2 实况档（events 1.9 万行）四函数 16~41% 相对差，但**绝对差 3~25μs**（两域噪声 floor 级，无用户可感知影响）——判据修订为「绝对差不慢于 50μs/函数 或 相对差不超 20%（取宽者）」双通道；synth ×10 放大档 43~103%（绝对 0.03~0.8ms，行级编解码 vs 单次 parse 结构性差）为**放大器证据非实况判据**（生产数据量级才是本闸门口径）；翻转一次性 ensureStore 442/771ms 为冷启动一次性（可接受）。瓶颈定位与三选项分析见 CUT-1 归档（docs/reviews/2026-10-06-cut1-worker-k.md）。✅ **第六闸读税双清收口（2026-10-06，翻转前置条件闭环）**：READMODE-FIX `#136`（portCache 命中分支补灌账）+ STAT-SHORTCUT `#139`（statThenRead mtimeNs+size 短路 memo + 四导入器 skipped 分支 listLoss→COUNT 下推，420 倍热路径税拔除）——ensureStore 重复快进 30.1→7.2ms/次；剩余为七域 observe 目录扫描+逐域 query 架构性固定成本。勘误备案：30ms 基线的 fixture 为病态形态（8000 events 全坏行→loss 表 8001 行放大 listLoss 税），生产 events 合法流 loss≈0，真实读税远低于估计。

## 5. 冷备份口径

- 时点：M12-8 验收通过后、默认档翻转前，一次性全量快照 `<orgDir>` 与 `<dataDir>`（含 events.ndjson/notifications/acceptances/boards/confirms/deliverables）。
- 形态：tar 归档+sha256 清单，存生产数据目录旁路（不进 git）；归档命名 `pre-cutover-<date>-<git-sha>.tar.gz`。
- 保留期：默认档翻转后 ≥30 天或至 M13-8 发布验收回填完成（以晚者为准）；删除需用户发话。

## 6. 回退路径（翻转后任意时点可用）

1. 停 relay → 2. **`CCR_STORAGE_READ_MODE=json` 显式钉档**（⚠️ 2026-10-06 翻转后 **unset/不设 = sqlite 档**，unset 不再是回退手段——必须显式写 `json`）→ 3. 起 relay：读路径回旧 JSON 直读（读面切换即时生效，无迁移依赖）→ 4. 若 JSON 已停写造成缺口：从冷备份恢复或经导入器反向对账（shadow-diff.ndjson 作缺口清单）补写。**注意**：写者面回退（StoragePort→旧 JSON 写）不在本计划内——M1-2 写者切换单各自带失败回滚目标（v2-dev-plan §6 自查闸），写者回退以单级回滚为口径，不做跨阶段整体回写。

## 7. 备案：本单不做的事

- 不翻转任何默认值；不接生产 boot 挂钩；不动 M12/M13 系列靶子；不建冷备份（时点在 M12-8 后）；不删除任何旧 JSON。本文件是计划与判据的唯一权威，切换执行单（M13 前的运维单）以本文件 §4 为验收基线。
- **翻转后记（2026-10-06）**：上述「不翻转」为本单（M11-H2 计划单）性质声明；翻转已由后续执行单 **SQLITE-FLIP**（用户拍板）完成，见 §3 截止版本声明后翻转记录。生产 relay 的实际切换仍待部署单执行（冷备份先行），代码缺省已翻转。
