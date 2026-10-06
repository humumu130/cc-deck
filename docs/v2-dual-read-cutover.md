# V2 双读截止计划（M11-H2，Leader 锚单）

> 状态：**v1.0（2026-10-06 收口）**——§2 地基证据已回填（H1=`a6e7f9f`、D1FIX=`9249242`），M1-1 收口件。后续修订走提交历史，§4 闸门判据的变更须用户知悉。
> 依据：v2-dev-plan.md M11-H2 行；v2-system-design.md :200（新 durable state 统一经 StoragePort）/:224（D10 单写者命令面）；read-mode.ts 头注（G1 dd882db 落库口径）。
> 本单性质：**只写计划与备案，不执行任何切换**。计划表原文：「写明发布配置截止版本=M1-2 结束，并完成迁移文档备案；保留冷备份；不在本单执行切换」。

## 1. 现状坐标（M1-1 收口时点）

- **三档读模式已落地**（read-mode.ts，`CCR_STORAGE_READ_MODE`）：`json`（缺省，SQLite 零参与库文件不建）/ `sqlite`（表投影直读，ensureStore 惰性单例读前灌库）/ `shadow`（返回值与 json 档逐字节一致，旁路对比差异落 `<dataDir>/shadow-diff.ndjson` 整文件重写幂等口径，2000ms/域节流+单域 200 行限额）。无效值 boot fail-fast。
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
| **M1-2 施工期** | 渐进切 StoragePort（M12-1..7 单写者面） | json 档不变 | 真相源→双源过渡（导入器跟随重扫） | M12 系列 |
| **M1-2 收口（截止点）** | 全部经 StoragePort（D10 命令面） | **评估翻转默认档**（见 §4 闸门） | **只读快照**（M12-8 验收项「验收旧 JSON 只读截止已切换」） | M12-8 |
| **M1-3** | StoragePort | 三端读 SQLite 投影（M13-3/4） | 冷档案（回退唯一来源） | M13 系列 |

**截止版本声明**：`CCR_STORAGE_READ_MODE` 缺省值保持 `json` 直到 **M1-2 收口 commit**；翻转缺省为 `sqlite` 的动作不早于 M12-8 验收通过、不晚于 M13-8 发布闸门前，由用户拍板执行（生产变更铁律）。翻转前 shadow 档为推荐观察档。

## 4. 切换闸门（cutover checklist，全绿才呈用户拍板）

1. **shadow 长清零**：生产同构负载下 `shadow-diff.ndjson` 连续 ≥7 天仅含已备案有损映射面行（无 missing/count/value 新增类）。
2. **parity 全绿**：G2 六域 parity+H1 七轴在切换前 commit 上重跑全绿。
3. **写者收口**：M12-8 真链路验收通过（task.create→dispatch→执行→回执→验收→lesson 全链 SQLite 账实相符；旧 JSON 零新写）。
4. **冷备份就位**（§5）。
5. **回退演练**：演练环境执行一次 §6 回退路径并记录耗时与数据零丢失证明。
6. **性能不回退**：sqlite 档读路径在真实数据量级（当前生产 events 规模）下不慢于 json 档基线（bench 口径：四读函数×1000 次取样）。

## 5. 冷备份口径

- 时点：M12-8 验收通过后、默认档翻转前，一次性全量快照 `<orgDir>` 与 `<dataDir>`（含 events.ndjson/notifications/acceptances/boards/confirms/deliverables）。
- 形态：tar 归档+sha256 清单，存生产数据目录旁路（不进 git）；归档命名 `pre-cutover-<date>-<git-sha>.tar.gz`。
- 保留期：默认档翻转后 ≥30 天或至 M13-8 发布验收回填完成（以晚者为准）；删除需用户发话。

## 6. 回退路径（翻转后任意时点可用）

1. 停 relay → 2. `CCR_STORAGE_READ_MODE=json`（或 unset）→ 3. 起 relay：读路径回旧 JSON 直读（读面切换即时生效，无迁移依赖）→ 4. 若 JSON 已停写造成缺口：从冷备份恢复或经导入器反向对账（shadow-diff.ndjson 作缺口清单）补写。**注意**：写者面回退（StoragePort→旧 JSON 写）不在本计划内——M1-2 写者切换单各自带失败回滚目标（v2-dev-plan §6 自查闸），写者回退以单级回滚为口径，不做跨阶段整体回写。

## 7. 备案：本单不做的事

- 不翻转任何默认值；不接生产 boot 挂钩；不动 M12/M13 系列靶子；不建冷备份（时点在 M12-8 后）；不删除任何旧 JSON。本文件是计划与判据的唯一权威，切换执行单（M13 前的运维单）以本文件 §4 为验收基线。
