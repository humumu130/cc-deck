# M13-REV 验收归档（Leader 核验，M13-2 delta 投影独立盲评——双口径纪律实证）

- 任务：M13-REV d438243 盲评（#120）
- worker：J（7b5ffab6）｜回单：/tmp/worker-j-m13rev.md（16:47 SESSION_DONE）
- 本单零代码，提交=本归档件。

## 亲验记录（P1 证据链四锚点全中）

1. event-bus.ts:64-72 emitTransient `seq:0` 不缓冲不落盘不补发 ✓（瞬态语义实证）；
2. session-manager.ts:5038-5039 头注钦定板域「COMMAND_PROJECT_DETAIL 按需拉取后经 BOARD_UPDATED 增量维护」✓（板域无 SNAPSHOT 兜底）；
3. test-delta-projection.ts:81 `prev ?? {gid, entries: []}` 空板起底 ✓；
4. 同件 :215 `assert(primed, "delta 帧前必有覆盖式起底帧")` ✓——参考实现函数体与 S3 链内锁自相矛盾实证。

**P1 成立**：瞬态帧无序号（端无法检测丢帧）+板域无快照兜底+delta 丢帧后差分应用在错误基线静默持续（旧覆盖式帧自愈、delta 不自愈）——三端照抄参考实现即踩雷。

## 裁定与处置（本验收链闭环动作）

1. **修法 A 采纳**（协议零改动，端上锚定纪律化）：delta 帧仅可在锚定后（该 gid 已消费过覆盖式帧）应用；未锚定丢弃+COMMAND_PROJECT_DETAIL 重拉重锚；基线缺失空板起底 merge=禁止路径。修法 B（broadcast_seq）备案不采用（A 已闭合+改动大）。
2. **三投递即时完成**（动工窗口内防偏）：H/L 各收 M13-3ADD/M13-4ADD 追加纪律（并入在途单断言）；G 收 M13-2FIX 回炉单（参考实现 :81 改跳帧+types.ts 规格注释固化+补锁+顺带 P3-1 死变量）。
3. P3 七项记档：P3-2 loadBoard 空板兜底（等价投影）、P3-4 entity_refs 不含 lessons.removes（append-only 下无实破，注释显式化并入 FIX 单）、P3-5 广播缓存无淘汰、P3-6 帧双载冗余（M13-3/4 就位后另裁）等——均不阻塞。

## 价值定性

**双口径盲评纪律的实证胜利**：G 自证 49/49+51/51+tsc 0 全绿、Leader 亲验同绿——但测试锁跑在自构造的帧序列上（primed 纪律隐含于测试框架），三端真实环境无 primed 保证。盲评的独立视角（不读交付方自证）恰好暴露「测试框架隐含假设≠协议完备性」的缝隙。**教训入库：协议类单的测试锁须含「环境无序到达」场景（未锚定/乱序/重复三态），M13-2FIX 补锁即此。**

## 结论

**通过。#120 completed。** J 盲评 P1×1+P3×7+无恙面九项背书，复现 49/49×2+51/51+tsc 0。回炉单 M13-2FIX（G 在途）+两追加纪律（H/L 在途）已发。
