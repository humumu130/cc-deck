# 审查单 DFR1·dispatchfix 治本复审（机制正确+实证·2 路之一·只读）

> 被审：fix/dispatchfix（worktree /private/tmp/cc-deck-w-dispatchfix，commit 1 笔）+回执 w-dispatchfix.md（七验收点自报全落+48 断言）。只读，回执 w-dispatchfix-r1.md。

## 用户口径
- 用户军令级：三现根治（queued 假忙/池空窗死等/活性假态）——面板所见即真实

## 审查重点
1. queued 语义分叉真态：active_workers=0→「池空窗待拉起」/ >0→「排队中」——读码验分叉判据的真活性源（不是又一层假态）
2. 池空窗自动 headless 拉起：拉起命令/失败升级 /api  notify/并发闸遵守——拉起的 worker 身份/心跳/回收生命周期
3. 活性穿透：板面活性列数据源（jsonl mtime/进程）5min 停摆判定——读真态源的失效面
4. slug 去重闸+锁 GC：同 slug 再派拒绝/幂等；锁 GC 触发条件（单终态/超时）
5. 48 断言覆盖上述面盲区+复跑（test-dispatchfix 相关+org 现有测试零回归）
6. 拉起冒烟真实性（真起 worker 消费后即停——非纯 mock）
7. 尾行「结果：过/挡」→ w-dispatchfix-r1.md
