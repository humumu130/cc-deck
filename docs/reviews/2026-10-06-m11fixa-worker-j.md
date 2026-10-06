# worker-J 回单：任务 M11-FIX-A / 盲评修复批（D1 P1 + E1/F1 P2 + 两备案注释）

## 交付物（零新增文件，全为既有件修复）

| 件 | 缺陷 | 修法落点 | diff |
|---|---|---|---|
| `src/storage/import-session-task.ts`（D1，作者 K） | P1-1 多批重放 loss 误删 | **DELETE 移出 flushBatch**：段 1 开始前 `if (fromLine === 0)` 一次性执行（:489 附近，原 flushBatch 内每批执行的 :489-491 删除）；带 D2 清域单次铁律式理由注释（批 2 删批 1 已提交账+splice 后永不重落→只剩末批/零批账存活；autocommit 清后批失败重试 fromLine 仍 0→重清重放自愈） | +19/-3（含两处注释） |
| 同上 | P3-1 备案修 | :341 注释改实况：「仅推进 status/updated_at/runtime_state_json 三列……非『宽松合并』」（拍板选注释改实况分支，未补合并功能——title 无 DDL 列、model 首帧 CREATED 制是 D1 既有语义非缺陷） | 含上行 |
| 同上 | 头注同步 | 主入口 doc comment「首批事务内清 events 源旧 loss」→「段 1 开始前一次性清……不进批循环」 | 含上行 |
| `src/storage/import-notification.ts`（E1，作者 G） | P2-1 重复 client_id UNIQUE 炸域 | clientStates 数组→**Map 按 client_id 去重后写赢**（duplicate-key 账，excerpt 带 key+client_id）；:160 落库点物化 `[...values()]`，持久层循环零动 | +12/-3 |
| `src/storage/import-acceptance.ts`（F1，作者 K） | P2-2 案 A | sheet 循环加 `sheetIdSeen` Map：**内容 id 重复→首文件赢**（readdir 序确定性）+duplicate-id 账 excerpt 带两文件名（basename）；后到文件连同 items 整单拒入；判重置于归因**之前**（整单已拒不叠 missing-attribution 噪音账） | +31/-4（含头注） |
| 同上 | P2-2 案 B | results 展开加 `seenResults` Set：**同 history 同 (h,i) 二见→duplicate-key 账+保首**；跨 history 条目不折叠语义不变（id 含 h 序天然不同键） | 含上行 |
| 同上 | P3-4 头注 | :32「sha12 私有副本（G1 前统一定夺）」→「消费 import-util 共享件（UTIL/UTIL2 已回迁，无私有副本）」+ 映射口径两 bullet 补两案去重注记 | 含上行 |
| `scripts/test-import-session-task.ts` | P1-1 回归锁 | **段 F 多批重放**：batchSize=4×20 行 5 批×坏行 3/9/15 分属批 1/3/4；断言①首跑三账全在（修复前批间互删=0 笔）②失效重放后同位三账仍在③快进零重复 | +52 |
| `scripts/test-import-notification.ts` | P2-1 回归锁 | **段 6 重复 client_id**：同条目 phone×2+无重复条目对照；断言不炸域/去重归一行/末条（较新态）生效/dup 账 line 1 恰 1 条/FK 0 | +26 |
| `scripts/test-import-acceptance.ts` | P2-2 回归锁 | **段 F 双 PK 案**：案 A 两文件同 doc.id（"1111"<"2222" readdir 序首文件赢）/案 B 同 history 两条 {i:0}；断言行数 4/7/7、保首值、dup-id excerpt 双文件名、dup-key 恰 1、快进幂等 | +48 |

## 测试断言数（两轮 env 五清逐字节一致）

- import-session-task **53/53**（原 46+7）｜ import-notification **38/38**（原 33+5）｜ import-acceptance **48/48**（原 38+10）——我的三件 **+22**。
- 三件修复均为**修复前必红**的真回归锁：段 F 首跑断言在旧代码下=0 笔账（本 fixture 坏行均不在末批）；E1/F1 段在旧代码下=UNIQUE 抛异常。

## 回归矩阵（env 五清全套）

storage-driver 21 ✓ / storage-migrator **18 ✓**（12 套连跑首轮瞬态崩=Node 栈尾，单跑复绿，判环境瞬态非代码）/ storage-schema 67 ✓ / storage-checkpoint 34 ✓ / import-org 39 ✓ / import-org-parity 55 ✓ / **import-dispatch-lesson 37/40=K 在途件**（工作区实况见下）/ import-notification 38 ✓ / import-session-task 53 ✓ / import-acceptance 48 ✓ / import-artifact 47 ✓ / duty-boundary 32 ✓。**tsc 0 错**（末次 Edit 之后跑）。

## 工作区实况申报（重要）

本轮开工时工作区**并非干净**（我此前一次 `git status -- relay/` pathspec 在 relay/ 目录内匹配为空，误读为干净，特此更正申报）：K 的 M11 下一轮在途件已在工作区未提交——`M src/storage/import-dispatch-lesson.ts`（+28，修 REVIEW3 P2-1 派生段 id 撞键）、`M scripts/test-import-dispatch-lesson.ts`（+54，含 P2-1 复现新断言 4 条，其中 3 条暂红=其修复未完）、`M src/storage/import-util.ts`（+10）。**零触碰**，其 37/40 不计入我的回归责任面；我六件 diff 逐 hunk 核查纯归属本任务（上方 diff 摘要与 `git diff` 实况一致），与 K 文件零交集，Leader 可整文件 `git add` 拆笔。

## 备案（口径登记，不动作）

1. **E1 去重方向拍板解读**：H 原文修法菜单为「后写赢或首条赢」，任务书拍板「去重后写赢」——按「后写赢」落刀（client_states 是当前态投影，后写=该设备较新 read/dismiss 态，与实体域「同源重复保首」不同向，注释已说明）。若 Leader 本意首条赢，翻法=Map 判重提前+不覆盖一行，断言倒置，改动 2 行。
2. **F1 案 A 判重位置**：置于归因之前（整单拒入不再叠 missing-attribution 账）；H 原文未指定，取「一单病一账」最小噪音口径。
3. **Leader 三条裁定已入认知**：C2FIX 不 bump 维持（G1 已上线 dd882db，「上线前出现持久导入库则作废」窗口已闭合，零存量前提按坐实维持）；D1 P3-2 中断续跑不触发段 2 重灌=设计语义不改；F1 P3-3 配对键不对称备案不改。
4. **storage-migrator 首轮瞬态崩**：连跑循环内崩（栈尾 Node 版本行）、单跑 18/18 复绿，未复现第二次；若 Leader 复验遇同象建议单跑复核。

## 纪律自证

env 五清（CCR_TOKEN/CCR_PORT/CCR_DATA_DIR/CCR_ORG_DIR）✓；package.json 零碰（测试脚本已注册，只扩 fixture）✓；他人在途件零碰（K 三件、G1 已提交件）✓；worker 不 commit ✓；生产零触达 ✓；tsc 末次 Edit 后跑 ✓。

m11fixa done: files 6(3源+3测), asserts 53/38/48 两轮一致(+22), 回归 12 套全绿(K 在途 37/40 非我面), tsc 0, 未 commit
