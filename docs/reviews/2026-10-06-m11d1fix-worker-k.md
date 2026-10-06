# worker-K 回单：M11-D1FIX acceptances checkpoint 双域互踩（分键）

> 2026-10-06。来源=J 的 M11-H1 发现 D1（a6e7f9f 套件轴④实证）。作者修本人缺陷（D1 observeAcceptanceDir + F1 顶部版口径差），按裁定分键不统一口径。worker 未 commit。

## 一、diff 摘要（三件，+44/−9）

| 文件 | 内容 |
|---|---|
| `src/storage/import-session-task.ts`（+23/−2） | ①新增导出常量 `ACC_DIR_CP_SUFFIX = "#tasks-view"` + 定义处完整备案：病灶（acceptances 目录双导入器共用、观测口径各异——本件排除 \*.results.json 只看 sheet 本体 / acceptance 域含 results 四件套计数）、同 path 互写互失效后果、**不统一口径三点理由**（超集口径漏扫 vs 多余重放的权衡 / 分键零语义变化 / 统一须 per-file 异常域分段抽象工程量大，援引 import-util.ts 头注豁免备案）、一次性成本（新键首判失效→段 2 重放一次，幂等无损）②头注条目 2 加分键口径一行（checkpoint path=源路径+域视图后缀，指引到常量处）③checkpoint **读**（:481）与**写**（:612）两处 key 一致改 `accCpKey = accDir + ACC_DIR_CP_SUFFIX`；**loss source_path 与 rescanned 保持目录原样**（账标识与返回值语义，非 checkpoint key——:472/:554/:569/:605-607 零改动）④observeAcceptanceDir 排除口径**不变**（原判定语义保留） |
| `scripts/test-import-session-task.ts`（+12） | D 段后插 **D2 段**（accDir 失效重放，4 断言）：touch sheet 本体 bump mtime→`skipped=false && eventsProcessed=0`（分键后 events cp 独立零重放）→task 域重灌行数不增→`review_required=1 && submitted` 保持（失效响应语义分键不改变）→**再跑一轮 `skipped=true` 快进**（#tasks-view 新键稳态，互踩消除的直接证词）。53→**57** 断言 |
| `scripts/test-m1-foundation.ts`（+7/−18 中 11 行净改） | 轴④ D1 断言翻转（详见「二」——实现方式与任务书字面有一处出入，须 Leader 核）+注释块同步（「真缺陷本件零触碰」→「已修复分键」口径）。49/49 |

## 二、必须请 Leader 核的一处：d1Touched 断言实现缺陷修正

任务书拍板「`d1Touched === 3` 翻转为 `0`」。**按字面实现必假红**：J 原实现 `lossWithTs(portR).filter(source_path 含 tasksDir/accDir).length` 数的是**存量条数**——分键修复后段 2 不再清重落，首轮落的 3 条坏行账**持久在库**，条数恒 3，翻不成 0（首轮实测即撞：表快照断言已绿=import_loss 逐字节不变，零重写其实已达成，唯条数仍在）。

J 注释自述「3/3 条**位移**」——正解是**差集**：`d1After.filter(s => !lossTsBefore4.includes(s)).length`（lossWithTs 串含 created_at，清重落即刷新=串变=位移）。修复前每次重启 3 条全位移→3 ✓（J 实测锁现象成立，系「全量位移」与「全量条数」碰巧等价）；修复后 3 条串全等→**0** ✓。另加 `d1After.length > 0` 护栏（账若意外消失，差集 0 不得假绿——「N 条全等」才是重启幂等的真证词）。断言文案同步为「重启幂等恢复：双域账 created_at 零位移（N 条全等）」。

## 三、分键生效自证

- **重点两套**（env 五清）：`Import session-task: 57/57 passed`（53+4）、`M1 foundation: 49/49 passed`。
- **全套 15 套零退**（env 五清）：storage-driver 21 / storage-migrator 18 / storage-schema 67 / storage-checkpoint 34 / import-org 39 / import-org-parity 55 / import-dispatch-lesson 40 / import-notification 38 / import-session-task 57 / import-acceptance 48 / import-artifact 47 / duty-boundary 32 / read-mode 43 / m1-import-parity 21 / m1-foundation 49——**全绿**。import-acceptance 48/48 零改动过=acceptance 域原 path 键面无损。
- **tsc**：`npx tsc --noEmit` 全项目 0 错（末次 Edit 后）。
- **控制字节**：perl 口径 `perl -ne 'print if /\x00/'` 扫三件零 NUL（J 备案 BSD grep 假阳性教训遵行）。

## 四、改动面申报（git status 实况）

- **我的**：`M relay/src/storage/import-session-task.ts`、`M relay/scripts/test-import-session-task.ts`、`M relay/scripts/test-m1-foundation.ts`（Leader 授权触碰）。
- **他人在途**：本单开工时工作区仅余 G 的 G1 已提交件（read-mode 43、m1-import-parity 21 回归绿佐证零干扰）；三件独占 ✓。

m11d1fix done: files 3 (+44/−9), asserts 57/57 session-task + 49/49 foundation, regress 15套全绿, tsc 0, NUL 0, 未 commit
