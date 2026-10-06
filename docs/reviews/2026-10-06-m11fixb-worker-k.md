# worker-K 回单：M11-FIX-B D2 派生段 id 碰撞修复+回迁收口

> 2026-10-06。修我自己 REVIEW3 的发现（P2-1 + P3-1/5/9 + P3-6 测试面）。worker 未 commit。

## 一、diff 摘要（三件，+70/−31）

| 文件 | 内容 |
|---|---|
| `src/storage/import-dispatch-lesson.ts`（+28/−12） | ①`applyDispatchLine` 签名加 `dispatchIds: Set<string>` 预检集参数；重投分支派生 `segId` 后存在性检查——撞→`duplicate-id` 账拒行 return（excerpt 带 root id，不 INSERT 不炸批，segs 不更新，后续同 root 行仍按当前段终态处理）；开段 1 INSERT 后 `dispatchIds.add`、重投 INSERT 后同步 add ②主入口段 1 预载区加 `dispatchIds`（**replay 态从空集自建**——域将被首批 DELETE，预载旧 id 会残留在内存集、重放中派生 id 撞「已删行」误报拒行；续跑态从表预载，与 restoreSegs 同源同构）③`:467` rescanned 条件 push：`if (replay \|\| dispatchProcessed > 0)`——跑完态+他源失效零处理不虚报 ④observeNdjson 删私有副本（statSync+readFileSync 对），改 `statThenRead` 消费（领域注释保留一行指引；异常域等价：双方裸调 ✓，fs import 保留——observeBoardsDir 仍用） |
| `src/storage/import-util.ts`（仅头注 +10/−4） | 迁移备案段收窄为如实口径：五件消费（UTIL 迁四+UTIL2 回迁 org）+D2 于本单入面；领域特化豁免三类列明（session-task observeTasksDir 只 stat 不读内容 / acceptance observeAcceptanceDir stat-read 异常域分段骨架单层 try 无法表达 / artifact observeInline 内容指纹替代 mtime）——修正 UTIL 单「六件全数消费」与回单矩阵的自相矛盾 |
| `scripts/test-import-dispatch-lesson.ts`（+63/−19） | fixture 加 P2-1 四行复现（行 12-15）；断言 36→**40**（+4：duplicate-id 账对号 lineNo=15+excerpt 带 root id、行 12 x#r2 独立段原样 attempt=1、行 13/14 x 收敛 done 且重投被拒后段状态不推进、r7 boards 失效轮 rescanned 单源）；各轮数字联动更新（dispatch 8→10 行、S4 6 账→7 账、r3 offset 拨 16/续 5 行、r4/r5 counts 11、重放同数 6→7） |

## 二、两个实现级关键点（评审关注位）

- **预检集 replay 分叉**：`dispatchIds = replay ? new Set() : 从表预载`。内存 Set 不随首批 `DELETE FROM dispatch` 缩减，若 replay 预载旧库 id，重放中派生 segId 撞「已删行」会误拒——重放语义是域清后从零确定性重建，预检集必须随之从零自建。
- **fixture 布局三约束**（调试三轮换布局所得，最终形态）：①终态行不得落续跑窗口——行序状态机语义「重遇终态行=再现行=重投推进」，第一版布局把 watchdog（done）推过快进线，续跑给它开了 `#r2` 段（诊断脚本抓到 `d-watchdog#r2[a2=done]`）；②复现④（重现行形态）即便入窗也安全——同物理行重遇同 lineNo，appendLossOnce 三元守卫吸收；③定稿：边角四行前移（行 8-11 全非终态）、复现占 12-15、watchdog 殿后 16、r3 offset 拨 16——窗口 17-21 纯净（脏三行重遇守卫不叠+追加两行开 d-ok#r2），三语义（批间中断/守卫不叠/恢复段状态）同轮全覆盖。

## 三、自证

- **tsc**：`npx tsc --noEmit` 全项目 0 错（末次 Edit 后）。
- **重点两套**（env 五清连跑）：
  ```
  Import dispatch-lesson: 40/40 passed（36+4 新断言）
  duty boundary: 32/32 passed
  ```
- **全套回归零退**（env 五清）：storage-driver 21 / storage-migrator 18 / storage-schema 67 / storage-checkpoint 34 / import-org 39 / import-org-parity 55 / import-session-task 53 / import-notification 38 / import-acceptance 48 / import-artifact 47 / import-dispatch-lesson 40 / duty-boundary 32——**12 套全绿**。
- 套件断言数较 REVIEW3 基线涨的四件（session-task/notification/acceptance/artifact）= J 的 FIX-A（35dfa5d）与 H 的 FIX-C（418d69d）已提交修复批所涨，与本单改动面零交叠（git log 核实）。

## 四、备案

1. **P2-1 修法对齐拍板**：开段前存在性检查（无 INSERT catch UNIQUE 兜底）；撞名走五词表既有 `duplicate-id` 账拒行。防御性路径性质不变（写侧重投=randomUUID 独立成行，现实触发概率极低），但范式「坏行 loss 不阻断」闭环补齐。
2. **excerpt 取证口径**：duplicate-id 账 excerpt 带**涉事行 root id**（`"id":"x"`）；派生 id（`x#r2`）是内存变量不在行原文，不虚造进 excerpt。
3. **rescanned 语义收口后各轮实测**：r1 首轮重放 2 源 / r3 续跑处理>0 单源 / r4 重放 2 源 / r7 boards 失效+dispatch 跑完态**单源**（原虚报点，断言在件）。
4. **任务书笔误备案**：「D1 observeAcceptanceDir」实为 acceptance 件（F1，import-acceptance.ts）的函数；头注按实际归属写「acceptance observeAcceptanceDir」，语义不变。
5. **他人在途零触碰**：`M package.json`+`?? scripts/test-m1-import-parity.ts` = G 的 G1 线注册件（diff 核实），未碰。

m11fixb done: files 3 (+70/−31), asserts 40/40 dispatch-lesson + 32/32 duty-boundary, regress 12套全绿, tsc 0错, 未 commit
